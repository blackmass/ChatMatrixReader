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
/// The secret of each web window: put into the script of ITS page when the window is made; a command (see PAGE) that does not carry it is refused. A script of the site in the page cannot read it (it is
/// a variable inside the script of ours), and a frame of the page does not know it.
static TOKENS: LazyLock<Mutex<std::collections::HashMap<String, String>>> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let part = || { let mut h = std::collections::hash_map::RandomState::new().build_hasher(); h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)); h.finish() };
    format!("{:016x}{:016x}", part(), part())
}
/// A command of a page: `raw` = "<secret>/<command>?<query>". Only the one that carries the secret of this window is carried out.
fn dispatch(app: &AppHandle, label: &str, raw: &str) {
    let Some((token, rest)) = raw.split_once('/') else { event("command refused: no secret".into()); return };
    let ok = TOKENS.lock().ok().and_then(|m| m.get(label).cloned()).map_or(false, |t| t.len() == token.len() && t == token);
    if !ok { event(format!("command refused: wrong secret ({label})")); return; }
    let (cmd, query) = match rest.split_once('?') { Some((c, q)) => (c, Some(q)), None => (rest, None) };
    command(app, label, cmd, query);
}

/// How solid the page of each window is now, and the number of the fade that is going on (a new fade takes over from where the window is: the old one stops).
static ALPHA: LazyLock<Mutex<std::collections::HashMap<String, (u64, f64)>>> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// How large the page of each window is drawn (1.0 = 100 %).
static ZOOM: LazyLock<Mutex<std::collections::HashMap<String, f64>>> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

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
    if (e.ctrlKey && window.top === window.self) return;                     // (in the page itself: the zoom, see PAGE)
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
  // (Windows: the message channel of the web view: it is no navigation, so it never cuts a page that is loading short, as an address that is gone to does. Elsewhere: the address)
  const T = '__TOKEN__';                                        // (the secret of this window: every command carries it, the program refuses the rest)
  const post = window.chrome && window.chrome.webview && window.chrome.webview.postMessage ? window.chrome.webview.postMessage.bind(window.chrome.webview) : null;
  const go = c => { try { if (post) post(T + '/' + c); else location.href = 'cmr-cmd://' + T + '/' + c; } catch (e) {} };
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
  // The size of the page: Ctrl + the wheel (a notch is a step; a pinch on a trackpad of Windows is a lot of small ones), Ctrl + + / - / 0, and the pinch of a Mac (its own gesture events). The program
  // keeps the size (a step is 10 %) and tells the center.
  const zoom = d => go('zoom?d=' + d);
  let acc = 0;
  document.addEventListener('wheel', e => {
    if (!e.isTrusted || !e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    acc += e.deltaY;
    while (acc <= -40) { acc += 40; zoom(1); }
    while (acc >= 40) { acc -= 40; zoom(-1); }
  }, { capture: true, passive: false });
  document.addEventListener('keydown', e => {
    if (!e.isTrusted || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom(-1); }
    else if (e.key === '0') { e.preventDefault(); zoom(0); }
  }, true);
  let last = 1;
  document.addEventListener('gesturestart', e => { e.preventDefault(); last = 1; }, true);
  document.addEventListener('gesturechange', e => {
    e.preventDefault();
    const r = e.scale / last;
    if (r > 1.08) { zoom(1); last = e.scale; } else if (r < 0.92) { zoom(-1); last = e.scale; }
  }, true);
  document.addEventListener('gestureend', e => e.preventDefault(), true);
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
    if let Ok(mut m) = TOKENS.lock() { m.remove(&label); }
    if let Ok(mut m) = ZOOM.lock() { m.remove(&label); }
    if let Ok(mut m) = ALPHA.lock() { m.remove(&label); }
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
        "zoom" => {                                     // the page asks for a larger / smaller size (d = 1, -1; 0 = 100 %): only a window the user opened
            if !is_free(label) { return; }
            let d = query.and_then(|q| tauri::Url::parse(&format!("http://x/?{q}")).ok()).and_then(|u| u.query_pairs().find(|(k, _)| k == "d").and_then(|(_, v)| v.parse::<i32>().ok())).unwrap_or(0);
            let cur = ZOOM.lock().ok().and_then(|m| m.get(label).copied()).unwrap_or(1.0);
            let new = if d == 0 { 1.0 } else { ((cur + 0.1 * d.signum() as f64) * 10.0).round() / 10.0 }.clamp(0.3, 3.0);
            if (new - cur).abs() > 0.001 || d == 0 {
                let _ = win.set_zoom(new);
                if let Ok(mut m) = ZOOM.lock() { m.insert(label.to_string(), new); }
                let _ = app.emit("web-zoom", json!({ "label": label, "zoom": new }));
            }
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

/// What the page tells by the message channel of the web view (Windows): "<secret>/<command>?<query>" (the same words as the address "cmr-cmd://<secret>/<command>?<query>").
#[cfg(windows)]
fn listen_messages(win: &WebviewWindow, app: AppHandle, label: String) {
    let _ = win.with_webview(move |wv| unsafe {
        use webview2_com::WebMessageReceivedEventHandler;
        use windows_core062::PWSTR;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut p = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut p).is_ok() && !p.is_null() {
                    let text = webview2_com::take_pwstr(p);
                    if text.len() <= 2000 {
                        dispatch(&app, &label, &text);
                    }
                }
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_WebMessageReceived(&handler, &mut token);
        // a page that asks for the camera, the microphone, the place, notifications ...: always no
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY;
        let deny = webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args { let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY); }
            Ok(())
        }));
        let mut token2 = Default::default();
        let _ = core.add_PermissionRequested(&deny, &mut token2);
    });
}

/// A call of the protocol of the developer tools on the web view of a window (Windows).
#[cfg(windows)]
fn cdp(win: &WebviewWindow, method: &'static str, params: String) {
    let _ = win.with_webview(move |wv| unsafe {
        use windows_core062::PCWSTR;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let m: Vec<u16> = method.encode_utf16().chain(std::iter::once(0)).collect();
        let p: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();
        let _ = core.CallDevToolsProtocolMethod(PCWSTR(m.as_ptr()), PCWSTR(p.as_ptr()), None);
    });
}

/// Opens the window of a web page (or, when it is open, takes it to the address). args: { label, url, ua?, title?, x?, y?, w?, h? (outer, screen pixels), allow: [pattern],
/// persist, key, lock }
#[tauri::command]
pub async fn web_open(app: AppHandle, args: Value) -> Result<(), String> {
    let label = args.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !label_ok(&label) { return Err("bad label".into()); }
    let url = tauri::Url::parse(args.get("url").and_then(|v| v.as_str()).unwrap_or("")).map_err(|e| e.to_string())?;
    let allow = strs(&args, "allow");
    // (only a window of the mini browser, made by the user, may go anywhere: web_b<number>; a plugin's window never)
    let free = args.get("free").and_then(|v| v.as_bool()).unwrap_or(false) && label.strip_prefix("web_b").map_or(false, |n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()));
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
    let token = new_token();
    if let Ok(mut m) = TOKENS.lock() { m.insert(label.clone(), token.clone()); }
    let b = b.initialization_script(PAGE.replace("__TOKEN__", &token)).initialization_script(KEYS).initialization_script_for_all_frames(KEYS);
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
        .on_download(|_, _| { event("download refused".into()); false })          // (nothing is saved to the computer by a page of the mini browser)
        .on_navigation(move |u| {
            if weblib::is_command_url(u.scheme()) { dispatch(&app2, &lbl, u.as_str().strip_prefix("cmr-cmd://").unwrap_or("")); return false; }
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
    #[cfg(windows)]
    listen_messages(&win, app.clone(), label.clone());
    {
        let zoom = args.get("zoom").and_then(|v| v.as_f64()).filter(|z| z.is_finite()).map(|z| ((z * 10.0).round() / 10.0).clamp(0.3, 3.0)).unwrap_or(1.0);
        if let Ok(mut m) = ZOOM.lock() { m.insert(label.clone(), zoom); }
        if (zoom - 1.0).abs() > 0.001 { let _ = win.set_zoom(zoom); }
    }
    // a window that visits as a phone: the browser's own headers (client hints) say it too, else they still say "Windows, a computer" next to a phone's user agent (the web view of Windows is a Chromium)
    #[cfg(windows)]
    if let (Some(ua), Some(hints)) = (args.get("ua").and_then(|v| v.as_str()).filter(|u| !u.is_empty()), args.get("ua_hints").filter(|h| h.is_object())) {
        cdp(&win, "Emulation.setUserAgentOverride", json!({ "userAgent": ua, "userAgentMetadata": hints }).to_string());
    }
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
    // macOS: the first time a window is made less than solid the system changes how it draws it, and a fade that is cut short (the mouse comes while it goes) leaves the page black behind. So the first
    // one is done at once, before the user can do anything (0.2 s: down a little and back); a fade the user starts meanwhile takes over.
    if cfg!(target_os = "macos") && is_free(&label) {
        if let Ok(hw) = hwnd_of(&win) {
            let (app4, lbl4) = (app.clone(), label.clone());
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                if app4.get_webview_window(&lbl4).is_none() { return; }
                let g = fade(&app4, &lbl4, hw, 0.9, 100);
                std::thread::sleep(std::time::Duration::from_millis(110));
                let same = ALPHA.lock().ok().and_then(|m| m.get(&lbl4).map(|e| e.0)) == Some(g);
                if same && app4.get_webview_window(&lbl4).is_some() { fade(&app4, &lbl4, hw, 1.0, 100); }
            });
        }
    }
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
        "external" => {                                                                // (the page as it is now, in the user's own browser: only where the window itself may open links: the same rule)
            if let Ok(u) = w.url() {
                let allow = OPEN_ALLOW.lock().ok().and_then(|m| m.get(&label).cloned()).unwrap_or_default();
                let _ = crate::plugin_open_url(u.to_string(), allow);
            }
        }
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

/// A window of the mini browser says to the web view what it is (the phone or the computer): a user agent and the headers of the browser that say the same. Windows only (elsewhere the window is opened again).
#[tauri::command]
pub async fn web_ua(app: AppHandle, label: String, ua: String, hints: Option<Value>) -> Result<(), String> {
    if is_closing(&label) { return Ok(()); }
    if !is_free(&label) { return Err("not a window of the mini browser".into()); }
    if ua.is_empty() || ua.len() > 600 { return Err("bad user agent".into()); }
    #[cfg(windows)]
    {
        let w = get(&app, &label)?;
        let mut p = json!({ "userAgent": ua });
        if let Some(h) = hints.filter(|h| h.is_object()) { p["userAgentMetadata"] = h; }
        cdp(&w, "Emulation.setUserAgentOverride", p.to_string());
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = (app, hints); Err("only on Windows".into()) }
}

/// A fade of the window `label` to `target` within `ms` milliseconds, from where it is now (a new one takes over: the old one stops). Returns the number of this fade.
fn fade(app: &AppHandle, label: &str, hwnd: isize, target: f64, ms: u64) -> u64 {
    let (gen, from) = {
        let Ok(mut m) = ALPHA.lock() else { return 0 };
        let e = m.entry(label.to_string()).or_insert((0, 1.0));
        e.0 += 1;
        (e.0, e.1)
    };
    if ms < 40 || (target - from).abs() < 0.01 {
        win::set_alpha(hwnd, target);
        if let Ok(mut m) = ALPHA.lock() { if let Some(e) = m.get_mut(label) { if e.0 == gen { e.1 = target; } } }
        return gen;
    }
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        let steps = (ms / 16).max(2);
        for i in 1..=steps {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let v = from + (target - from) * (i as f64 / steps as f64);
            let Ok(mut m) = ALPHA.lock() else { return };
            let Some(e) = m.get_mut(&label) else { return };
            if e.0 != gen { return; }                      // (another fade took over, or the window is gone)
            e.1 = v;
            drop(m);
            if app.get_webview_window(&label).is_none() { return; }
            win::set_alpha(hwnd, v);
        }
        if cfg!(target_os = "macos") { crate::startup_log(&format!("web alpha {label}: {target:.2} reached: {}", win::alpha_info(hwnd))); }       // (a window that darkens instead of fading: what the system says of it)
    });
    gen
}

/// How solid a window of the mini browser should be (0.2 .. 1) within `ms` milliseconds: the center says it once for each change of the goal and the window goes there by itself, from where it is now
/// (a call that comes while it is going takes over: the commands of a page do not arrive in order, so a fade made of many small calls could end anywhere).
#[tauri::command]
pub async fn web_alpha(app: AppHandle, label: String, alpha: f64, ms: Option<u64>) -> Result<(), String> {
    if is_closing(&label) || !alpha.is_finite() { return Ok(()); }
    if !is_free(&label) { return Err("not a window of the mini browser".into()); }
    let hwnd = hwnd_of(&get(&app, &label)?)?;
    fade(&app, &label, hwnd, alpha.clamp(0.2, 1.0), ms.unwrap_or(0).min(3000));
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
