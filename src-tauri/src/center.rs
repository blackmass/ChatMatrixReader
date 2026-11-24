//! The control centers (3.2): THREE transparent windows over all the screens, one for each kind of order of the translation windows (0 ordinary, 1 always on top, 2 above the game
//! only: treated like always on top while the game or a window of ours is in front, else right above the game), each drawing the translation windows that belong to it (panes) in its
//! page (center.html). A center takes the mouse only while the pointer is over one of its panes (read here, 60 times a second, from the system); the rest of it lets the mouse go
//! through to the game. The translation windows are only panes of these centers: there is no window of the system for each of them.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::{hwnd_of, make_window, win};

#[derive(Clone, Debug)]
pub struct Pane { id: String, x: f64, y: f64, w: f64, h: f64, bar: f64, below: bool, hit: bool, blur: u32, web: String, z: i64 }             // (the place of a pane in screen pixels, the bar above its text included; `bar`: the height of the bar; `hit`: it takes the mouse: a window that is click-through only has a place)

static RECTS: LazyLock<Mutex<HashMap<String, Vec<Pane>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static LOCK: Mutex<Option<String>> = Mutex::new(None);                    // the center that holds the mouse while a button is down

const MODES: [(&str, u32); 3] = [("center0", 0), ("center1", 1), ("center2", 2)];

/// The screens now: (each one as [x, y, w, h] in pixels, the main screen first) and the rectangle of all together [l, t, r, b]. None: not known.
fn screens(app: &AppHandle) -> Option<(Vec<[i32; 4]>, [i32; 4])> {
    let (mut l, mut t, mut r, mut b) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    let primary = app.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y));
    let mut list: Vec<[i32; 4]> = Vec::new();
    for m in app.available_monitors().unwrap_or_default() {
        let (p, s) = (m.position(), m.size());
        l = l.min(p.x); t = t.min(p.y); r = r.max(p.x + s.width as i32); b = b.max(p.y + s.height as i32);
        let one = [p.x, p.y, s.width as i32, s.height as i32];
        if primary == Some((p.x, p.y)) { list.insert(0, one); } else { list.push(one); }
    }
    if l == i32::MAX { None } else { Some((list, [l, t, r, b])) }
}
/// What the centers cover now (the screens and their rectangle); the loop of `run` looks again every 2 s.
static SCREENS: Mutex<Option<(Vec<[i32; 4]>, [i32; 4])>> = Mutex::new(None);

/// The work areas of the screens (what the menu bar, the dock or the task bar leave), in the order of `screens`: where a window that has no place of its own may first appear.
fn works(app: &AppHandle) -> Vec<[i32; 4]> {
    let primary = app.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y));
    let mut list: Vec<[i32; 4]> = Vec::new();
    for m in app.available_monitors().unwrap_or_default() {
        let a = m.work_area();
        let one = [a.position.x, a.position.y, a.size.width as i32, a.size.height as i32];
        if primary == Some((m.position().x, m.position().y)) { list.insert(0, one); } else { list.push(one); }
    }
    list
}

fn layout_payload(app: &AppHandle, s: &(Vec<[i32; 4]>, [i32; 4])) -> Value { json!({ "origin": [s.1[0], s.1[1]], "monitors": s.0, "work": works(app) }) }

/// The screens (for a page that starts after the change was told): { origin: [x, y], monitors: [[x, y, w, h], ..], work: [[x, y, w, h], ..] } (the main screen first; `work` = without the menu bar and the like).
#[tauri::command]
pub async fn center_layout(app: AppHandle) -> Result<Value, String> {
    Ok(SCREENS.lock().ok().and_then(|s| s.as_ref().map(|s| layout_payload(&app, s))).unwrap_or(Value::Null))
}

/// The size of everything in a center: `scale` 0 = as big as on the main screen (what the system says), else the factor wanted (1.25 = 125%). The page is zoomed so that one pixel of the page
/// is `scale` pixels of the screen. -> the scale in force.
#[tauri::command]
pub async fn center_zoom(app: AppHandle, label: String, scale: f64) -> Result<f64, String> {
    let w = app.get_webview_window(&label).ok_or("no such window")?;
    let own = w.scale_factor().unwrap_or(1.0).max(0.1);                        // (what the system thinks of the screen this window stands on)
    let want = if scale >= 0.5 { scale } else { app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(own) };
    w.set_zoom(want / own).map_err(|e| e.to_string())?;
    Ok(want)
}

/// The centers whose page has said that it is ready (center_ready): its settings are read, it is zoomed, it has drawn its windows. A center is shown only when all three are (see start).
static READY: LazyLock<Mutex<std::collections::HashSet<String>>> = LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));
#[tauri::command]
pub async fn center_ready(label: String) -> Result<(), String> {
    if MODES.iter().any(|(l, _)| *l == label) { if let Ok(mut r) = READY.lock() { r.insert(label); } }
    Ok(())
}

/// Makes the three centers (a few seconds after the start) and runs the loop that serves them. The centers are made HIDDEN: a transparent window over all the screens that is shown before its page
/// has drawn anything (or while its order and its style are still being set) shows a frame or two of the default background / a redraw over every screen. They are shown together when all three pages
/// are ready and the loop has set their order (a little time more), or after FALLBACK at the latest (a page that never says it is ready must not leave the program without its windows).
/// (macOS: shown at once as before: a page of a hidden window is slowed down there, and nothing has been seen of this problem.)
pub fn start(app: AppHandle) {
    { let a = app.clone(); std::thread::spawn(move || focus_watch(a)); }          // (the detailed log "focus": from the start of the program, before the centers are there)
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(3000))).await;
        // the rectangle of all the screens together (physical pixels)
        let Some((monitors, [l, t, r, b])) = screens(&app) else { crate::startup_log("centers: no screens found"); return };
        crate::startup_log(&format!("centers: screens {:?}", monitors));
        if let Ok(mut s) = SCREENS.lock() { *s = Some((monitors, [l, t, r, b])); }
        for (label, mode) in MODES {
            let page = format!("center.html?mode={mode}&ox={l}&oy={t}");
            let made = make_window(&app, label, &page, "center");
            crate::startup_log(&format!("{label} {}", if made.is_ok() { "made" } else { "FAILED" }));
            if let Ok(w) = made {
                let _ = w.set_position(tauri::PhysicalPosition::new(l, t));
                let _ = w.set_size(tauri::PhysicalSize::new((r - l) as u32, (b - t) as u32));
                let _ = w.set_ignore_cursor_events(true);
                if let Ok(h) = hwnd_of(&w) { win::make_no_key(h); win::set_noactivate_light(h, true); win::set_not_rude(h); }
                if cfg!(target_os = "macos") { let _ = w.show(); }
            }
        }
        let app2 = app.clone();
        std::thread::spawn(move || run(app2));
        if cfg!(target_os = "macos") { return; }
        // wait for the three pages (the loop works on the hidden windows meanwhile: order, style), then show them all
        const FALLBACK: Duration = Duration::from_millis(6000);
        const SETTLE: Duration = Duration::from_millis(400);
        let t0 = Instant::now();
        let ready_at = loop {
            let n = READY.lock().map(|r| r.len()).unwrap_or(0);
            if n >= MODES.len() { break Some(t0.elapsed()); }
            if t0.elapsed() >= FALLBACK { break None; }
            let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(30))).await;
        };
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(SETTLE)).await;
        // shown with the transparency at 0, then brought up after the pages have had time to draw their first frame (a window that comes up may show its default background for a frame or two: it is not
        // seen when nothing of the window is)
        let mut hwnds: Vec<isize> = Vec::new();
        for (label, _) in MODES {
            if let Some(w) = app.get_webview_window(label) {
                if let Ok(h) = hwnd_of(&w) { win::set_alpha(h, 0.0); hwnds.push(h); }
                // (the window library's show(): the library keeps its own idea of whether a window is shown, and hides a window it thinks is hidden at the next change of a flag of the window, such as when
                // the mouse comes over a pane. The center is not owned yet while it is shown: it is put in its place and owned after, see the loop)
                let _ = w.show();
            }
        }
        let shown_ms = t0.elapsed().as_millis();
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(350))).await;
        for step in 1..=10 { for h in &hwnds { win::set_alpha(*h, step as f64 / 10.0); } let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(20))).await; }
        let ready: Vec<String> = READY.lock().map(|r| { let mut v: Vec<String> = r.iter().cloned().collect(); v.sort(); v }).unwrap_or_default();
        match ready_at {
            Some(t) => crate::startup_log(&format!("centers: ready after {} ms, shown (transparent) after {} ms, solid after {} ms", t.as_millis(), shown_ms, t0.elapsed().as_millis())),
            None => crate::startup_log(&format!("centers: NOT all ready after {} ms ({:?}): shown anyway (transparent after {} ms, solid after {} ms)", FALLBACK.as_millis(), ready, shown_ms, t0.elapsed().as_millis())),
        }
    });
}

/// The panes of a center (its page tells them whenever they change). `panes`: [{ id, x, y, w, h }] in pixels inside the window of the center; where the window really is gets added here
/// (on macOS it may stand lower than asked, under the menu bar).
#[tauri::command]
pub async fn center_rects(app: AppHandle, label: String, panes: Value, wheel: Option<Value>) -> Result<bool, String> {
    let (ox, oy) = app.get_webview_window(&label).and_then(|w| w.outer_position().ok()).map(|p| (p.x as f64, p.y as f64)).unwrap_or((0.0, 0.0));
    let f = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let list: Vec<Pane> = panes.as_array().map(|a| a.iter().map(|v| Pane {
        id: v.get("id").and_then(|x| x.as_str()).unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric()).collect(),
        x: f(v, "x") + ox, y: f(v, "y") + oy, w: f(v, "w"), h: f(v, "h"), bar: f(v, "bar"), below: v.get("below").and_then(|x| x.as_bool()).unwrap_or(false), hit: v.get("hit").and_then(|x| x.as_bool()).unwrap_or(true), blur: v.get("blur").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        web: v.get("web").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        z: v.get("z").and_then(|x| x.as_i64()).unwrap_or(0),
    }).filter(|p| !p.id.is_empty()).collect()).unwrap_or_default();
    sync_blur(&app, &label, &list);
    sync_webs(&app, &label, &list);
    if let Ok(mut r) = RECTS.lock() { r.insert(label.clone(), list); }
    crate::refollow_input(&app);                                            // (the send box follows its window)
    // the places where the wheel is taken from the game (the windows that are click-through): { id, x, y, w, h } like the panes
    let idx = MODES.iter().position(|(l, _)| *l == label).unwrap_or(0) as isize;
    let zones: Vec<(isize, [f64; 4])> = wheel.as_ref().and_then(|w| w.as_array()).map(|a| a.iter().filter_map(|v| {
        let id: isize = v.get("id").and_then(|x| x.as_str())?.parse().ok()?;
        Some((wheel_key(idx, id), [f(v, "x") + ox, f(v, "y") + oy, f(v, "x") + ox + f(v, "w"), f(v, "y") + oy + f(v, "h")]))
    }).collect()).unwrap_or_default();
    if let Some(w) = app.get_webview_window(&label) { if let Ok(h) = hwnd_of(&w) { win::set_center_hwnd(idx, h); } }          // (the wheel is not taken where a window of another program stands over the center)
    Ok(win::set_pane_zones(idx, zones))
}

/// The blur windows of the panes (the option "블러"): one empty transparent window for each pane that has it, the size of its text area, directly under its center (see `run`);
/// the system blurs what is behind it. key: its label -> (the center's label, the level, its handle, where it is, since when its blur is off for the moment).
/// (Windows) A window whose pane has no blur for a moment (the mouse clears the window, it is resized) is NOT closed: only the blur is taken off, and put on again when the pane wants it. A window that is
/// made again every time came up over its center for a moment (the system puts a new window at the top) and took a moment to load: the blur and the text flickered twice. It is closed when the pane
/// is gone, or when the blur has been off for BLUR_KEEP (the option is off for good: no empty web view is kept).
static BLURS: LazyLock<Mutex<HashMap<String, (String, u32, isize, [i32; 4], Option<Instant>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
const BLUR_KEEP: Duration = Duration::from_secs(30);
/// The blur windows whose page has just been loaded (main.rs tells): the loop asks the system for their blur once more (the web view starts after the window is made, and what it does can undo
/// what was asked before). Only a label is put here and taken out again: no window is asked while this list is held.
static BLUR_READY: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
pub fn blur_page_ready(label: &str) { if let Ok(mut v) = BLUR_READY.lock() { if !v.iter().any(|x| x == label) { v.push(label.to_string()); } } }

fn sync_blur(app: &AppHandle, center: &str, panes: &[Pane]) {
    let key = |id: &str| format!("blur_{}_{}", center, id);
    let present: std::collections::HashSet<String> = panes.iter().map(|p| key(&p.id)).collect();
    let want: HashMap<String, (u32, [i32; 4])> = panes.iter().filter(|p| p.blur > 0).map(|p| (
        key(&p.id),
        (p.blur, [p.x.round() as i32, (p.y + if p.below { 0.0 } else { p.bar }).round() as i32, p.w.round().max(1.0) as i32, (p.h - p.bar).round().max(1.0) as i32]),
    )).collect();
    let mut have = match BLURS.lock() { Ok(h) => h, Err(_) => return };
    // the windows of this center whose pane has no blur at the moment
    let none: Vec<(String, Option<Instant>)> = have.iter().filter(|(k, v)| v.0 == center && !want.contains_key(*k)).map(|(k, v)| (k.clone(), v.4)).collect();
    for (k, since) in none {
        let close = !cfg!(windows) || !present.contains(&k) || since.map_or(false, |t| t.elapsed() > BLUR_KEEP);
        if close { have.remove(&k); if let Some(w) = app.get_webview_window(&k) { let _ = w.destroy(); } continue; }
        if since.is_none() {                                                       // (the blur goes, the window stays where it is)
            if let Some(v) = have.get_mut(&k) { v.4 = Some(Instant::now()); blur_apply(v.2, &k, "the pane has no blur for the moment: the blur goes, the window stays", false, v.1); }
        }
    }
    for (k, (level, r)) in want {
        let known = have.get(&k).cloned();
        let w = match app.get_webview_window(&k) {
            Some(w) => w,
            None => match make_window(app, &k, "blur.html", "blur") { Ok(w) => w, Err(_) => continue },
        };
        let Ok(h) = hwnd_of(&w) else { continue };
        if known.as_ref().map_or(true, |v| v.3 != r) {
            // (the size first, the place after: a window on macOS grows from its lower left corner, so a window that is made larger after it was put at its place ends up higher than it; a web window is put the same way, see set_outer)
            let _ = w.set_size(tauri::PhysicalSize::new(r[2] as u32, r[3] as u32));
            let _ = w.set_position(tauri::PhysicalPosition::new(r[0], r[1]));
        }
        if known.is_none() {
            let _ = w.set_ignore_cursor_events(true);
            win::make_no_key(h); win::set_noactivate_light(h, true); win::set_not_rude(h);
            // (no order guard, unlike a web window: nobody presses a blur window, and the guard would refuse what the loop asks of it, the top of a band or a place over the game: it is the center's
            // backdrop and is put in the state of the center, like the center)
            #[cfg(windows)]
            win::no_transitions(h);                       // (the blur goes at once with the text: the system fades a window that is hidden or closed)
        }
        let woke = known.as_ref().map_or(false, |v| v.4.is_some());                 // (it was kept with its blur off: on again, nothing is made)
        if known.is_none() {
            // shown and put directly under its center in one call (a window that is shown is put at the top by the system: over the text for a moment). (The window library does not know it is shown: its
            // calls that change a flag of the window hide it, so none is made for a blur window after this: the one that makes it click-through is above, before it is shown.)
            #[cfg(windows)]
            { match app.get_webview_window(center).and_then(|c| hwnd_of(&c).ok()) { Some(ch) => win::show_below(h, ch), None => { let _ = w.show(); } } }
            #[cfg(not(windows))]
            { let _ = w.show(); }
        }
        // (the blur is asked for AFTER the window is shown: asked of a window that is not shown, the system answers yes and does not draw it until the window is put somewhere else. A new window is asked
        // once more when its page has loaded: see blur_page_ready)
        if known.as_ref().map_or(true, |v| v.1 != level) || woke {
            let why = match &known { None => "a new window, shown".to_string(), Some(v) if woke => format!("the blur is on again (level {})", v.1), Some(v) => format!("the level goes from {} to {}", v.1, level) };
            blur_apply(h, &k, &why, true, level);
        }
        have.insert(k, (center.to_string(), level, h, r, None));
    }
}

/// The web windows that follow a center: the window of the system of a web window (webwin.rs) is where its page is drawn by the center (a box with `web`), directly under the center, so
/// that the bar and the strips of the center take the mouse and the page the rest. label -> (the center, where it is: x, y, w, h in pixels).
/// The order the windows of a center were put in last time, and when it was last put right (a window of the system is put again only when the order wanted changed, or the system's order is found
/// wrong again after a while: putting it again at every round made the pages flicker on macOS).
static ORDER: LazyLock<Mutex<HashMap<String, (Vec<isize>, Option<std::time::Instant>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// What the system said of the order of the web windows of a center at the last look (their labels, from the front), a different order that is waiting to be believed (since when), and when the
/// windows were last put by us. A page that is pressed is brought to the front by the system itself: that order is then what the user wants (see the loop).
static OBSERVED: LazyLock<Mutex<HashMap<String, (Vec<String>, Option<(Vec<String>, Instant)>, Option<Instant>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static WEBS: LazyLock<Mutex<HashMap<String, (String, [i32; 4], i64)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn sync_webs(app: &AppHandle, center: &str, panes: &[Pane]) {
    let now: HashMap<String, ([i32; 4], i64)> = panes.iter().filter(|p| !p.web.is_empty()).map(|p| (p.web.clone(), ([p.x.round() as i32, p.y.round() as i32, p.w.round().max(1.0) as i32, p.h.round().max(1.0) as i32], p.z))).collect();
    // (the list is only read and written here: the windows of the system are asked after the lock is let go. A call to a window can wait for the main thread, and the main thread may be waiting for
    // this list: that was a program that stopped on the Mac)
    let mut moves: Vec<(String, [i32; 4])> = Vec::new();
    {
        let Ok(mut webs) = WEBS.lock() else { return };
        webs.retain(|k, v| v.0 != center || now.contains_key(k));
        for (k, (r, z)) in now {
            let changed = webs.get(&k).map_or(true, |v| v.1 != r || v.0 != center);
            webs.insert(k.clone(), (center.to_string(), r, z));
            if changed { moves.push((k, r)); }
        }
    }
    for (k, r) in &moves { if let Some(w) = app.get_webview_window(k) { let _ = crate::webwin::set_outer(&w, Some(r[0]), Some(r[1]), r[2] as u32, r[3] as u32); } }
    // (Windows: a window that was put on a screen of another scale is made larger or smaller by the system a moment after it arrived; it is put right again once, so that the page fills the place the center draws)
    #[cfg(windows)]
    if !moves.is_empty() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            for (k, r) in moves {
                // only a window that has not been moved since (a drag changes the place every few milliseconds: the old place must never be put back over a newer one: the window followed the hand late)
                let still = WEBS.lock().ok().and_then(|m| m.get(&k).map(|v| v.1)) == Some(r);
                if still { if let Some(w) = app2.get_webview_window(&k) { let _ = crate::webwin::set_outer(&w, Some(r[0]), Some(r[1]), r[2] as u32, r[3] as u32); } }
            }
        });
    }
}

/// The title the window of the game has (the setting "와우 창 제목"; the program name is looked at first): told by the center page.
static GAME_TITLE: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new("World of Warcraft".to_string()));
#[tauri::command]
pub async fn center_title(title: String) -> Result<(), String> {
    if let Ok(mut t) = GAME_TITLE.lock() { *t = if title.trim().is_empty() { "World of Warcraft".to_string() } else { title }; }
    Ok(())
}

/// The key of the wheel zone of a pane (negative: a window of the system has a positive handle).
fn wheel_key(idx: isize, id: isize) -> isize { -((idx + 1) * 100000 + id) }
/// The center (its label) and the window id a key belongs to.
pub fn wheel_owner(key: isize) -> Option<(&'static str, isize)> {
    if key >= 0 { return None; }
    let k = -key;
    MODES.get((k / 100000 - 1) as usize).map(|(l, _)| (*l, k % 100000))
}

/// The turns of the wheel taken for the panes of a center after number `seq` (Windows: asked for by the page; macOS tells them one by one, see main.rs) -> { seq, turns: [{ id, delta }] }
#[tauri::command]
pub async fn center_wheel(label: String, seq: u64) -> Result<Value, String> {
    let (newest, list) = win::wheel_since_panes(seq);
    let turns: Vec<Value> = list.into_iter().filter_map(|(key, d)| wheel_owner(key).filter(|(l, _)| *l == label).map(|(_, id)| json!({ "id": id.to_string(), "delta": d }))).collect();
    Ok(json!({ "seq": newest, "turns": turns }))
}

/// A pane of the ordinary center was touched: the center goes to the top of the ordinary windows (what a window of 3.1.1 did when it was touched; ours do not take the focus).
#[tauri::command]
pub async fn center_raise(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label) { if let Ok(h) = hwnd_of(&w) { win::raise_top(h); } }
    Ok(())
}

/// The text area (the bar left out) of the translation window `label` ("main", "win3") in screen pixels: (x, y, w, h). None: the window is not a pane of a center.
pub fn pane_rect(label: &str) -> Option<(i32, i32, u32, u32)> {
    let id = if label == "main" { "1".to_string() } else { label.strip_prefix("win")?.to_string() };
    let rects = RECTS.lock().ok()?;
    for (_, panes) in rects.iter() {
        if let Some(p) = panes.iter().find(|p| p.id == id) { return Some((p.x.round() as i32, (p.y + if p.below { 0.0 } else { p.bar }).round() as i32, p.w.round().max(1.0) as u32, (p.h - p.bar).round().max(1.0) as u32)); }
    }
    None
}

fn inside(panes: &[Pane], x: i32, y: i32, margin: f64) -> bool {
    panes.iter().filter(|p| p.hit).any(|p| (x as f64) >= p.x - margin && (x as f64) < p.x + p.w + margin && (y as f64) >= p.y - margin && (y as f64) < p.y + p.h + margin)
}

/// The order of the windows of a mode: 0 ordinary, 1 always on top, 2 above the game only (two states: the game or a window of ours in front: topmost; another program in front: right above the game).
/// The state a mode asks for now: 0 ordinary, 1 on top, and for the mode over the game: 21 the game is in front, 22 another program is, 23 this one is.
fn mode_state(mode: u32, game: isize) -> u32 {
    match mode {
        1 => 1,
        2 => if game > 0 { let fg = win::foreground(); if fg == game { 21 } else if win::self_front() { 23 } else { 22 } } else { 1 },
        _ => 0,
    }
}

/// Puts a window in the state its mode wants (0 ordinary, 1 on top, 2 over the game: 21 the game is in front, 22 another program is, 23 this one is). Some((was, now)) when the state changed.
#[cfg_attr(windows, allow(dead_code))]
fn apply_mode(h: isize, mode: u32, game: isize, last: &mut HashMap<isize, u32>) -> Option<(u32, u32)> {
    let want = mode_state(mode, game);
    let was = last.get(&h).copied().unwrap_or(99);
    if was == want { return None; }
    last.insert(h, want);
    match want {
        0 => { win::set_owner(h, 0); win::set_topmost(h, false, 0); }
        1 | 21 | 23 => { win::set_owner(h, 0); win::set_topmost(h, true, 0); }                 // (the owner goes first: a window that is owned is not asked to be topmost)
        22 if was == 23 => { win::set_topmost(h, false, game); win::set_owner(h, game); }
        _ => { win::set_owner(h, game); win::set_topmost(h, false, game); }
    }
    Some((was, want))
}

/// The detailed log "focus": which window comes to the front, from the start of the program (a thread of its own: the loop of the centers starts three seconds after the program does).
fn focus_watch(app: AppHandle) {
    let mut last: isize = 0;
    loop {
        let on = crate::debug_on("focus");
        std::thread::sleep(Duration::from_millis(if on { 20 } else { 250 }));          // (off: it only looks now and then whether it was turned on)
        if !on { continue; }
        let fg = win::foreground();
        if fg != last {
            crate::debug_log("focus", &format!("the window in front changes: {} [{}] -> {} [{}]", win::describe(last), our_name(&app, last), win::describe(fg), our_name(&app, fg)));
            last = fg;
        }
    }
}
/// (only for the log) The top of the stack of windows, from the front: our windows by their labels, the others by class and program.
fn stack_names(app: &AppHandle, n: usize) -> Vec<String> {
    win::top_windows(n).into_iter().map(|h| { let o = our_name(app, h); if o == "other" { win::short(h) } else { o } }).collect()
}
/// (only for the log) Which window of this program a handle is: its label ("center2", "blur_center2_1", "web_b1"), "other" when it is not one of the windows of the centers, "-" for none.
fn our_name(app: &AppHandle, h: isize) -> String {
    if h == 0 { return "-".to_string(); }
    for (label, _) in MODES { if let Some(w) = app.get_webview_window(label) { if hwnd_of(&w).ok() == Some(h) { return label.to_string(); } } }
    if let Some(k) = BLURS.lock().ok().and_then(|b| b.iter().find(|(_, v)| v.2 == h).map(|(k, _)| k.clone())) { return k; }
    let keys: Vec<String> = WEBS.lock().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    for k in keys { if let Some(w) = app.get_webview_window(&k) { if hwnd_of(&w).ok() == Some(h) { return k; } } }
    "other".to_string()
}
/// The blur of a window is put on or off (detailed log, area "blur": what was asked and what came back).
fn blur_apply(h: isize, key: &str, why: &str, on: bool, level: u32) {
    let ok = win::set_blur(h, on, if level == 2 { 4 } else { 3 }, 0x1e, 0x1f, 0x22, 0.004);
    if crate::debug_on("blur") { crate::debug_log("blur", &format!("{key}: {why}: asked for {} (level {level}), returned {ok}", if on { "on" } else { "off" })); }
}
/// What the stack of windows looks like for a center, its blur windows and the game: from the front, which of them are topmost, and who owns whom.
fn blur_snapshot(label: &str, since_ms: u128, ch: isize, blurs: &[isize], game: isize) -> String {
    let mut all = vec![ch]; all.extend_from_slice(blurs); if game != 0 { all.push(game); }
    let name = |h: isize| if h == ch { "C".to_string() } else if h == game { "G".to_string() } else { format!("B{}", blurs.iter().position(|b| *b == h).map_or(0, |i| i + 1)) };
    let z: Vec<String> = win::z_order_global(&all).into_iter().map(name).collect();
    let own = |h: isize| { let o = win::owner_of(h); if o == 0 { "-".to_string() } else if o == game { "game".to_string() } else if o == ch { "center".to_string() } else { "other".to_string() } };
    let each: Vec<String> = blurs.iter().enumerate().map(|(i, b)| format!("B{} topmost {} owner {}", i + 1, win::is_topmost(*b), own(*b))).collect();
    format!("{label} +{since_ms} ms: front to back {z:?}; C topmost {} owner {}; {}; in front: {}", win::is_topmost(ch), own(ch), each.join("; "), win::describe(win::foreground()))
}

/// A line of the detailed log, area "order": the order of a center, its blur windows and the game.
fn order_diag(msg: String) { crate::debug_log("order", &msg); }

fn run(app: AppHandle) {
    let mut prev_down = false;                                             // (the left button at the last look, and the window that was in front: only for the detailed log "focus")
    let mut mis: HashMap<String, Instant> = HashMap::new();                // (a center whose blur windows are out of order: since when)
    let mut watch: HashMap<String, (Instant, u8)> = HashMap::new();        // (a center whose state has just changed, and its blur windows are looked at again a moment later: since when, how many looks)
    let mut ignoring: HashMap<&str, bool> = HashMap::new();
    let mut last: HashMap<isize, u32> = HashMap::new();
    let mut z_at = Instant::now() - Duration::from_secs(1);
    let mut game = 0isize;
    let mut game_at = Instant::now() - Duration::from_secs(5);
    let mut screens_at = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(16));
        let (cx, cy) = win::cursor_pos();                                      // (pixels: macOS multiplies its points by the scale of the main screen itself)
        let down = win::key_down(0x01);
        let rects = RECTS.lock().map(|r| r.clone()).unwrap_or_default();
        // which center may take the mouse: the one with a pane under the pointer (the topmost kind first), and the one that holds it while a button is down
        let mut owner: Option<String> = None;
        if let Ok(mut lock) = LOCK.lock() {
            if !down { *lock = None; }
            if let Some(l) = lock.as_ref() { owner = Some(l.clone()); }
            else {
                // the centers that have a pane under the pointer; when more than one has, the one that is in front on the screen (the order of the windows of the system) takes it
                let hit: Vec<&str> = MODES.iter().filter(|(l, _)| rects.get(*l).map_or(false, |p| inside(p, cx, cy, 4.0))).map(|(l, _)| *l).collect();
                owner = match hit.len() {
                    0 => None,
                    1 => Some(hit[0].to_string()),
                    _ => {
                        let hs: Vec<(isize, &str)> = hit.iter().filter_map(|l| app.get_webview_window(l).and_then(|w| hwnd_of(&w).ok()).map(|h| (h, *l))).collect();
                        let order = win::z_order(&hs.iter().map(|(h, _)| *h).collect::<Vec<_>>());
                        order.first().and_then(|f| hs.iter().find(|(h, _)| h == f)).map(|(_, l)| l.to_string()).or_else(|| hit.last().map(|l| l.to_string()))
                    }
                };
                if down { *lock = owner.clone(); }
            }
        }
        for (label, _) in MODES {
            let want_ignore = owner.as_deref() != Some(label);
            if ignoring.get(label).copied() != Some(want_ignore) {
                if let Some(w) = app.get_webview_window(label) { let _ = w.set_ignore_cursor_events(want_ignore); }
                ignoring.insert(label, want_ignore);
            }
        }
        // (the detailed log, area "focus": what comes to the front, and what is under the mouse and has the keyboard when the left button goes down; nothing is done with it)
        if crate::debug_on("focus") {
            let fg = win::foreground();
            if down && !prev_down {
                let under = win::window_at(cx, cy);
                let (active, focus) = win::focus_owner();
                let taking: Vec<&str> = ignoring.iter().filter(|(_, v)| !**v).map(|(k, _)| *k).collect();
                crate::debug_log("focus", &format!("the left button goes down at ({cx}, {cy}): under the cursor {} [{}]; the centers that take the mouse {taking:?}, the owner of the mouse {owner:?}; in front {} [{}]; keyboard: active {} [{}], focus {} [{}]",
                    win::describe(under), our_name(&app, under), win::describe(fg), our_name(&app, fg), win::describe(active), our_name(&app, active), win::describe(focus), our_name(&app, focus)));
            }
        }
        prev_down = down;
        // a blur window whose page has loaded: its blur is asked for once more (what the blur table holds is copied first: no lock is held while the system is asked)
        let ready: Vec<String> = BLUR_READY.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default();
        for k in ready {
            let one = BLURS.lock().ok().and_then(|b| b.get(&k).map(|v| (v.1, v.2, v.4.is_some())));
            if let Some((level, h, off)) = one { if !off { blur_apply(h, &k, "its page has loaded", true, level); } }
        }
        if z_at.elapsed() < Duration::from_millis(100) { continue; }
        z_at = Instant::now();
        if game_at.elapsed() > Duration::from_secs(2) {
            game = win::find_game(game, &GAME_TITLE.lock().map(|t| t.clone()).unwrap_or_else(|_| "World of Warcraft".to_string())).map(|g| g.hwnd).unwrap_or(0);
            game_at = Instant::now();
        }
        // the screens changed (a screen plugged in or out, another resolution): the centers cover the new area and the pages are told (they bring back what is out of sight)
        if screens_at.elapsed() > Duration::from_secs(2) {
            screens_at = Instant::now();
            if let Some(now) = screens(&app) {
                let changed = SCREENS.lock().map(|s| s.as_ref().map_or(true, |o| o.0 != now.0 || o.1 != now.1)).unwrap_or(false);
                if changed {
                    let [l, t, r, b] = now.1;
                    for (label, _) in MODES {
                        if let Some(w) = app.get_webview_window(label) {
                            let _ = w.set_position(tauri::PhysicalPosition::new(l, t));
                            let _ = w.set_size(tauri::PhysicalSize::new((r - l) as u32, (b - t) as u32));
                        }
                    }
                    let payload = layout_payload(&app, &now);
                    if let Ok(mut s) = SCREENS.lock() { *s = Some(now); }
                    for (label, _) in MODES { let _ = app.emit_to(label, "center-layout", payload.clone()); }
                }
            }
        }
        for (label, mode) in MODES {
            let Some(c) = app.get_webview_window(label) else { continue };
            let Ok(ch) = hwnd_of(&c) else { continue };
            win::keep_style(ch);
            // the blur windows of this center follow it: the same order (the layer of the center), and directly under it
            let blurs: Vec<(String, isize)> = BLURS.lock().map(|b| b.iter().filter(|(_, v)| v.0 == label).map(|(k, v)| (k.clone(), v.2)).collect()).unwrap_or_default();
            // the web windows: in the order the center draws their frames (the highest `z` first), so that a page and its frame are never one over and one under another window's
            let entries: Vec<(i64, String)> = WEBS.lock().map(|m| m.iter().filter(|(_, v)| v.0 == label).map(|(k, v)| (v.2, k.clone())).collect()).unwrap_or_default();       // (the lock is let go before the windows are asked)
            let mut webs: Vec<(i64, isize, String)> = entries.into_iter().filter_map(|(z, k)| app.get_webview_window(&k).and_then(|w| hwnd_of(&w).ok()).map(|h| (z, h, k))).collect();
            webs.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            let web_labels: Vec<(isize, String)> = webs.iter().map(|w| (w.1, w.2.clone())).collect();
            // from the front: the center, the blurs of its windows (they blur what is under the windows: the pages too), the web windows
            let n_blur = blurs.len();
            let blur_hs: Vec<isize> = blurs.iter().map(|b| b.1).collect();
            let mut want: Vec<isize> = vec![ch];
            for bh in blur_hs.iter().copied().chain(webs.iter().map(|w| w.1)) { win::keep_style(bh); want.push(bh); }
            let state = mode_state(mode, game);
            let mut switched = None;
            // (Windows) The center, its blur windows and its pages are put in their state TOGETHER, in the order in which no window is over the one that is to be over it, not even between two calls
            // (win::place_group). A window that joins (a new blur window) while the state stays the same puts the group again too.
            #[cfg(windows)]
            {
                let was = last.get(&ch).copied().unwrap_or(99);
                // (a center that is not shown yet is not put: it is owned only after it is shown, an owned window that is shown lifts its owner, the game, over the windows of the user)
                if win::is_visible(ch) && (was != state || want.iter().any(|h| !last.contains_key(h))) {
                    let before = if crate::debug_on("order") { Some(stack_names(&app, 8)) } else { None };
                    win::place_group(&want, state, was, game);
                    for h in &want { last.insert(*h, state); }
                    if was != state { switched = Some((was, state)); }
                    if let Some(b) = before { order_diag(format!("placed {label} (mode {mode}): state {was} to {state}; the top of the stack before {b:?}; after {:?}", stack_names(&app, 8))); }
                }
            }
            // (elsewhere: one window after the other, in the order that leaves them right: a window put "to the top" goes over what is there, so the last one is the front one; a window put directly
            // over the game goes under the ones put before it)
            #[cfg(not(windows))]
            {
                let order: Vec<isize> = if state == 22 { want.clone() } else { want.iter().rev().copied().collect() };
                if order.iter().any(|h| !last.contains_key(h)) { last.remove(&ch); }
                for h in order { let r = apply_mode(h, mode, game, &mut last); if h == ch { switched = r; } }
            }
            // (only written down) another window came to the front and the state of this center changed: what the stack of windows looks like then, a moment later, and later still
            if n_blur > 0 && crate::debug_on("order") {
                if let Some((was, now)) = switched {
                    watch.insert(label.to_string(), (Instant::now(), 0));
                    order_diag(format!("switch {label} (mode {mode}): state {was} to {now}; the game is {}; {}", if game != 0 { "there" } else { "not found" }, blur_snapshot(label, 0, ch, &blur_hs, game)));
                }
                if let Some((t, stage)) = watch.get(label).copied() {
                    let due = if stage == 0 { t.elapsed() > Duration::from_millis(300) } else { t.elapsed() > Duration::from_millis(1500) };
                    if due {
                        order_diag(blur_snapshot(label, t.elapsed().as_millis(), ch, &blur_hs, game));
                        if stage == 0 { watch.insert(label.to_string(), (t, 1)); } else { watch.remove(label); }
                    }
                }
            }
            if want.len() > 1 {
                let seen = win::z_order(&want);
                let expected: Vec<isize> = want.iter().copied().filter(|h| seen.contains(h)).collect();
                // (only written down, nothing is done with it) the center and its blur windows out of order: when it was found, how long it lasted, which window of the system was in front
                if n_blur > 0 && crate::debug_on("order") {
                    let cb: Vec<isize> = want.iter().take(1 + n_blur).copied().collect();
                    let seen_cb: Vec<isize> = seen.iter().filter(|h| cb.contains(h)).copied().collect();
                    let exp_cb: Vec<isize> = cb.iter().filter(|h| seen.contains(h)).copied().collect();
                    match (seen_cb != exp_cb, mis.get(label).copied()) {
                        (true, None) => {
                            mis.insert(label.to_string(), Instant::now());
                            let idx: Vec<usize> = seen_cb.iter().filter_map(|h| cb.iter().position(|c| c == h)).collect();
                            order_diag(format!("order {label} (mode {mode}): the center and its blur windows are out of order: seen {idx:?} (0 = the center, 1.. = the blur windows); the game is in front: {}, this program is in front: {}", win::foreground() == game, win::self_front()));
                        }
                        (false, Some(t)) => { mis.remove(label); order_diag(format!("order {label}: in order again after {} ms", t.elapsed().as_millis())); }
                        _ => {}
                    }
                }
                let (changed, due) = {
                    let o = ORDER.lock().ok();
                    let prev = o.as_ref().and_then(|m| m.get(label).cloned());
                    (prev.as_ref().map_or(true, |p| p.0 != want), prev.and_then(|p| p.1).map_or(true, |t| t.elapsed() > std::time::Duration::from_millis(400)))
                };
                // A page that is pressed is brought to the front by the system itself, before this program has heard of the press (the center asks the mouse a few times a second and a short click
                // can go by between two looks). When the order of the web windows has become another one that nobody here made, and stays so for a moment, that order is what the user did: the center
                // is told and numbers the windows that way (instead of this program putting them back, which was seen as a window that is given the front and loses it again).
                let mut hold = false;                                               // (a new order is waiting to be believed: nothing is put back meanwhile)
                {
                    let obs: Vec<String> = seen.iter().filter_map(|h| web_labels.iter().find(|w| w.0 == *h).map(|w| w.1.clone())).collect();
                    let wanted_labels: Vec<String> = web_labels.iter().filter(|w| seen.contains(&w.0)).map(|w| w.1.clone()).collect();
                    let now = Instant::now();
                    if let Ok(mut m) = OBSERVED.lock() {
                        let e = m.entry(label.to_string()).or_insert((Vec::new(), None, None));
                        let just_put = e.2.map_or(false, |t| now.duration_since(t) < Duration::from_millis(250));
                        if obs == wanted_labels || obs.len() < 2 || just_put || changed {                // (an order that this program has just changed is not the user's)
                            e.0 = obs.clone(); e.1 = None;
                        } else if obs != e.0 {                                       // (a new order: it has to stay for a moment before it is believed)
                            e.0 = obs.clone(); e.1 = Some((obs.clone(), now));
                        } else if let Some((cand, since)) = e.1.clone() {
                            if cand == obs && now.duration_since(since) >= Duration::from_millis(60) {
                                e.1 = None; e.0 = obs.clone();
                                let _ = app.emit_to(label, "web-order", json!({ "labels": obs }));
                            }
                        }
                        hold = e.1.is_some();
                    }
                }
                if seen != expected && (changed || due) && !hold {
                    for pair in want.windows(2) { win::place_below(pair[1], pair[0]); }
                    if let Ok(mut m) = OBSERVED.lock() { if let Some(e) = m.get_mut(label) { e.2 = Some(Instant::now()); } }
                    if let Ok(mut m) = ORDER.lock() { m.insert(label.to_string(), (want.clone(), Some(std::time::Instant::now()))); }
                } else if changed {
                    if let Ok(mut m) = ORDER.lock() { m.insert(label.to_string(), (want.clone(), None)); }
                }
            }
        }
    }
}
