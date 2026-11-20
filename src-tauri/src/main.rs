//! ChatMatrix Reader: the exe is only a host.
//!   * It serves the pages from the `app` folder next to the exe (plain HTML/CSS/JS, read from disk on every load).
//!   * It lends the pages a few generic OS tools (the #[tauri::command] functions below).
//! What the program actually does is decided by the JavaScript in the `app` folder.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(any(windows, target_os = "macos")))]
compile_error!("This program is for Windows and macOS.");

mod audio;
#[cfg(windows)]
mod capture;
#[cfg(target_os = "macos")]
#[path = "capture_mac.rs"]
mod capture;
mod capturelib;
mod ext;
mod extlib;
mod files;
mod placement;
mod pluginlib;
mod procrole;
// everything that calls the operating system directly: the same functions in both files (win.rs: Windows, mac.rs: macOS)
#[cfg(windows)]
mod win;
#[cfg(target_os = "macos")]
#[path = "mac.rs"]
mod win;

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const INPUT_TITLE: &str = "CMR Input";
static HOTKEY_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ---------------------------------------------------------------------------------------------- the app folder

/// The folder of the program: the one the exe is in. On macOS the exe is inside the app bundle (Name.app/Contents/MacOS/name): the folder
/// that holds the .app is meant, so that app/, fonts/, config.json ... live next to the .app like they live next to the exe on Windows.
fn exe_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        if dir.ends_with("Contents/MacOS") {
            if let Some(bundle) = dir.parent().and_then(|p| p.parent()) {
                // A program that was downloaded (it has the "quarantine" mark) is started by macOS from a copy of the .app alone, in a read-only place of its own
                // (".../AppTranslocation/<number>/d/Name.app"): app/, config.json ... next to the real .app are not there. The real place is asked of the system.
                let real = if bundle.to_string_lossy().contains("/AppTranslocation/") { mac_original_path(bundle) } else { None };
                let bundle = real.unwrap_or_else(|| bundle.to_path_buf());
                if let Some(outside) = bundle.parent() { return outside.to_path_buf(); }
            }
        }
    }
    dir
}

/// The place a translocated .app really is in (Security framework: SecTranslocateCreateOriginalPathForURL); None when the system does not tell.
#[cfg(target_os = "macos")]
fn mac_original_path(translocated: &std::path::Path) -> Option<PathBuf> {
    use core_foundation::base::TCFType;
    use core_foundation::url::{CFURL, CFURLRef};
    type Original = unsafe extern "C" fn(url: CFURLRef, error: *mut *mut std::ffi::c_void) -> CFURLRef;
    unsafe {
        let lib = libc::dlopen(c"/System/Library/Frameworks/Security.framework/Security".as_ptr(), libc::RTLD_LAZY);
        let sym = libc::dlsym(if lib.is_null() { libc::RTLD_DEFAULT } else { lib }, c"SecTranslocateCreateOriginalPathForURL".as_ptr());
        if sym.is_null() { return None; }
        let call: Original = std::mem::transmute(sym);
        let url = CFURL::from_path(translocated, true)?;
        let mut error: *mut std::ffi::c_void = std::ptr::null_mut();
        let out = call(url.as_concrete_TypeRef(), &mut error);
        if out.is_null() { return None; }
        CFURL::wrap_under_create_rule(out).to_path()
    }
}

/// `app` next to the exe; when started from src-tauri/target/release (cargo run), the one in the project folder.
fn app_dir() -> PathBuf {
    let dir = exe_dir();
    for cand in [dir.join("app"), dir.join("..").join("..").join("..").join("app")] {
        if cand.join("control.html").is_file() {
            return cand;
        }
    }
    dir.join("app")
}

/// The program folder: the one that holds `app/` (and next to which config.json, Glossary.txt, the logs ... live).
fn base_dir() -> PathBuf {
    app_dir().parent().map(|p| p.to_path_buf()).unwrap_or_default()
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "mjs" => "text/javascript; charset=utf-8",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// "%EB%A7%91" -> bytes -> text (the pages ask for files with encodeURIComponent: Korean file names, spaces)
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Answers http://cmr.localhost/<file> with app/<file>.
fn serve(path: &str) -> tauri::http::Response<Vec<u8>> {
    let decoded = percent_decode(path);
    let path = decoded.as_str();
    let builder = tauri::http::Response::builder().header("Cache-Control", "no-store");
    if path.contains("..") || path.contains(':') || path.contains('\\') {
        return builder.status(403).body(b"forbidden".to_vec()).unwrap();
    }
    let name = if path.is_empty() { "control.html" } else { path };
    // fonts/ is the user's folder next to app/ (the fonts the user put there); everything else is the app folder
    let file = if name.starts_with("fonts/") { base_dir().join(name) } else { app_dir().join(name) };
    match std::fs::read(&file) {
        Ok(bytes) => builder.status(200).header("Content-Type", mime(name)).body(bytes).unwrap(),
        Err(_) => builder
            .status(404)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(format!("not found: {}", file.display()).into_bytes())
            .unwrap(),
    }
}

/// The plugin address: cmrplug://localhost/<token>/<file> (Windows: http://cmrplug.localhost/<token>/<file>). The token (pluginlib.rs) stands for one plugin and is told only to the
/// page that starts it (plugin_token below): the file is plugins/<id>/<file> of the program folder. Nothing outside plugins/<id>/ is ever given (no "..", no drive or stream
/// names, no link that leads out), and every answer carries a policy (CSP) that lets the page load only its own files and nothing from the network.
fn serve_plugin(path: &str) -> tauri::http::Response<Vec<u8>> {
    // The policy names the plugin address itself (not 'self'): the pages are shown in a sandboxed frame, and WebKit (macOS) does not match 'self' there.
    let me = if cfg!(windows) { "http://cmrplug.localhost" } else { "cmrplug://localhost" };
    let csp = format!(
        "default-src {me} blob: data:; script-src {me} 'unsafe-inline' blob:; style-src {me} 'unsafe-inline'; img-src {me} data: blob:; font-src {me} data:; \
         connect-src {me} blob: data:; worker-src {me} blob:; frame-src 'none'; object-src 'none'; base-uri {me}; form-action 'none'"
    );
    let decoded = percent_decode(path);
    let builder = tauri::http::Response::builder()
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", csp)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("X-Content-Type-Options", "nosniff");
    let refuse = |b: tauri::http::response::Builder, code: u16| b.status(code).header("Content-Type", "text/plain; charset=utf-8").body(b"no".to_vec()).unwrap();
    let (token, rest) = decoded.split_once('/').unwrap_or((decoded.as_str(), ""));
    let rest = if rest.is_empty() { "index.html" } else { rest };
    let Some(id) = plugin_tokens().id_of(token) else { return refuse(builder, 403) };
    if !pluginlib::valid_rel(rest) {
        return refuse(builder, 403);
    }
    // what the program gives to every plugin page: the way to talk to the program (plugin_sdk.js) and the look of its options window (plugin_theme.css)
    if let Some(name) = rest.strip_prefix("__sdk/") {
        let file = match name { "plugin.js" => "plugin_sdk.js", "theme.css" => "plugin_theme.css", _ => return refuse(builder, 404) };
        return match std::fs::read(app_dir().join(file)) {
            Ok(bytes) => builder.status(200).header("Content-Type", mime(file)).body(bytes).unwrap(),
            Err(_) => refuse(builder, 404),
        };
    }
    let root = base_dir().join("plugins").join(&id);
    let file = root.join(rest);
    if !pluginlib::inside(&root, &file) {
        return refuse(builder, 404);
    }
    match std::fs::read(&file) {
        Ok(bytes) => builder.status(200).header("Content-Type", mime(rest)).body(bytes).unwrap(),
        Err(_) => refuse(builder, 404),
    }
}

fn plugin_tokens() -> &'static pluginlib::Tokens {
    static T: std::sync::OnceLock<pluginlib::Tokens> = std::sync::OnceLock::new();
    T.get_or_init(pluginlib::Tokens::new)
}

/// The secret part of the address of a plugin (made at the first call; `renew`: a new one, the old address stops working). Only the pages of the program can ask.
#[tauri::command]
fn plugin_token(id: String, renew: Option<bool>) -> Result<String, String> {
    plugin_tokens().token_for(&id, renew.unwrap_or(false))
}

/// A request for a plugin (cmr.net.fetch): https only, to a host the user allowed (`hosts`: exact names), the same for every redirect; the size of what is sent and of the
/// answer is limited. -> { status, body, url, type }
#[tauri::command]
async fn plugin_fetch(url: String, method: Option<String>, headers: Option<Vec<(String, String)>>, body: Option<String>, hosts: Vec<String>, max_bytes: Option<usize>) -> Result<Value, String> {
    use tauri_plugin_http::reqwest;
    let hosts: Vec<String> = hosts.into_iter().map(|h| h.to_lowercase()).collect();
    let ok_url = |u: &reqwest::Url| u.scheme() == "https" && u.username().is_empty() && u.password().is_none() && u.port().is_none() && u.host_str().map_or(false, |h| hosts.iter().any(|x| x == &h.to_lowercase()));
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !ok_url(&parsed) {
        return Err("this address is not allowed for the plugin".into());
    }
    let method = match method.unwrap_or_else(|| "GET".into()).to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "HEAD" => reqwest::Method::HEAD,
        _ => return Err("only GET, POST and HEAD".into()),
    };
    if body.as_ref().map_or(0, |b| b.len()) > 1_000_000 {
        return Err("the request is too big (1 MB at most)".into());
    }
    let hosts_for_redirect = hosts.clone();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        let u = attempt.url();
        let ok = u.scheme() == "https" && u.username().is_empty() && u.password().is_none() && u.port().is_none() && u.host_str().map_or(false, |h| hosts_for_redirect.iter().any(|x| x == &h.to_lowercase()));
        if attempt.previous().len() >= 5 || !ok { attempt.stop() } else { attempt.follow() }
    });
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).http1_only().redirect(policy).build().map_err(|e| e.to_string())?;
    let mut req = client.request(method, parsed);
    for (name, value) in headers.unwrap_or_default().into_iter().take(30) {
        let n = name.to_lowercase();
        if ["host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "expect", "proxy-authorization", "proxy-connection"].contains(&n.as_str()) || n.starts_with("sec-") {
            continue;
        }
        req = req.header(name.as_str(), value.as_str());
    }
    if let Some(body) = body {
        req = req.body(body);
    }
    let describe = |e: reqwest::Error| if e.is_timeout() { "timed out".to_string() } else { format!("{e}") };
    let mut res = req.send().await.map_err(describe)?;
    let status = res.status().as_u16();
    let final_url = res.url().to_string();
    // a redirect that was not followed (it leads to a host the user has not allowed): the plugin is told where it goes, so that it can ask for that host
    let location = res.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let ctype = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let limit = max_bytes.unwrap_or(2_000_000).min(5_000_000);
    let mut data: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(describe)? {
        if data.len() + chunk.len() > limit {
            return Err(format!("the answer is bigger than {limit} bytes"));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(json!({ "status": status, "body": String::from_utf8_lossy(&data), "url": final_url, "type": ctype, "location": location }))
}

/// The plugin is stopped: its address stops working.
#[tauri::command]
fn plugin_forget(id: String) {
    plugin_tokens().forget(&id);
}

/// The fingerprint of the folder of a plugin: { hash, files: [{ path, size, sha256 }] } (links are not allowed in a plugin; the sizes are limited).
#[tauri::command(async)]
fn plugin_hash(id: String) -> Result<Value, String> {
    if !pluginlib::valid_id(&id) {
        return Err("bad plugin id".into());
    }
    let root = base_dir().join("plugins").join(&id);
    let (hash, files) = pluginlib::tree_hash(&root)?;
    Ok(json!({ "hash": hash, "files": files.iter().map(|f| json!({ "path": f.path, "size": f.size, "sha256": f.sha256 })).collect::<Vec<_>>() }))
}

/// Is this the folder of a version 1.x (the Python program: app.py in the main folder, or app/app.py since 1.6)? Then only the page that
/// puts those files away is opened (app/legacy.html): the program starts after that. 3.0 has neither file.
fn legacy_present() -> bool {
    let base = base_dir();
    base.join("app.py").is_file() || base.join("app").join("app.py").is_file()
}

fn page_url(page: &str) -> tauri::Url {
    // On Windows a custom scheme "cmr" is reached as http://cmr.localhost/, on macOS as cmr://localhost/
    #[cfg(windows)]
    let url = format!("http://cmr.localhost/{page}");
    #[cfg(not(windows))]
    let url = format!("cmr://localhost/{page}");
    url.parse().expect("page url")
}

// ---------------------------------------------------------------------------------------------- windows

/// Where the webview keeps its own files (cache, localStorage): a folder next to the exe instead of AppData, so the
/// program leaves nothing behind on the PC.
#[cfg(windows)]
fn data_dir() -> PathBuf {
    exe_dir().join("webview-data")
}

fn make_window(app: &AppHandle, label: &str, page: &str, kind: &str) -> tauri::Result<WebviewWindow> {
    // All windows share one web view folder, so they must all be started with the same arguments. The three "disable" switches keep a page
    // that is hidden or covered (the control window) running at full speed: its timers are the capture loop and the translation queue.
    let b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(page_url(page)));
    #[cfg(windows)]
    let b = b.data_directory(data_dir()).additional_browser_args(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
    );
    let b = match kind {
        "overlay" => b
            .title("CMR Overlay")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)         // the page shows the window when it has drawn itself (else a black square is seen for a moment)
            .resizable(false)       // the page resizes it by the edges it draws itself (not at the top: that is the title bar)
            .inner_size(520.0, 260.0),
        "input" => b
            .title(INPUT_TITLE)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .inner_size(520.0, 46.0),
        // the popup: the menu and the tooltips of the translation windows. Made when first needed and shown/hidden/closed by the pages (popup_*).
        // No focus (the game keeps the keyboard), always on top (not "above the game": nothing to be ordered against), the size is set by the page.
        "popup" => b
            .title("CMR Popup")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focusable(false)
            .visible(false)
            .inner_size(40.0, 40.0),
        "legacy" => b.title("ChatMatrixReader").inner_size(600.0, 560.0).min_inner_size(480.0, 420.0).center().always_on_top(true),
        "options" => b.title("ChatMatrix 옵션").visible(false).inner_size(940.0, 680.0).min_inner_size(720.0, 480.0).center(),
        // the control window is the program's brain, not something to look at: it is never shown. An empty file "show_control" next to app/
        // shows it as a normal test window.
        _ if base_dir().join("show_control").exists() => b.title("ChatMatrix control").inner_size(600.0, 820.0),
        // macOS slows a page down when its window is hidden (timers wait seconds, the page is even frozen after a while), and this page runs the screen
        // reading: there the window is "seen" but nobody can see it: a few pixels, almost transparent, no frame, no mouse, no focus (see below)
        #[cfg(target_os = "macos")]
        _ => b.title("ChatMatrix control").decorations(false).transparent(true).shadow(false).focusable(false).always_on_top(true).skip_taskbar(true)
            .resizable(false).position(0.0, 40.0).inner_size(4.0, 4.0),
        #[cfg(not(target_os = "macos"))]
        _ => b.title("ChatMatrix control").visible(false).skip_taskbar(true).inner_size(600.0, 820.0),
    };
    let w = b.build()?;
    #[cfg(target_os = "macos")]
    if kind == "control" && !base_dir().join("show_control").exists() {
        let _ = w.set_ignore_cursor_events(true);
        if let Ok(h) = hwnd_of(&w) {
            win::set_noactivate(h, true);              // (a panel that does not activate the program, on every Space)
            win::set_alpha(h, 0.02);                   // (seen for the system, not for the eye)
            win::raise_top(h);
        }
    }
    if kind == "popup" {
        let _ = w.set_ignore_cursor_events(true);
        if let Ok(h) = hwnd_of(&w) { win::set_noactivate(h, true); }
    }
    if kind == "options" {
        let _ = w.set_always_on_top(false);            // an ordinary window, whatever the other windows do
        if let Ok(h) = hwnd_of(&w) {
            win::style_caption(h);                     // (before the window is seen: no white title bar first)
        }
    }
    if kind == "overlay" || kind == "options" {
        // the page shows its window; when it does not (an error in the page), it is shown after a while anyway
        let again = w.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(3500));
            let _ = again.show();
        });
    }
    Ok(w)
}

fn hwnd_of(window: &WebviewWindow) -> Result<isize, String> {
    #[cfg(windows)]
    { window.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string()) }
    #[cfg(target_os = "macos")]
    { window.ns_window().map(|p| p as isize).map_err(|e| e.to_string()) }
}

// ---------------------------------------------------------------------------------------------- tools for the pages

/// Cursor, modifier keys, the calling window's rectangle (real pixels) and the active window.
/// `keys`: virtual-key codes to look at as well (0x0D Enter ...); the answer has one true/false per code in "keys".
#[tauri::command(async)]
fn os_state(window: WebviewWindow, keys: Option<Vec<i32>>) -> Value {
    let keys: Vec<bool> = keys.unwrap_or_default().into_iter().map(win::key_down).collect();
    let (cx, cy) = win::cursor_pos();
    let (x, y) = window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
    let (w, h) = window.outer_size().map(|s| (s.width, s.height)).unwrap_or((0, 0));
    if let Ok(h) = hwnd_of(&window) { win::keep_style(h); }          // (the style of the click-through window is put back when the window library wiped it)
    let ex = hwnd_of(&window).map(win::ex_style).unwrap_or(0);
    let fg = win::foreground();
    json!({
        "ex": ex as i64,
        "fgMine": win::is_mine(fg),
        "selfFront": win::self_front(),
        "cursor": [cx, cy],
        "shift": win::key_down(0x10),
        "ctrl": win::key_down(0x11),
        "alt": win::key_down(0x12),
        "keys": keys,
        "win": [x, y, w, h],
        "fg": fg as i64,
        "fgTitle": win::window_title(fg),
        "fgExe": win::exe_of(fg),
    })
}

/// The game window: `known` is the handle from the last answer (0 = search). null when there is none.
/// -> { hwnd, rect: [x, y, w, h] | null (minimised), exe, title, front }
#[tauri::command(async)]
fn find_game(known: Option<i64>, title: Option<String>) -> Value {
    match win::find_game(known.unwrap_or(0) as isize, title.as_deref().unwrap_or("")) {
        Some(g) => json!({ "hwnd": g.hwnd as i64, "rect": g.rect, "exe": g.exe, "title": g.title, "front": win::foreground() == g.hwnd }),
        None => Value::Null,
    }
}

#[tauri::command]
fn screen_rect() -> [i32; 4] {
    win::screen_rect()
}

/// Screen pixels as raw bytes (see win::capture). Runs off the main thread.
#[tauri::command(async)]
fn capture(x: i32, y: i32, w: i32, h: i32) -> Result<tauri::ipc::Response, String> {
    win::capture(x, y, w, h).map(|bytes| tauri::ipc::Response::new(bytes))
}

/// The calling window stops (or starts again) taking the keyboard away from the game when clicked.
#[tauri::command]
fn set_noactivate(window: WebviewWindow, on: bool) -> Result<(), String> {
    win::set_noactivate(hwnd_of(&window)?, on);
    Ok(())
}

/// Blur behind the calling window. color: "#rrggbb"; alpha 0..1 = strength of that colour over the blur; state 3 blur / 4 strong blur.
#[tauri::command]
fn set_blur(window: WebviewWindow, on: bool, state: i32, color: String, alpha: f64) -> Result<bool, String> {
    let hex = color.trim_start_matches('#');
    let part = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    Ok(win::set_blur(hwnd_of(&window)?, on, state, part(0), part(2), part(4), alpha))
}

#[tauri::command]
async fn open_overlay(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label) {
        return w.show().map_err(|e| e.to_string());
    }
    make_window(&app, &label, "overlay.html", "overlay").map(|_| ()).map_err(|e| e.to_string())
}

/// The popup window (menu / tooltips): made when it is needed first. Nothing happens when it is there already.
#[tauri::command]
async fn popup_open(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("popup").is_some() {
        return Ok(());
    }
    make_window(&app, "popup", "popup.html", "popup").map(|_| ()).map_err(|e| e.to_string())
}

/// The usable area (without the taskbar) and the scale of the monitor that has the point; nothing known = a huge area (nothing is moved).
fn monitor_at(win: &WebviewWindow, x: i32, y: i32) -> (placement::Area, f64) {
    let m = win.monitor_from_point(x as f64, y as f64).ok().flatten().or_else(|| win.primary_monitor().ok().flatten());
    match m {
        Some(m) => {
            let a = m.work_area();
            (placement::Area { x: a.position.x, y: a.position.y, w: a.size.width as i32, h: a.size.height as i32 }, m.scale_factor())
        }
        None => (placement::Area { x: -1_000_000, y: -1_000_000, w: 2_000_000, h: 2_000_000 }, 1.0),
    }
}

/// What a tip that follows the cursor needs to know between two moves: the size of its page (CSS pixels) and where it is.
struct PopupFollow {
    w: f64,
    h: f64,
    last: (i32, i32),
}
static POPUP_FOLLOW: std::sync::Mutex<Option<PopupFollow>> = std::sync::Mutex::new(None);

/// Puts the popup at a place and shows it WITHOUT taking the focus. `kind`: "menu" (takes the mouse; its corner at `at`) or "tip" (the mouse goes
/// through it). `at`: [x, y], the cursor (real screen pixels); `anchor`: [left, top, right, bottom] of what a tip is about (a widget): above it.
/// (w, h): the size of the page in CSS pixels (times the scale of the monitor it lands on: the page does not know that monitor). Everything is put
/// inside the usable area of the monitor the cursor / the anchor is on (placement.rs).
#[tauri::command]
fn popup_place(app: AppHandle, kind: String, at: Option<Vec<i32>>, anchor: Option<Vec<i32>>, w: f64, h: f64) -> Result<(), String> {
    let win = app.get_webview_window("popup").ok_or("no popup window")?;
    let e = |e: tauri::Error| e.to_string();
    let menu = kind == "menu";
    let anchor = anchor.filter(|a| a.len() == 4);
    let at = at.filter(|p| p.len() == 2);
    let (rx, ry) = match (&anchor, &at) {
        (Some(a), _) => ((a[0] + a[2]) / 2, (a[1] + a[3]) / 2),
        (None, Some(p)) => (p[0], p[1]),
        _ => return Err("no place to show it at".into()),
    };
    let (area, sc) = monitor_at(&win, rx, ry);
    let (pw, ph) = ((w * sc).ceil().max(1.0) as i32, (h * sc).ceil().max(1.0) as i32);
    let (x, y) = match &anchor {
        Some(a) => placement::above_anchor(area, a[0], a[1], a[2], a[3], pw, ph, (6.0 * sc) as i32),
        None => placement::at_point(area, rx, ry, pw, ph, if menu { 0 } else { (12.0 * sc) as i32 }, if menu { 0 } else { (16.0 * sc) as i32 }),
    };
    if let Ok(mut f) = POPUP_FOLLOW.lock() {
        *f = if !menu && anchor.is_none() { Some(PopupFollow { w, h, last: (x, y) }) } else { None };
    }
    win.set_ignore_cursor_events(!menu).map_err(e)?;
    win.set_size(tauri::PhysicalSize::new(pw as u32, ph as u32)).map_err(e)?;
    win.set_position(tauri::PhysicalPosition::new(x, y)).map_err(e)?;
    win.show().map_err(e)?;
    if let Ok(h) = hwnd_of(&win) {
        win::keep_style(h);
        win::set_topmost(h, true, 0);                 // (the window library may think it is on top already and skip it)
    }
    Ok(())
}

/// A tip that follows the cursor: the page asks again and again; the exe reads the cursor itself and moves the window (nothing goes back and forth
/// with the pages). The same rules as at the start: it goes to the other side of the cursor at the edge of the monitor the cursor is on.
#[tauri::command]
fn popup_follow(app: AppHandle) -> Result<(), String> {
    let (w, h, last) = match POPUP_FOLLOW.lock() {
        Ok(f) => match f.as_ref() { Some(s) => (s.w, s.h, s.last), None => return Ok(()) },
        Err(_) => return Ok(()),
    };
    let win = match app.get_webview_window("popup") { Some(w) => w, None => return Ok(()) };
    let e = |e: tauri::Error| e.to_string();
    let (cx, cy) = win::cursor_pos();
    let (area, sc) = monitor_at(&win, cx, cy);
    let (pw, ph) = ((w * sc).ceil().max(1.0) as i32, (h * sc).ceil().max(1.0) as i32);
    let (x, y) = placement::at_point(area, cx, cy, pw, ph, (12.0 * sc) as i32, (16.0 * sc) as i32);
    if let Ok(cur) = win.outer_size() {
        if cur.width != pw as u32 || cur.height != ph as u32 {
            win.set_size(tauri::PhysicalSize::new(pw as u32, ph as u32)).map_err(e)?;      // (the cursor went to a monitor with another scale)
        }
    }
    if (x, y) != last {
        win.set_position(tauri::PhysicalPosition::new(x, y)).map_err(e)?;
        if let Ok(mut f) = POPUP_FOLLOW.lock() {
            if let Some(s) = f.as_mut() { s.last = (x, y); }
        }
    }
    Ok(())
}

/// Hides the popup (it stays there, so the next one is quick).
#[tauri::command]
fn popup_hide(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window("popup") {
        Some(w) => w.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Takes the popup away (nobody needed it for a while: no web view is kept for nothing).
#[tauri::command]
fn popup_close(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window("popup") {
        Some(w) => w.destroy().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Moves / resizes the calling window (real pixels; outer rectangle). x and y may be left out: only the size changes.
#[tauri::command]
fn set_window_rect(window: WebviewWindow, x: Option<i32>, y: Option<i32>, w: u32, h: u32) -> Result<(), String> {
    let e = |e: tauri::Error| e.to_string();
    // `w`, `h` are the OUTER size (what os_state reports and the config keeps: the frame and the title bar included); set_size sets the INNER
    // size, so the frame is taken off first. (Without it a window with a frame grew by the frame at every close and open.)
    let (dx, dy) = match (window.inner_size(), window.outer_size()) {
        (Ok(i), Ok(o)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
        _ => (0, 0),
    };
    window.set_size(tauri::PhysicalSize::new(w.saturating_sub(dx).max(120), h.saturating_sub(dy).max(60))).map_err(e)?;
    if let (Some(x), Some(y)) = (x, y) {
        window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(e)?;
    }
    Ok(())
}

/// Closes a translation window by its label (the window does not exist = nothing to do).
#[tauri::command]
fn close_overlay(app: AppHandle, label: String) -> Result<(), String> {
    match app.get_webview_window(&label) {
        Some(w) if label != "main" => w.close().map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}

/// The options window: opened, or brought to the front when it is already there.
#[tauri::command]
async fn open_options(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("options") {
        let _ = w.show();
        let _ = w.unminimize();
        let r = w.set_focus().map_err(|e| e.to_string());
        if let Ok(h) = hwnd_of(&w) {
            // the hotkey / the gear of a window that does not take the focus: the options must come to the front, not stay behind the game
            let _ = app.run_on_main_thread(move || { win::grab_focus(h); });
        }
        return r;
    }
    make_window(&app, "options", "options.html", "options").map(|_| ()).map_err(|e| e.to_string())
}

/// Shows the send box next to the window `label` (same width) and gives it the keyboard. `place`: "auto" (or nothing) = under the window, above it when under it
/// the box would be cut off (it sits at the bottom of the screen, over the taskbar); "below" / "above" = always there (placement.rs send_box). In the monitor the window is on.
#[tauri::command]
fn show_input(app: AppHandle, label: String, place: Option<String>) -> Result<(), String> {
    let w = app.get_webview_window("input").ok_or("no input window")?;
    let e = |e: tauri::Error| e.to_string();
    let place = place.unwrap_or_else(|| "auto".into());
    place_input(&app, &label, &place)?;
    if let Ok(mut a) = INPUT_ANCHOR.lock() { *a = Some((label, place)); }       // (from now on the box follows its window: see on_window_event)
    w.show().map_err(e)?;
    let hwnd = hwnd_of(&w)?;
    win::grab_focus(hwnd);          // this program to the front (on a Mac this takes a moment)
    w.set_focus().map_err(e)?;      // moves the keyboard into the page inside the window
    // Whether the box gets the keyboard is NOT decided here: it may take a second or more (macOS). The box is "open" at once; a thread asks again every 0.2 s until
    // it is the key window and tells how long it took ('input-focus', for the log). If it never gets it, the send box (sendbox.js) notices and gives the keyboard back.
    let app2 = app.clone();
    std::thread::spawn(move || {
        use tauri::Emitter;
        let t0 = std::time::Instant::now();
        let mut ok = win::has_keyboard(hwnd);
        for _ in 0..15 {
            if ok { break; }
            std::thread::sleep(Duration::from_millis(200));
            let Some(w) = app2.get_webview_window("input") else { return };
            if !w.is_visible().unwrap_or(false) { return; }        // (closed meanwhile)
            win::ask_keyboard(hwnd);
            let _ = w.set_focus();
            ok = win::has_keyboard(hwnd);
        }
        let _ = app2.emit("input-focus", json!({ "ok": ok, "ms": t0.elapsed().as_millis() as u64, "front": win::self_front() }));
    });
    Ok(())
}

/// The window the open send box follows (its label) and where it goes ("auto" | "below" | "above"); None while there is no box.
static INPUT_ANCHOR: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);

/// Puts the send box next to the window `label`: its width, its height of 46 points (46 pixels times the scale of the monitor: a Retina screen has twice the pixels),
/// its place by placement::send_box inside the monitor the window is on.
fn place_input(app: &AppHandle, label: &str, place: &str) -> Result<(), String> {
    let w = app.get_webview_window("input").ok_or("no input window")?;
    let anchor = app.get_webview_window(label).ok_or("no such window")?;
    let e = |e: tauri::Error| e.to_string();
    let pos = anchor.outer_position().map_err(e)?;
    let size = anchor.outer_size().map_err(e)?;
    let (area, scale) = monitor_at(&anchor, pos.x + size.width as i32 / 2, pos.y + size.height as i32 / 2);
    let box_w = size.width.max(200);
    let box_h = ((46.0 * scale).round() as u32).max(46);
    let (bx, by) = placement::send_box(area, place, pos.x, pos.y, pos.y + size.height as i32, box_w as i32, box_h as i32, 2);
    w.set_position(tauri::PhysicalPosition::new(bx, by)).map_err(e)?;
    w.set_size(tauri::PhysicalSize::new(box_w, box_h)).map_err(e)?;
    Ok(())
}

/// Presses Ctrl+V in the window that has the keyboard.
#[tauri::command(async)]
fn send_paste() -> bool {
    win::send_ctrl_v()
}

/// Gives the keyboard back to a window (the game), optionally pressing Ctrl+V there.
#[tauri::command(async)]
fn focus_window(hwnd: i64, paste: bool, delay_ms: u64) -> bool {
    let ok = win::set_foreground(hwnd as isize);
    if paste {
        std::thread::sleep(Duration::from_millis(delay_ms.min(2000)));
        return ok && win::send_ctrl_v();
    }
    ok
}

/// The HTTP client, set up the way the Python reader's translator.py ended up after many rounds with Google's key-less endpoint:
///   * HTTP/1.1 only, announced in the TLS handshake (ALPN "http/1.1") - translator.py: "Google's key-less endpoint answers
///     [connections without it] with HTTP 429 on some Python builds"
///   * Google's own hosts: TLS 1.3 at least - translator.py: "a TLS 1.2 handshake [is answered] with HTTP 429 every time"
///   * local servers (LM Studio ...): never through a proxy
/// If this TLS library cannot promise TLS 1.3, the plain client is used instead of failing.
fn http_client(url: &str) -> Result<tauri_plugin_http::reqwest::Client, String> {
    use tauri_plugin_http::reqwest;
    let host = reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())).unwrap_or_default();
    let local = host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.starts_with("192.168.") || host.starts_with("10.");
    let base = || {
        let b = reqwest::Client::builder().timeout(Duration::from_secs(30)).http1_only();
        if local { b.no_proxy() } else { b }
    };
    if host.ends_with(".googleapis.com") {
        if let Ok(client) = base().min_tls_version(reqwest::tls::Version::TLS_1_3).build() {
            return Ok(client);
        }
    }
    base().build().map_err(|e| e.to_string())
}

/// A plain HTTP request made by the exe: exactly the headers the page gives, nothing added (no Origin header).
/// -> { status, body }
#[tauri::command]
async fn http_request(url: String, method: Option<String>, headers: Option<Vec<(String, String)>>, body: Option<String>, timeout: Option<f64>) -> Result<Value, String> {
    use tauri_plugin_http::reqwest;
    let method = reqwest::Method::from_bytes(method.unwrap_or_else(|| "GET".into()).as_bytes()).map_err(|e| e.to_string())?;
    let client = http_client(&url)?;
    let mut req = client.request(method, url.as_str());
    for (name, value) in headers.unwrap_or_default() {
        req = req.header(name.as_str(), value.as_str());
    }
    if let Some(body) = body {
        req = req.body(body);
    }
    // seconds for the whole request (the JS side also gives up a little later by itself)
    if let Some(t) = timeout {
        if t > 0.0 {
            req = req.timeout(std::time::Duration::from_secs_f64(t));
        }
    }
    let describe = |e: reqwest::Error| if e.is_timeout() { "timed out".to_string() } else { format!("{e}") };
    let res = req.send().await.map_err(describe)?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(describe)?;
    Ok(json!({ "status": status, "body": text }))
}

// ---- files: every path is relative to the program folder and cannot leave it (files.rs)

/// Text of a file, null when it does not exist.
#[tauri::command(async)]
fn fs_read(path: String) -> Result<Option<String>, String> {
    files::read_text(&base_dir(), &path)
}

/// Writes a whole file (the old one is replaced only when the new one is complete).
#[tauri::command(async)]
fn fs_write(path: String, text: String) -> Result<(), String> {
    files::write_text(&base_dir(), &path, &text)
}

#[tauri::command(async)]
fn fs_append(path: String, text: String) -> Result<(), String> {
    files::append_text(&base_dir(), &path, &text)
}

/// "file" | "dir" | "" (not there)
#[tauri::command(async)]
fn fs_kind(path: String) -> Result<String, String> {
    files::kind(&base_dir(), &path).map(|k| k.to_string())
}

/// Every program that has a sound session now (pid, role, device, peak). Runs off the UI thread: it samples for ~0.2 s.
#[tauri::command]
async fn audio_apps() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(audio::list_sessions).await.map_err(|e| e.to_string())?
}

// ---- extension tools (ext.rs): files only inside extensions/<name>/

#[tauri::command]
async fn ext_download(app: AppHandle, id: String, url: String, dest: String, sha256: Option<String>) -> Result<Value, String> {
    ext::download(app, base_dir(), id, url, dest, sha256).await
}

#[tauri::command]
fn ext_cancel(id: String) {
    ext::cancel(&id);
}

#[tauri::command(async)]
fn ext_run(app: AppHandle, id: String, exe: String, args: Option<Vec<String>>) -> Result<Value, String> {
    ext::run(app, base_dir(), id, exe, args.unwrap_or_default())
}

#[tauri::command(async)]
fn ext_stdin(id: String, text: String, close: Option<bool>) -> Result<(), String> {
    ext::write_stdin(&id, text.as_bytes(), close.unwrap_or(false))
}

#[tauri::command(async)]
fn ext_kill(id: String) {
    ext::kill(&id);
}

#[tauri::command]
fn ext_running(id: String) -> bool {
    ext::is_running(&id)
}

#[tauri::command(async)]
fn ext_remove(path: String) -> Result<(), String> {
    ext::remove(&base_dir(), &path)
}

/// Starts listening to the chosen program's sound and writes it (16 kHz mono PCM) to the running extension program `id` (capture.rs).
#[tauri::command(async)]
fn capture_start(app: AppHandle, id: String, options: Value) -> Result<Value, String> {
    capture::start(app, id, options)
}

#[tauri::command]
fn capture_stop(id: String) {
    capture::stop(&id);
}

/// Which system this is ("windows" | "macos"): a few things are done differently on macOS.
#[tauri::command]
fn os_kind() -> &'static str {
    if cfg!(target_os = "macos") { "macos" } else if cfg!(windows) { "windows" } else { "other" }
}

/// The version of macOS ("14.5"), "" elsewhere. (The voice recognition needs 13 or later.)
#[tauri::command]
fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(o) = std::process::Command::new("sw_vers").arg("-productVersion").output() {
            return String::from_utf8_lossy(&o.stdout).trim().to_string();
        }
    }
    String::new()
}

/// Waits `ms` milliseconds and answers. The wait is done here, not by a timer of the page: macOS slows the timers of a page that is not in front
/// (the screen reading waits between two looks).
#[tauri::command]
async fn sleep_ms(ms: u64) {
    let ms = ms.min(10_000);
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await;
}

/// Plain loopback of one output device (by name), for comparison with the single-program capture.
#[tauri::command]
async fn audio_probe_device(device: String, seconds: Option<f64>, save: Option<bool>) -> Result<Value, String> {
    let (secs, save) = (seconds.unwrap_or(4.0), save.unwrap_or(true));
    tauri::async_runtime::spawn_blocking(move || audio::probe_device(&device, secs, save)).await.map_err(|e| e.to_string())?
}

/// Tries to capture only one program's sound (process loopback) for a few seconds and reports the levels.
#[tauri::command]
async fn audio_probe(pid: u32, seconds: Option<f64>, save: Option<bool>, full: Option<bool>, device: Option<String>) -> Result<Value, String> {
    let (secs, save, full, device) = (seconds.unwrap_or(4.0), save.unwrap_or(true), full.unwrap_or(false), device.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || audio::probe(pid, secs, save, full, &device)).await.map_err(|e| e.to_string())?
}

/// Names in a folder; a folder's name ends with "/".
#[tauri::command(async)]
fn fs_list(path: String) -> Result<Vec<String>, String> {
    files::list(&base_dir(), &path)
}

#[tauri::command(async)]
fn fs_mkdir(path: String) -> Result<(), String> {
    files::make_dir(&base_dir(), &path)
}

/// Puts a file or folder of an earlier version into old_version_backup/ (never anywhere else, never the user's data: files.rs).
#[tauri::command(async)]
fn fs_move(from: String, to: String) -> Result<(), String> {
    files::move_to_backup(&base_dir(), &from, &to)
}

/// Starts the program again (after the files of an earlier version were put away): a new process that waits a moment first (main), and this
/// one ends at once. (Tauri's own restart starts the new one while this one still holds the "already running" mark.)
#[tauri::command]
fn restart_app(app: AppHandle) {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).env(RESTART_ENV, "1").spawn();
    }
    app.exit(0);
}

/// Deletes one file (never a folder).
#[tauri::command(async)]
fn fs_remove(path: String) -> Result<(), String> {
    files::remove_file(&base_dir(), &path)
}

/// The fonts installed in Windows.
#[tauri::command(async)]
fn system_fonts() -> Vec<String> {
    win::installed_fonts()
}

struct TrayItems(tauri::menu::MenuItem<tauri::Wry>, tauri::menu::MenuItem<tauri::Wry>);

/// The texts of the tray menu follow the display language.
#[tauri::command]
fn set_tray_text(app: AppHandle, options: String, quit: String) -> Result<(), String> {
    let items = app.try_state::<TrayItems>().ok_or("no tray")?;
    items.0.set_text(options).map_err(|e| e.to_string())?;
    items.1.set_text(quit).map_err(|e| e.to_string())
}

/// The icon in the notification area: the windows have no taskbar buttons, so this is the way to the options and out.
fn make_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    let options = MenuItem::with_id(app, "options", "옵션", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&options, &quit])?;
    app.manage(TrayItems(options, quit));
    // the program icon; when it cannot be read, a plain blue square, so that there is always something to click
    let icon = match app.default_window_icon() {
        Some(i) => i.clone(),
        None => tauri::image::Image::new_owned([0x3a, 0x7b, 0xd5, 0xff].repeat(16 * 16), 16, 16),
    };
    TrayIconBuilder::with_id("cmr")
        .icon(icon)
        .tooltip("ChatMatrix")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "options" => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_options(h).await;
                });
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// The label of the window each wheel zone belongs to (macOS tells the turns to the window as they come: the event 'wheel-turn').
static WHEEL_LABELS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<isize, String>>> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// A translation window asks for the wheel turns over it while the mouse goes through it; see win.rs.
#[tauri::command]
fn wheel_zone(window: WebviewWindow, on: bool, usable: Option<bool>, down: Option<bool>) -> Result<(), String> {
    if on { if let Ok(mut m) = WHEEL_LABELS.lock() { m.insert(hwnd_of(&window)?, window.label().to_string()); } }       // (macOS: who gets the turns at once, see set_wheel_sink)
    if !win::wheel_zone(hwnd_of(&window)?, on, usable.unwrap_or(false), down.unwrap_or(false)) {
        return Err("the wheel cannot be taken yet (macOS: the permissions Accessibility / Input Monitoring)".into());
    }
    Ok(())
}

/// The wheel turns told to this window after number `seq` -> { seq, delta: [..] }
#[tauri::command]
fn wheel_since(window: WebviewWindow, seq: u64) -> Result<Value, String> {
    let (newest, delta) = win::wheel_since(hwnd_of(&window)?, seq);
    Ok(json!({ "seq": newest, "delta": delta }))
}

/// Asks the program to end: the hub saves what is unsaved and then calls quit_app. When the hub does not answer, the program ends anyway.
fn request_quit(app: &AppHandle) {
    use tauri::Emitter;
    let _ = app.emit("quit-request", ());
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2500));
        h.exit(0);
    });
}

/// Did Ctrl+Alt+O (the options from anywhere) get registered?
#[tauri::command]
fn options_hotkey_ok() -> bool {
    HOTKEY_OK.load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
fn quit_request(app: AppHandle) {
    request_quit(&app);
}

/// Ends the program (the tray menu, "quit with the game").
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Window mode "just above the game, behind everything else": the game window becomes the owner of this window (0 = none).
/// A click on a window that is neither "always on top" nor "above the game": it comes up over the other windows like any window would.
#[tauri::command]
fn raise_top(window: WebviewWindow) -> Result<(), String> {
    win::raise_top(hwnd_of(&window)?);
    Ok(())
}

/// Brings this window to the front and gives it the keyboard (the options window after it was shown: the program is not the one in front then,
/// and a window that is shown behind the program in front stays behind it).
#[tauri::command]
fn raise_self(window: WebviewWindow) -> Result<(), String> {
    win::grab_focus(hwnd_of(&window)?);
    Ok(())
}

/// Topmost on / off for this window by the system call itself (see win::set_topmost).
#[tauri::command]
fn set_topmost(window: WebviewWindow, on: bool, game: Option<i64>) -> Result<(), String> {
    win::set_topmost(hwnd_of(&window)?, on, game.unwrap_or(0) as isize);
    Ok(())
}

/// "Just above the game": this window is put directly above the game window (see win::place_above).
#[tauri::command]
fn place_above(window: WebviewWindow, game: i64) -> Result<(), String> {
    win::place_above(hwnd_of(&window)?, game as isize);
    Ok(())
}

#[tauri::command]
fn set_owner(window: WebviewWindow, owner: i64) -> Result<(), String> {
    win::set_owner(hwnd_of(&window)?, owner as isize);
    Ok(())
}

#[tauri::command]
fn app_folder() -> String {
    app_dir().display().to_string()
}

/// Opens a web page in the user's browser. Only the project's own GitHub pages and the official places of the voice recognition (the model
/// repository, whisper.cpp, OpenAI Whisper) are allowed: the address is checked here, whatever the web view asks for.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    const ALLOWED: [&str; 4] = [
        "https://github.com/blackmass/ChatMatrixReader",
        "https://huggingface.co/ggerganov/whisper.cpp",
        "https://github.com/ggml-org/whisper.cpp",
        "https://github.com/openai/whisper",
    ];
    let listed = ALLOWED.iter().any(|a| url == *a || url.strip_prefix(a).is_some_and(|rest| rest.starts_with('/')));
    if !listed || url.chars().any(|c| c.is_control() || c == ' ' || c == '"' || c == '&' || c == '^') {
        return Err("address not allowed".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).creation_flags(0x0800_0000).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?; }
    #[cfg(all(unix, not(target_os = "macos")))]
    { std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?; }
    Ok(())
}

// ---------------------------------------------------------------------------------------------- start

/// Set by restart_app: the program was started by the previous one that is ending right now.
const RESTART_ENV: &str = "CMR_RESTARTED";

fn main() {
    if std::env::var_os(RESTART_ENV).is_some() {
        std::env::remove_var(RESTART_ENV);
        std::thread::sleep(Duration::from_millis(2500));           // (until the old process has ended and let go of its "already running" mark)
    }
    if !win::first_instance() {
        win::message("ChatMatrix", "ChatMatrix가 이미 실행 중입니다. 화면 오른쪽 아래 알림 영역(트레이)의 아이콘에서 옵션을 열 수 있습니다.\n\nChatMatrix is already running. Use its icon in the notification area (tray).");
        return;
    }
    #[cfg(target_os = "macos")]
    {
        win::configure(&base_dir());
        win::keep_awake();
    }
    win::start_wheel_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        // (tauri_plugin_http::init() is NOT started: the plugin keeps a cookie file in AppData\Local\<identifier>. Only its re-exported
        //  reqwest client is used, by http_request below, and that writes nothing to disk)
        .register_uri_scheme_protocol("cmr", |_ctx, request| {
            serve(request.uri().path().trim_start_matches('/'))
        })
        .register_uri_scheme_protocol("cmrplug", |_ctx, request| {
            serve_plugin(request.uri().path().trim_start_matches('/'))
        })
        .invoke_handler(tauri::generate_handler![
            plugin_token,
            plugin_forget,
            plugin_hash,
            plugin_fetch,
            capture_start,
            capture_stop,
            os_kind,
            os_version,
            sleep_ms,
            os_state,
            screen_rect,
            find_game,
            capture,
            set_noactivate,
            set_blur,
            open_overlay,
            open_options,
            open_url,
            set_window_rect,
            close_overlay,
            show_input,
            focus_window,
            send_paste,
            http_request,
            fs_read,
            fs_write,
            fs_append,
            fs_kind,
            fs_list,
            audio_apps,
            audio_probe,
            audio_probe_device,
            ext_download,
            ext_cancel,
            ext_run,
            ext_stdin,
            ext_kill,
            ext_running,
            ext_remove,
            fs_mkdir,
            fs_remove,
            fs_move,
            restart_app,
            popup_open,
            popup_place,
            popup_follow,
            popup_hide,
            popup_close,
            app_folder,
            quit_app,
            quit_request,
            options_hotkey_ok,
            wheel_zone,
            wheel_since,
            system_fonts,
            set_tray_text,
            set_owner,
            place_above,
            raise_self,
            raise_top,
            set_topmost
        ])
        .on_window_event(|window, event| {
            // the window the send box belongs to was moved or got another size: the box (if it is open) goes with it
            if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                let anchor = INPUT_ANCHOR.lock().ok().and_then(|a| a.clone());
                if let Some((label, place)) = anchor {
                    if window.label() == label {
                        let app = window.app_handle();
                        if app.get_webview_window("input").map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false) { let _ = place_input(app, &label, &place); }
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // closing the control window or the main translation window ends the program (the other translation windows only close themselves)
                    "control" | "main" => { api.prevent_close(); request_quit(window.app_handle()); }
                    // the window of the earlier-version files: closing it is "cancel" = the program ends (nothing else is running yet)
                    "legacy" => window.app_handle().exit(0),
                    // the options window: its place and size are told to the program at the moment it closes (the page only tells them after the window
                    // stood still for a while, so a window moved and closed with the X a moment later would be forgotten)
                    "options" => {
                        use tauri::Emitter;
                        if let (Ok(p), Ok(s)) = (window.outer_position(), window.outer_size()) {
                            if p.x > -30000 && s.width >= 200 {
                                let _ = window.app_handle().emit("options-geometry", json!({ "geometry": format!("{}x{}+{}+{}", s.width, s.height, p.x, p.y) }));
                            }
                        }
                    }
                    _ => {}
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            {
                // a wheel turn the exe took for a window goes to that window at once (the page scrolls as the fingers move, not once in 0.1 s)
                use tauri::Emitter;
                let h2 = handle.clone();
                win::set_wheel_sink(move |hwnd, units| {
                    let label = WHEEL_LABELS.lock().ok().and_then(|m| m.get(&hwnd).cloned());
                    if let Some(label) = label { let _ = h2.emit_to(label.as_str(), "wheel-turn", units); }
                });
            }
            if legacy_present() {
                make_window(&handle, "legacy", "legacy.html", "legacy")?;
                return Ok(());
            }
            make_window(&handle, "control", "control.html", "control")?;
            make_window(&handle, "main", "overlay.html", "overlay")?;
            make_window(&handle, "input", "input.html", "input")?;
            make_tray(app)?;
            let h = handle.clone();
            let open = move || {
                let h = h.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_options(h).await;
                });
            };
            #[cfg(windows)]
            let ok = win::start_options_hotkey(open);
            #[cfg(target_os = "macos")]
            let ok = {
                // (the system's own hot key service: no permission is asked for it)
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let key = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyO);
                app.global_shortcut().on_shortcut(key, move |_app, _shortcut, event| { if event.state() == ShortcutState::Pressed { open(); } }).is_ok()
            };
            HOTKEY_OK.store(ok, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
