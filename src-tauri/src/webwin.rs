//! The web windows of the plugins: a frameless window that shows a page of the web (a phone's page when asked), with a thin bar of ours drawn into the page. Opened by the
//! hub (app/web_host.js) when a plugin that may do it asks. What the experiments with it showed (windows + macOS) is kept here:
//!   * the bar is a script that runs in the page before the page's own scripts (top frame only); what is pressed on it goes to the program by trying to go to the address
//!     cmr-cmd://<command>, which is caught in on_navigation and never goes anywhere (the page cannot call the program: its address is not one the program trusts)
//!   * a web window never takes the keyboard of the game: the "no activate" style (Windows); on macOS a window that does not become the key window. A text box of the page
//!     that is clicked asks for the keyboard (the bar script tells), and gives it back when the box is left.
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
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{hwnd_of, weblib, win};

static ALLOW: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CLOSING: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static LOCKED: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static PREV_FG: LazyLock<Mutex<HashMap<String, isize>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static ZSTATE: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static BLOCKED: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

const BAR: &str = r#"(() => {
  if (window.top !== window.self) return;                       // (only the page itself, not the frames in it: video players, advertisements ...)
  if (window.__cmrBar) return; window.__cmrBar = 1;
  const go = c => { try { location.href = 'cmr-cmd://' + c; } catch (e) {} };
  const TITLE = __TITLE__;
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
  const mount = () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;right:0;top:0;height:22px;z-index:2147483647;';
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = '<style>.b{display:flex;align-items:center;height:22px;background:linear-gradient(#364847,#2a3836);border-bottom:1px solid #8a6a30;color:#e6c66e;font:12px "Malgun Gothic","Apple SD Gothic Neo","Segoe UI",sans-serif;cursor:move;user-select:none}.t{flex:1;padding:0 10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-shadow:0 1px 1px #000}button{border:0;background:none;color:#e6c66e;font-size:13px;width:26px;height:22px;cursor:pointer;padding:0}button:hover{color:#ffe08a;background:#4a3f1c}</style><div class="b"><span class="t"></span><button data-c="back" title="back">‹</button><button data-c="reload" title="reload">↻</button><button data-c="close" title="close">✕</button></div>';
    const t = sh.querySelector('.t'), bar = sh.querySelector('.b');
    bar.addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('button')) go('drag'); });
    for (const b of sh.querySelectorAll('button')) b.addEventListener('click', () => go(b.dataset.c));
    const title = () => { t.textContent = TITLE || document.title || location.host; };
    title(); setInterval(title, 1000);
    // a text box of the page asks for the keyboard (the window does not take it otherwise: the game keeps it); when the box is left the game gets it back
    const editable = x => !!x && (x.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(x.tagName) && !/^(button|checkbox|radio|submit|reset|image|range|color|file)$/i.test(x.type || '')));
    document.addEventListener('focusin', e => { if (editable(e.target)) go('focus'); }, true);
    document.addEventListener('focusout', e => { if (editable(e.target)) go('blur'); }, true);
    document.documentElement.append(host);
    try { const st = new CSSStyleSheet(); st.replaceSync('html{margin-top:22px !important}'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, st]; } catch (e) {}
    setInterval(() => { if (!host.isConnected) document.documentElement.append(host); }, 1000);      // (a page that draws itself again may take it away)
  };
  if (document.documentElement) mount(); else document.addEventListener('DOMContentLoaded', mount);
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
    if let Ok(mut m) = ZSTATE.lock() { m.remove(&label); }
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
            let allow = ALLOW.lock().ok().and_then(|m| m.get(label).cloned()).unwrap_or_default();
            if let Some(url) = url { let _ = crate::plugin_open_url(url, allow); }       // (a refused address: nothing happens)
        }
        "drag" => { if !LOCKED.lock().map(|l| l.iter().any(|x| x == label)).unwrap_or(false) { let _ = win.start_dragging(); } }
        "close" => { forget(&win); let w2 = win.clone(); std::thread::spawn(move || { let _ = w2.close(); }); }
        "back" => { let _ = win.eval("history.back()"); }
        "reload" => { let _ = win.eval("location.reload()"); }
        "focus" => {                                  // a text box of the page needs the keyboard: this window takes it (who had it is remembered)
            if let Ok(h) = hwnd_of(&win) {
                let prev = win::foreground();
                if prev != h { if let Ok(mut p) = PREV_FG.lock() { p.insert(label.to_string(), prev); } }
                win::allow_key(h, true);
                win::set_noactivate_light(h, false);
                win::grab_focus(h);
                let _ = win.set_focus();
            }
        }
        "blur" => {                                   // the text box was left: the keyboard goes back to where it was
            if let Ok(h) = hwnd_of(&win) {
                win::allow_key(h, false);
                win::set_noactivate_light(h, true);
                let prev = PREV_FG.lock().ok().and_then(|p| p.get(label).copied()).unwrap_or(0);
                if prev != 0 && prev != h { win::set_foreground(prev); }
            }
        }
        _ => {}
    }
}

/// Sets the OUTER rectangle in screen pixels (the same numbers as the geometry the program keeps: the invisible frame of a window is part of it).
fn set_outer(w: &WebviewWindow, x: Option<i32>, y: Option<i32>, width: u32, height: u32) -> Result<(), String> {
    let e = |e: tauri::Error| e.to_string();
    let (dx, dy) = match (w.inner_size(), w.outer_size()) {
        (Ok(i), Ok(o)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
        _ => (0, 0),
    };
    w.set_size(tauri::PhysicalSize::new(width.saturating_sub(dx).max(120), height.saturating_sub(dy).max(80))).map_err(e)?;
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
    let host_ok = url.scheme() == "https" && url.host_str().map_or(false, |h| weblib::host_allowed(h, &allow));
    if !host_ok { return Err("this address is not allowed".into()); }
    if let Ok(mut m) = ALLOW.lock() { m.insert(label.clone(), allow.clone()); }
    let lock = args.get("lock").and_then(|v| v.as_bool()).unwrap_or(false);
    if let Ok(mut l) = LOCKED.lock() { l.retain(|x| x != &label); if lock { l.push(label.clone()); } }
    // open already: it goes to the address and comes to the front
    if let Some(w) = app.get_webview_window(&label) {
        if !is_closing(&label) {
            let _ = w.navigate(url);
            let _ = w.show();
            return Ok(());
        }
    }
    if let Ok(mut c) = CLOSING.lock() { c.retain(|x| x != &label); }
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").chars().take(80).collect::<String>();
    let key = weblib::data_key(args.get("key").and_then(|v| v.as_str()).unwrap_or(""));
    let persist = args.get("persist").and_then(|v| v.as_bool()).unwrap_or(false);
    let script = BAR.replace("__TITLE__", &serde_json::to_string(&title).unwrap_or_else(|_| "\"\"".into()));
    let (app2, lbl) = (app.clone(), label.clone());
    let b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url));
    #[cfg(windows)]
    let b = {
        // a folder of their own: cookies are kept in webview-data/web/<plugin>/ only when the user chose it; else a private session in webview-data/web/_private/
        let dir = crate::data_dir().join("web").join(if persist { key.as_str() } else { "_private" });
        let b = b.data_directory(dir);
        if persist { b } else { b.incognito(true) }
    };
    #[cfg(target_os = "macos")]
    let b = if persist { b.data_store_identifier(weblib::store_id(&key)) } else { b.incognito(true) };
    // Windows: made like the program's own windows (transparent, no shadow): a window the mouse goes through (click-through) needs that; a page that draws no background of its own gets white
    #[cfg(windows)]
    let b = b.transparent(true).shadow(false).background_color(tauri::window::Color(255, 255, 255, 255));
    let mut b = b
        .title("CMR Web")
        .decorations(false)
        .resizable(!lock)
        .skip_taskbar(true)
        .visible(false)
        .inner_size(args.get("w").and_then(|v| v.as_f64()).unwrap_or(360.0).max(120.0), args.get("h").and_then(|v| v.as_f64()).unwrap_or(640.0).max(80.0))
        .initialization_script(script)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_navigation(move |u| {
            if weblib::is_command_url(u.scheme()) { command(&app2, &lbl, u.host_str().unwrap_or(""), u.query()); return false; }
            let allowed = ALLOW.lock().ok().and_then(|m| m.get(&lbl).cloned()).unwrap_or_default();
            let ok = u.scheme() == "https" && u.host_str().map_or(false, |h| weblib::host_allowed(h, &allowed));
            if !ok {
                if let (Some(h), Ok(mut bl)) = (u.host_str(), BLOCKED.lock()) { let h = h.to_ascii_lowercase(); if !bl.contains(&h) && bl.len() < 50 { bl.push(h); } }
            }
            ok
        });
    if let Some(ua) = args.get("ua").and_then(|v| v.as_str()) { if !ua.is_empty() { b = b.user_agent(ua); } }
    let win = b.build().map_err(|e| e.to_string())?;
    // the place the window had (outer, screen pixels); else the size that was asked for
    let (w, h) = (args.get("w").and_then(|v| v.as_u64()), args.get("h").and_then(|v| v.as_u64()));
    if let (Some(w), Some(h)) = (w, h) {
        let _ = set_outer(&win, args.get("x").and_then(|v| v.as_i64()).map(|v| v as i32), args.get("y").and_then(|v| v.as_i64()).map(|v| v as i32), w as u32, h as u32);
    }
    // never the keyboard of the game: a window that cannot become the key window (macOS), the "no activate" style (Windows)
    if let Ok(hw) = hwnd_of(&win) { win::make_no_key(hw); win::set_noactivate_light(hw, true); }
    let _ = win.show();
    Ok(())
}

#[tauri::command]
pub async fn web_close(app: AppHandle, label: String) -> Result<(), String> {
    match get(&app, &label) { Ok(w) => { forget(&w); w.close().map_err(|e| e.to_string()) } Err(_) => Ok(()) }
}

/// The addresses a window may go to (the user allowed something more or took something away).
#[tauri::command]
pub async fn web_allow(label: String, allow: Vec<String>) -> Result<(), String> {
    if !label_ok(&label) { return Err("bad label".into()); }
    if let Ok(mut m) = ALLOW.lock() { m.insert(label, allow); }
    Ok(())
}

/// What the program does every poll for a window: the style is put back (a window library call may have wiped it) and the order of the windows is kept.
/// mode 0: an ordinary window, 1: always on top, 2: above the game only (`game`: the window of the game).
#[tauri::command]
pub async fn web_tick(app: AppHandle, label: String, mode: u32, game: Option<i64>) -> Result<(), String> {
    if is_closing(&label) { return Ok(()); }
    let w = get(&app, &label)?;
    let h = hwnd_of(&w)?;
    win::keep_style(h);
    let want = match mode {
        1 => 1,
        2 => match game { Some(g) if g > 0 => { let fg = win::foreground(); if fg == g as isize { 21 } else if win::self_front() { 23 } else { 22 } }, _ => 1 },    // (no game found: like always on top, it must stay in view)
        _ => 0,
    };
    let last = ZSTATE.lock().ok().and_then(|m| m.get(&label).copied()).unwrap_or(99);
    if last != want {
        if let Ok(mut m) = ZSTATE.lock() { m.insert(label.clone(), want); }
        let g = game.unwrap_or(0) as isize;
        match want {
            0 => { win::set_owner(h, 0); win::set_topmost(h, false, 0); }
            // The game in front: topmost first, then the owner goes (the window never sinks behind the game). One of OUR windows in front (the options window): the owner goes
            // FIRST: Windows keeps an owner and its owned window in the same topmost state, so "topmost" for the owned window would make the GAME topmost and it would cover the
            // window that was just clicked (the options window "hid"). Same as the translation windows (overlay.js zStep).
            1 | 21 => { win::set_topmost(h, true, 0); win::set_owner(h, 0); }
            23 => { win::set_owner(h, 0); win::set_topmost(h, true, 0); }
            // From "one of our windows in front" (23): the window goes down to just above the game FIRST, then the owner is set. The other way round (owner first) re-ordered the
            // windows when the owner of a topmost window changed, and the options window that stood above the game sank behind it.
            22 if last == 23 => { win::set_topmost(h, false, g); win::set_owner(h, g); }
            _ => { win::set_owner(h, g); win::set_topmost(h, false, g); }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn web_ignore(app: AppHandle, label: String, on: bool) -> Result<i64, String> {
    let w = get(&app, &label)?;
    w.set_ignore_cursor_events(on).map_err(|e| e.to_string())?;
    let h = hwnd_of(&w)?;
    win::keep_style(h);
    Ok(win::ex_style(h) as i64)        // (for the log of the plugin: the extended style after the change; 0x20 = click-through, 0x80000 = layered)
}

#[tauri::command]
pub async fn web_lock(app: AppHandle, label: String, on: bool) -> Result<(), String> {
    let w = get(&app, &label)?;
    if let Ok(mut l) = LOCKED.lock() { l.retain(|x| x != &label); if on { l.push(label.clone()); } }
    w.set_resizable(!on).map_err(|e| e.to_string())
}

/// Puts the window in a place (outer rectangle, screen pixels).
#[tauri::command]
pub async fn web_rect(app: AppHandle, label: String, x: Option<i32>, y: Option<i32>, w: u32, h: u32) -> Result<(), String> {
    set_outer(&get(&app, &label)?, x, y, w, h)
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

/// The hosts the windows tried to go to without being allowed since the last call (for the log of the plugin).
#[tauri::command]
pub async fn web_blocked() -> Vec<String> {
    BLOCKED.lock().map(|mut b| std::mem::take(&mut *b)).unwrap_or_default()
}

/// Cookies and the rest of what the pages stored, taken away (the window must be open).
#[tauri::command]
pub async fn web_clear(app: AppHandle, label: String) -> Result<(), String> {
    get(&app, &label)?.clear_all_browsing_data().map_err(|e| e.to_string())
}
