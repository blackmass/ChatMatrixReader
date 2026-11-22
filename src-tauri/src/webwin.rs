//! The web windows: a frameless window that shows a page of the web (a phone's page when asked). Its bar, the strips that resize it and the line that shows while it scrolls are drawn by the
//! control center it belongs to (center.js, webpane.js), which also puts the window in its place and in its order (center.rs); this file makes it and keeps it to the addresses it may go to. Opened by the
//! hub (app/web_host.js) when a plugin that may do it asks. What the experiments with it showed (windows + macOS) is kept here:
//!   * a small script runs in the page before the page's own scripts (top frame only: links that go to the user's browser, typing into a text box, how far the page has scrolled); what it tells
//!     goes to the program by trying to go to the address
//!     cmr-cmd://<command>, which is caught in on_navigation and never goes anywhere (the page cannot call the program: its address is not one the program trusts)
//!   * a web window never takes the keyboard of the game: the "no activate" style (Windows); on macOS a window that does not become the key window. So nothing can be typed into a page of it.
//!   * macOS: the CLASS of a window that holds a web view is never changed (the web view watches the window with key-value observing, a changed class makes the program abort
//!     when the web view leaves it); and nothing touches a window that is closing.
//!   * "above the game only" is two states (the game, or a window of ours, in front: the high level; another program in front: the normal level right above the game).
//!   * Windows: every web window is made in a folder of its own (webview-data/web/<plugin>/ when cookies are kept, webview-data/web/_private/ in private mode), not in the folder of the
//!     program's own windows (they must all be made with the same arguments).
//!   * every command is async: a web view made from a synchronous command (the main thread) never comes back on Windows (the WebView2 issue wry#583).
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde_json::{json, Value};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{hwnd_of, weblib, win};

static OPEN_ALLOW: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));       // where the user's browser may be sent to from the window
static ALLOW: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CLOSING: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
/// The windows the USER opened (the mini browser): any http or https address, not only the addresses a plugin was allowed. (A window a plugin opens is never in this list.)
static FREE: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
fn is_free(label: &str) -> bool { FREE.lock().map(|l| l.iter().any(|x| x == label)).unwrap_or(false) }
static PREV_FG: LazyLock<Mutex<HashMap<String, isize>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// What the plugin's log should tell about the windows (addresses that were refused): taken by web_events
static EVENTS: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
fn event(text: String) { if let Ok(mut e) = EVENTS.lock() { if e.len() < 60 { e.push(text); } } }

// Runs in EVERY frame (initialization_script_for_all_frames), not only in the page: a frame of the page (a video, an advertisement ...) gets the wheel, the zoom keys and the menu of the right
// button itself. What a window of a browser does with these is not wanted here: the wheel with ctrl (zoom) or shift (sideways) is a plain turn of the wheel; no zoom keys; no menu.
// (the keys that make the windows usable, ctrl / shift / alt, would otherwise stop the page from scrolling)
const KEYS: &str = r#"(() => {
  if (window.__cmrKeys) return; window.__cmrKeys = 1;
  const wheel = e => {
    if (!e.isTrusted || !(e.ctrlKey || e.shiftKey)) return;
    e.preventDefault();
    let t = e.target;
    while (t && t !== document.documentElement && !(t.scrollHeight > t.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(t).overflowY))) t = t.parentElement;
    (t && t !== document.documentElement ? t : (document.scrollingElement || document.documentElement)).scrollBy(0, e.deltaY || e.deltaX);
  };
  const keys = e => { if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0', '_'].includes(e.key)) e.preventDefault(); };
  const menu = e => e.preventDefault();
  // A frame that writes its own page (document.write, as many advertisements do) loses every handler that was put on its document before. So the handlers are put there again and again
  // (the same function twice is one handler): when the document is ready, when it is loaded, and every two seconds after.
  const arm = () => {
    document.addEventListener('wheel', wheel, { capture: true, passive: false });
    document.addEventListener('keydown', keys, true);
    document.addEventListener('contextmenu', menu, true);
  };
  arm();
  document.addEventListener('DOMContentLoaded', arm); window.addEventListener('load', arm);
  setInterval(arm, 2000);
})();"#;

/// The smallest a web window can be (a window made too small by mistake is hard to get back)
const MIN_W: f64 = 190.0;
const MIN_H: f64 = 320.0;

const PAGE: &str = r#"(() => {
  if (window.top !== window.self) return;                       // (only the page itself, not the frames in it: video players, advertisements ...)
  if (window.__cmrPage) return; window.__cmrPage = 1;
  const go = c => { try { location.href = 'cmr-cmd://' + c; } catch (e) {} };
  // A link the USER opens in a new place (ctrl / shift click, middle click, a link that says target=_blank, window.open right after a click or a key) goes to the user's own browser.
  // Nothing opens by itself: a window.open without a recent action of the user (navigator.userActivation) and every other new window is refused by the program.
  const external = u => { try { const a = new URL(u, location.href); if (a.protocol === 'https:') go('open?u=' + encodeURIComponent(a.href)); } catch (e) {} };
  const linkOf = e => (e.target && e.target.closest ? e.target.closest('a[href]') : null);
  document.addEventListener('click', e => {
    if (!e.isTrusted) return;
    const a = linkOf(e);
    if (a && (e.ctrlKey || e.metaKey || e.shiftKey || a.target === '_blank')) { e.preventDefault(); e.stopPropagation(); external(a.href); }
  }, true);
  document.addEventListener('auxclick', e => {
    if (!e.isTrusted || e.button !== 1) return;
    const a = linkOf(e);
    if (a) { e.preventDefault(); e.stopPropagation(); external(a.href); }
  }, true);
  try {
    window.open = (u) => { if (u && navigator.userActivation && navigator.userActivation.isActive) external(String(u)); return null; };
  } catch (e) {}
  // Typing into a page. The window never takes the keyboard of the game (it is "no activate"), so a click on a text box gives nothing to type into. When the MOUSE COMES OVER a text box the program
  // lifts that for the window ("prep": nothing moves, the game keeps the keyboard); a click on the box then activates the window like any window, by the system, and the keys go to the page.
  // When the mouse leaves a box that was not used the program puts it back ("unprep"); a window that was used keeps the keyboard until the user clicks the game (the window then loses it: "unprep" again).
  const editable = x => !!x && (x.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(x.tagName) && !/^(button|checkbox|radio|submit|reset|image|range|color|file)$/i.test(x.type || '')));
  // The state lives in the program (the window: may it be activated?); this page only tells it, and never believes what it told before (the page is made again at every address, the window is not;
  // `document.hasFocus()` is true in a window that is not active, too). The program puts a window that is not active back whenever a page is going to load (see on_navigation).
  let leaveT = 0;
  const later = (fn, ms) => { clearTimeout(leaveT); leaveT = setTimeout(fn, ms); };
  document.addEventListener('mouseover', e => { if (editable(e.target)) { clearTimeout(leaveT); go('prep'); } }, true);
  document.addEventListener('mousedown', e => { if (e.button === 0 && editable(e.target)) go('inputclick'); }, true);      // (macOS: asked to make sure the program is active, see the program)
  document.addEventListener('mouseout', e => { if (editable(e.target)) later(() => go('unprep'), 300); }, true);      // (the program does nothing when the window is the active one: the user is typing, and it is the click on the game that ends it)
  window.addEventListener('blur', () => later(() => go('unprep'), 400));      // (the user went to the game or another window; a moment later: a click on a text box moves the focus inside the window for a moment)
  // How far the page has scrolled, told to the program (which tells the center: it draws the thin line at the edge while the page scrolls; nothing of ours is drawn in the page). Only the
  // scroll of the page itself, a few times a second.
  let lastScroll = 0, lastText = '';
  document.addEventListener('scroll', e => {
    if (e.target !== document) return;
    const d = document.scrollingElement || document.documentElement, now = Date.now();
    if (!d || d.scrollHeight <= d.clientHeight + 1 || now - lastScroll < 40) return;
    const t = 'scroll?p=' + (d.scrollTop / (d.scrollHeight - d.clientHeight)).toFixed(3) + '&s=' + (d.clientHeight / d.scrollHeight).toFixed(3);
    if (t === lastText) return;
    lastScroll = now; lastText = t; go(t);
  }, true);
  // (the page's own scroll bars are hidden: the line above is the only one)
  const hide = () => { try { const st = new CSSStyleSheet(); st.replaceSync('html,body,*{scrollbar-width:none !important}*::-webkit-scrollbar{display:none !important}'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, st]; } catch (e) {} };
  if (document.documentElement) hide(); else document.addEventListener('DOMContentLoaded', hide);
})();"#;

fn label_ok(label: &str) -> bool {
    label.starts_with("web_") && label.len() <= 120 && label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn is_closing(label: &str) -> bool { CLOSING.lock().map(|l| l.iter().any(|x| x == label)).unwrap_or(false) }
fn get(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    if !label_ok(label) { return Err("bad label".into()); }
    app.get_webview_window(label).ok_or_else(|| "no such window".to_string())
}
fn strs(v: &Value, key: &str) -> Vec<String> { v.get(key).and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default() }

/// The window is going away: nothing touches it any more, and no list of ours keeps its address.
fn forget(w: &WebviewWindow) {
    let label = w.label().to_string();
    if let Ok(mut c) = CLOSING.lock() { if !c.contains(&label) { c.push(label.clone()); } }
    if let Ok(h) = hwnd_of(w) { win::forget(h); }
    if let Ok(mut m) = ALLOW.lock() { m.remove(&label); }
    if let Ok(mut l) = FREE.lock() { l.retain(|x| x != &label); }
    if let Ok(mut m) = OPEN_ALLOW.lock() { m.remove(&label); }
    if let Ok(mut m) = PREV_FG.lock() { m.remove(&label); }
}
/// (called when the system asks the window to close, e.g. the window's own close)
pub fn on_close_requested(label: &str) {
    if label.starts_with("web_") { if let Ok(mut c) = CLOSING.lock() { if !c.iter().any(|x| x == label) { c.push(label.to_string()); } } }
}

/// What the page asked by its bar.
fn command(app: &AppHandle, label: &str, cmd: &str, query: Option<&str>) {
    let Some(win) = app.get_webview_window(label) else { return };
    match cmd {
        "open" => {                                     // a link the user opened in a new place: the user's browser, only where the window itself may go (the same rule)
            let url = query.and_then(|q| tauri::Url::parse(&format!("http://x/?{q}")).ok()).and_then(|u| u.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.into_owned()));
            let allow = OPEN_ALLOW.lock().ok().and_then(|m| m.get(label).cloned()).unwrap_or_default();
            if let Some(url) = url { let _ = crate::plugin_open_url(url, allow); }       // (a refused address: nothing happens)
        }
        "scroll" => {                                   // how far the page has scrolled: the center draws the thin line (p: how far, s: how much of the page is in view)
            let q = query.and_then(|q| tauri::Url::parse(&format!("http://x/?{q}")).ok());
            let n = |k: &str| q.as_ref().and_then(|u| u.query_pairs().find(|(a, _)| a == k).and_then(|(_, v)| v.parse::<f64>().ok()));
            if let (Some(p), Some(sz)) = (n("p"), n("s")) { if p.is_finite() && sz.is_finite() { let _ = app.emit("web-scroll", json!({ "label": label, "p": p.clamp(0.0, 1.0), "s": sz.clamp(0.0, 1.0) })); } }
        }
        "prep" => {                                   // the mouse is over a text box: a click may activate the window now (the system does it)
            if let Ok(h) = hwnd_of(&win) {
                let prev = win::foreground();
                if prev != h { if let Ok(mut p) = PREV_FG.lock() { p.insert(label.to_string(), prev); } }
                win::allow_key(h, true);
                win::set_noactivate_light(h, false);
            }
        }
        "inputclick" => {                              // macOS: a click on a text box must make the program active; when the system has not done it a moment later, it is asked to
            if cfg!(target_os = "macos") {
                if let Ok(h) = hwnd_of(&win) {
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(150));
                        let before = win::has_keyboard(h);                  // (this window, not the program: another window of ours may have the keyboard: the bar of the center)
                        if !before { win::allow_key(h, true); let _ = win::grab_focus(h); }
                        event(format!("input click: the window {} the keyboard 0.15 s later{}", if before { "had" } else { "did NOT have" }, if before { "" } else { ": asked for it" }));
                    });
                }
            }
        }
        "unprep" | "release" => {                     // the text box is left: back to a window that takes nothing; "release": it was used, the keyboard goes back to where it was
            if let Ok(h) = hwnd_of(&win) {
                let was_front = win::foreground() == h || (cfg!(target_os = "macos") && win::has_keyboard(h));       // (macOS: `foreground` does not find this window)
                if cmd == "unprep" && was_front { return; }            // (the window is in use: it takes nothing again when it loses the keyboard)
                win::allow_key(h, false);
                win::set_noactivate_light(h, true);
                if cmd == "release" && was_front {
                    let prev = PREV_FG.lock().ok().and_then(|p| p.get(label).copied()).unwrap_or(0);
                    if prev != 0 && prev != h { win::set_foreground(prev); }
                }
            }
        }
        _ => {}
    }
}

/// Sets the OUTER rectangle in screen pixels (the same numbers as the geometry the program keeps: the invisible frame of a window is part of it).
pub(crate) fn set_outer(w: &WebviewWindow, x: Option<i32>, y: Option<i32>, width: u32, height: u32) -> Result<(), String> {
    let e = |e: tauri::Error| e.to_string();
    // (Windows: what the page fills is put exactly there, whatever frame the window has around it: the center draws its frame at that place and the page must reach it)
    if let (Some(x), Some(y), Ok(h)) = (x, y, hwnd_of(w)) { if win::set_client_rect(h, x, y, width as i32, height as i32) { return Ok(()); } }
    let (dx, dy) = match (w.inner_size(), w.outer_size()) {
        (Ok(i), Ok(o)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
        _ => (0, 0),
    };
    w.set_size(tauri::PhysicalSize::new(width.saturating_sub(dx).max(MIN_W as u32), height.saturating_sub(dy).max(MIN_H as u32))).map_err(e)?;
    if let (Some(x), Some(y)) = (x, y) { w.set_position(tauri::PhysicalPosition::new(x, y)).map_err(e)?; }
    Ok(())
}

/// Opens the window of a web page (or, when it is open, takes it to the address). args: { label, url, ua?, title?, x?, y?, w?, h? (outer, screen pixels), allow: [pattern],
/// persist, key, lock }
#[tauri::command]
pub async fn web_open(app: AppHandle, args: Value) -> Result<(), String> {
    let label = args.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !label_ok(&label) { return Err("bad label".into()); }
    let url = tauri::Url::parse(args.get("url").and_then(|v| v.as_str()).unwrap_or("")).map_err(|e| e.to_string())?;
    let allow = strs(&args, "allow");
    let free = args.get("free").and_then(|v| v.as_bool()).unwrap_or(false);
    let host_ok = if free { (url.scheme() == "https" || url.scheme() == "http") && url.host_str().map_or(false, |h| !h.is_empty()) }
                  else { url.scheme() == "https" && url.host_str().map_or(false, |h| weblib::host_allowed(h, &allow)) };
    if !host_ok { return Err("this address is not allowed".into()); }
    if let Ok(mut l) = FREE.lock() { l.retain(|x| x != &label); if free { l.push(label.clone()); } }
    if let Ok(mut m) = ALLOW.lock() { m.insert(label.clone(), allow.clone()); }
    if let Ok(mut m) = OPEN_ALLOW.lock() { m.insert(label.clone(), strs(&args, "open_allow")); }
    // open already: it goes to the address and comes to the front
    if let Some(w) = app.get_webview_window(&label) {
        if !is_closing(&label) {
            let _ = w.navigate(url);
            let _ = w.show();
            return Ok(());
        }
    }
    if let Ok(mut c) = CLOSING.lock() { c.retain(|x| x != &label); }
    let key = weblib::data_key(args.get("key").and_then(|v| v.as_str()).unwrap_or(""));
    let persist = args.get("persist").and_then(|v| v.as_bool()).unwrap_or(false);
    let (app2, lbl) = (app.clone(), label.clone());
    let (app3, lbl3) = (app.clone(), label.clone());
    let b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url));
    #[cfg(windows)]
    let b = {
        // a folder of their own: cookies are kept in webview-data/web/<plugin>/ only when the user chose it; else a private session in webview-data/web/_private/
        // How the page is drawn: 'cpu' = by the processor (a small page of a phone does not need the card, and on a display whose refresh rate the system does not quite know a page that
        // moves made the game stutter: found with test windows); 'gpu' = by the card, always; else the web view decides. The folder has one set of browser arguments, so the way is in its name.
        let render = args.get("render").and_then(|v| v.as_str()).unwrap_or("auto");
        let (suffix, extra) = match render { "cpu" => ("_cpu", "--disable-gpu"), "gpu" => ("_gpu", "--ignore-gpu-blocklist"), _ => ("", "") };
        let dir = crate::data_dir().join("web").join(format!("{}{}", if persist { key.as_str() } else { "_private" }, if persist { "" } else { suffix }));
        // (the other arguments are the ones the window library puts there by itself: giving any takes those away)
        let b = b.data_directory(dir).additional_browser_args(&format!("{extra} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
        if persist { b } else { b.incognito(true) }
    };
    #[cfg(target_os = "macos")]
    let b = if persist { b.data_store_identifier(weblib::store_id(&key)) } else { b.incognito(true) };
    let b = b.initialization_script(PAGE).initialization_script(KEYS).initialization_script_for_all_frames(KEYS);
    let mut b = b
        .title("CMR Web")
        .decorations(false)
        .accept_first_mouse(true)          // (macOS: the click that activates the window while a text box is used is not lost)
        .focusable(false)                  // (a window that does not take the keyboard from the first moment: not while the page loads, nor when it is shown. A text box turns it back: see "prep")
        .shadow(false)                     // (no shadow: the shadow of a window with no frame is made with a frame around it that the page would not fill)
        .resizable(false)                  // (the strips of the center resize it, by the program. A window that can be resized by the system has an invisible frame around it on Windows, and the page would
                                           // not fill the place the center draws its frame around: there is no such frame when it cannot)
        .skip_taskbar(true)
        .visible(false)
        .inner_size(args.get("w").and_then(|v| v.as_f64()).unwrap_or(360.0).max(MIN_W), args.get("h").and_then(|v| v.as_f64()).unwrap_or(640.0).max(MIN_H))
        .min_inner_size(MIN_W, MIN_H)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_navigation(move |u| {
            if weblib::is_command_url(u.scheme()) { command(&app2, &lbl, u.host_str().unwrap_or(""), u.query()); return false; }
            let allowed = ALLOW.lock().ok().and_then(|m| m.get(&lbl).cloned()).unwrap_or_default();
            let ok = if is_free(&lbl) { u.scheme() == "https" || u.scheme() == "http" } else { u.scheme() == "https" && u.host_str().map_or(false, |h| weblib::host_allowed(h, &allowed)) };
            if !ok {
                event(format!("address refused: {}", u.as_str().chars().take(200).collect::<String>()));
            } else {
                // a page is loading: the page before may have left the window prepared (a text box was used) without telling; a window that is not the active one is put back to taking nothing
                if let Some(w) = app2.get_webview_window(&lbl) { if let Ok(h) = hwnd_of(&w) { if win::foreground() != h && !(cfg!(target_os = "macos") && win::has_keyboard(h)) { win::allow_key(h, false); win::set_noactivate_light(h, true); } } }
                let _ = app2.emit("web-nav", json!({ "label": lbl, "url": u.as_str() }));      // (the address the page is going to: the center shows it)
            }
            ok
        })
        .on_document_title_changed(move |_, t| { let _ = app3.emit("web-title", json!({ "label": lbl3, "title": t.chars().take(120).collect::<String>() })); });
    if let Some(ua) = args.get("ua").and_then(|v| v.as_str()) { if !ua.is_empty() { b = b.user_agent(ua); } }
    let win = b.build().map_err(|e| e.to_string())?;
    // the place the window had (outer, screen pixels); else the size that was asked for
    let (w, h) = (args.get("w").and_then(|v| v.as_u64()), args.get("h").and_then(|v| v.as_u64()));
    if let (Some(w), Some(h)) = (w, h) {
        let _ = set_outer(&win, args.get("x").and_then(|v| v.as_i64()).map(|v| v as i32), args.get("y").and_then(|v| v.as_i64()).map(|v| v as i32), w as u32, h as u32);
    }
    // never the keyboard of the game: a window that cannot become the key window (macOS), the "no activate" style (Windows)
    if let Ok(hw) = hwnd_of(&win) {
        win::make_no_key(hw); win::set_noactivate_light(hw, true);
        // a window that is shown without being activated goes behind the program in front (the game): it starts on top, and the poll (web_tick) puts it in its own order a moment later
        win::set_topmost(hw, true, 0);
    }
    let _ = win.show();
    Ok(())
}

/// What the bar of the center asks of the page: "back", "forward", "reload", "goto" (an address: only for a window the user opened).
#[tauri::command]
pub async fn web_cmd(app: AppHandle, label: String, cmd: String, url: Option<String>) -> Result<(), String> {
    if is_closing(&label) { return Ok(()); }
    let w = get(&app, &label)?;
    match cmd.as_str() {
        "back" => { let _ = w.eval("history.back()"); }
        "forward" => { let _ = w.eval("history.forward()"); }
        "reload" => { let _ = w.eval("location.reload()"); }
        "goto" => {                                                                    // (the address bar of the center: only a window the user opened may be sent anywhere)
            if is_free(&label) {
                if let Some(u) = url.and_then(|u| tauri::Url::parse(&u).ok()) { if u.scheme() == "https" || u.scheme() == "http" { let _ = w.navigate(u); } }
            }
        }
        _ => {}
    }
    Ok(())
}

/// What a window of the mini browser kept (cookies and the rest) is taken away when the window is not open: its folder. `key`: the name of the folder.
#[tauri::command]
pub async fn web_forget(key: String) -> Result<(), String> {
    let k = weblib::data_key(&key);
    if k.starts_with('_') || k == "plugin" { return Err("not a folder of the mini browser".into()); }
    #[cfg(windows)]
    {
        let dir = crate::data_dir().join("web").join(k);
        if dir.exists() { std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?; }
    }
    // (macOS: the login of a window is in a store of the system's web view, not in a folder of ours: it is cleared while the window is open ("web_clear"); a closed window's store is not reached yet)
    #[cfg(not(windows))]
    let _ = k;
    Ok(())
}

#[tauri::command]
pub async fn web_close(app: AppHandle, label: String) -> Result<(), String> {
    match get(&app, &label) { Ok(w) => { forget(&w); w.close().map_err(|e| e.to_string()) } Err(_) => Ok(()) }
}

/// The addresses a window may go to (the user allowed something more or took something away).
#[tauri::command]
pub async fn web_allow(label: String, allow: Vec<String>, open_allow: Option<Vec<String>>) -> Result<(), String> {
    if !label_ok(&label) { return Err("bad label".into()); }
    if let Ok(mut m) = OPEN_ALLOW.lock() { m.insert(label.clone(), open_allow.unwrap_or_default()); }
    if let Ok(mut m) = ALLOW.lock() { m.insert(label, allow); }
    Ok(())
}

/// { exists, visible, position: [x, y], size: [w, h] } (outer, screen pixels); nothing is touched while the window closes
#[tauri::command]
pub async fn web_info(app: AppHandle, label: String) -> Value {
    if !label_ok(&label) || is_closing(&label) { return json!({ "exists": false }); }
    match app.get_webview_window(&label) {
        Some(w) => json!({ "exists": true, "visible": w.is_visible().unwrap_or(true), "position": w.outer_position().map(|p| [p.x, p.y]).ok(), "size": w.outer_size().map(|s| [s.width, s.height]).ok() }),
        None => json!({ "exists": false }),
    }
}

/// What happened since the last call, for the log of the plugin (an address that was refused).
#[tauri::command]
pub async fn web_events() -> Vec<String> {
    EVENTS.lock().map(|mut b| std::mem::take(&mut *b)).unwrap_or_default()
}

/// Cookies and the rest of what the pages stored, taken away (the window must be open).
#[tauri::command]
pub async fn web_clear(app: AppHandle, label: String) -> Result<(), String> {
    get(&app, &label)?.clear_all_browsing_data().map_err(|e| e.to_string())
}
