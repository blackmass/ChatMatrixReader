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
pub struct Pane { id: String, x: f64, y: f64, w: f64, h: f64, bar: f64, hit: bool, blur: u32, web: String, z: i64 }             // (the place of a pane in screen pixels, the bar above its text included; `bar`: the height of the bar; `hit`: it takes the mouse: a window that is click-through only has a place)

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

fn layout_payload(s: &(Vec<[i32; 4]>, [i32; 4])) -> Value { json!({ "origin": [s.1[0], s.1[1]], "monitors": s.0 }) }

/// The screens (for a page that starts after the change was told): { origin: [x, y], monitors: [[x, y, w, h], ..] } (the main screen first).
#[tauri::command]
pub async fn center_layout() -> Result<Value, String> {
    Ok(SCREENS.lock().ok().and_then(|s| s.as_ref().map(layout_payload)).unwrap_or(Value::Null))
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

/// Makes the three centers (a few seconds after the start) and runs the loop that serves them.
pub fn start(app: AppHandle) {
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
                let _ = w.show();
            }
        }
        let app2 = app.clone();
        std::thread::spawn(move || run(app2));
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
        x: f(v, "x") + ox, y: f(v, "y") + oy, w: f(v, "w"), h: f(v, "h"), bar: f(v, "bar"), hit: v.get("hit").and_then(|x| x.as_bool()).unwrap_or(true), blur: v.get("blur").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
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
    Ok(win::set_pane_zones(idx, zones))
}

/// The blur windows of the panes (the option "블러"): one empty transparent window for each pane that has it, the size of its text area, directly under its center (see `run`);
/// the system blurs what is behind it. key: its label -> (the center's label, the level, its handle, where it is).
static BLURS: LazyLock<Mutex<HashMap<String, (String, u32, isize, [i32; 4])>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn sync_blur(app: &AppHandle, center: &str, panes: &[Pane]) {
    let want: HashMap<String, (u32, [i32; 4])> = panes.iter().filter(|p| p.blur > 0).map(|p| (
        format!("blur_{}_{}", center, p.id),
        (p.blur, [p.x.round() as i32, (p.y + p.bar).round() as i32, p.w.round().max(1.0) as i32, (p.h - p.bar).round().max(1.0) as i32]),
    )).collect();
    let mut have = match BLURS.lock() { Ok(h) => h, Err(_) => return };
    // gone: the pane has no blur any more (or is not there)
    let gone: Vec<String> = have.iter().filter(|(k, v)| v.0 == center && !want.contains_key(*k)).map(|(k, _)| k.clone()).collect();
    for k in gone { have.remove(&k); if let Some(w) = app.get_webview_window(&k) { let _ = w.destroy(); } }
    for (k, (level, r)) in want {
        let known = have.get(&k).cloned();
        let w = match app.get_webview_window(&k) {
            Some(w) => w,
            None => match make_window(app, &k, "blur.html", "blur") { Ok(w) => w, Err(_) => continue },
        };
        let Ok(h) = hwnd_of(&w) else { continue };
        if known.as_ref().map_or(true, |v| v.3 != r) {
            let _ = w.set_position(tauri::PhysicalPosition::new(r[0], r[1]));
            let _ = w.set_size(tauri::PhysicalSize::new(r[2] as u32, r[3] as u32));
        }
        if known.is_none() {
            let _ = w.set_ignore_cursor_events(true);
            win::make_no_key(h); win::set_noactivate_light(h, true); win::set_not_rude(h);
        }
        if known.as_ref().map_or(true, |v| v.1 != level) { win::set_blur(h, true, if level == 2 { 4 } else { 3 }, 0x1e, 0x1f, 0x22, 0.004); }
        if known.is_none() { let _ = w.show(); }
        have.insert(k, (center.to_string(), level, h, r));
    }
}

/// The web windows that follow a center: the window of the system of a web window (webwin.rs) is where its page is drawn by the center (a box with `web`), directly under the center, so
/// that the bar and the strips of the center take the mouse and the page the rest. label -> (the center, where it is: x, y, w, h in pixels).
static WEBS: LazyLock<Mutex<HashMap<String, (String, [i32; 4], i64)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn sync_webs(app: &AppHandle, center: &str, panes: &[Pane]) {
    let now: HashMap<String, ([i32; 4], i64)> = panes.iter().filter(|p| !p.web.is_empty()).map(|p| (p.web.clone(), ([p.x.round() as i32, p.y.round() as i32, p.w.round().max(1.0) as i32, p.h.round().max(1.0) as i32], p.z))).collect();
    let Ok(mut webs) = WEBS.lock() else { return };
    webs.retain(|k, v| v.0 != center || now.contains_key(k));
    for (k, (r, z)) in now {
        let changed = webs.get(&k).map_or(true, |v| v.1 != r || v.0 != center);
        webs.insert(k.clone(), (center.to_string(), r, z));
        if changed { if let Some(w) = app.get_webview_window(&k) { let _ = crate::webwin::set_outer(&w, Some(r[0]), Some(r[1]), r[2] as u32, r[3] as u32); } }
    }
}

/// The title the window of the game has (the setting "와우 창 제목"; the program name is looked at first): told by the center page.
static GAME_TITLE: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new("World of Warcraft".to_string()));
#[tauri::command]
pub async fn center_title(title: String) -> Result<(), String> {
    if let Ok(mut t) = GAME_TITLE.lock() { *t = if title.trim().is_empty() { "World of Warcraft".to_string() } else { title }; }
    Ok(())
}

// Typing into the page of a center (the address bar of a web window): like a text box of a web page (webwin.rs "prep"): a center never takes the keyboard of the game, but while the mouse is over
// a text box the program lifts that for the window (nothing moves), a click on the box then activates it like any window and the keys go to the page; when the box is left the style is put back,
// and when it was used the keyboard goes back to where it was.
static BEFORE: LazyLock<Mutex<HashMap<String, isize>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
fn center_hwnd(app: &AppHandle, label: &str) -> Result<isize, String> { app.get_webview_window(label).ok_or("no such window".to_string()).and_then(|w| hwnd_of(&w)) }

#[tauri::command]
pub async fn center_prep(app: AppHandle, label: String) -> Result<(), String> {
    let h = center_hwnd(&app, &label)?;
    let prev = win::foreground();
    if prev != h { if let Ok(mut m) = BEFORE.lock() { m.insert(label, prev); } }
    win::allow_key(h, true);
    win::set_noactivate_light(h, false);
    Ok(())
}
#[tauri::command]
pub async fn center_unprep(app: AppHandle, label: String) -> Result<(), String> {
    let h = center_hwnd(&app, &label)?;
    win::allow_key(h, false);
    win::set_noactivate_light(h, true);
    Ok(())
}
#[tauri::command]
pub async fn center_release(app: AppHandle, label: String) -> Result<(), String> {
    // the box was used and is left: the center takes nothing again. The keyboard is NOT handed back to the game: the user clicks the game (that has never worked well by itself)
    let h = center_hwnd(&app, &label)?;
    win::allow_key(h, false);
    win::set_noactivate_light(h, true);
    Ok(())
}
/// macOS: a click on a text box must make the program active; when the system has not done it a moment later, it is asked to.
#[tauri::command]
pub async fn center_inputclick(app: AppHandle, label: String) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let h = center_hwnd(&app, &label)?;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            if !win::has_keyboard(h) { win::allow_key(h, true); let _ = win::grab_focus(h); }          // (this window: another window of ours may have the keyboard: the page of a web window)
        });
    }
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
        if let Some(p) = panes.iter().find(|p| p.id == id) { return Some((p.x.round() as i32, (p.y + p.bar).round() as i32, p.w.round().max(1.0) as u32, (p.h - p.bar).round().max(1.0) as u32)); }
    }
    None
}

fn inside(panes: &[Pane], x: i32, y: i32, margin: f64) -> bool {
    panes.iter().filter(|p| p.hit).any(|p| (x as f64) >= p.x - margin && (x as f64) < p.x + p.w + margin && (y as f64) >= p.y - margin && (y as f64) < p.y + p.h + margin)
}

/// The order of the windows of a mode: 0 ordinary, 1 always on top, 2 above the game only (two states: the game or a window of ours in front: topmost; another program in front: right above the game).
fn apply_mode(h: isize, mode: u32, game: isize, last: &mut HashMap<isize, u32>) {
    let want = match mode {
        1 => 1,
        2 => if game > 0 { let fg = win::foreground(); if fg == game { 21 } else if win::self_front() { 23 } else { 22 } } else { 1 },
        _ => 0,
    };
    let was = last.get(&h).copied().unwrap_or(99);
    if was == want { return; }
    last.insert(h, want);
    match want {
        0 => { win::set_owner(h, 0); win::set_topmost(h, false, 0); }
        1 | 21 => { win::set_topmost(h, true, 0); win::set_owner(h, 0); }
        23 => { win::set_owner(h, 0); win::set_topmost(h, true, 0); }
        22 if was == 23 => { win::set_topmost(h, false, game); win::set_owner(h, game); }
        _ => { win::set_owner(h, game); win::set_topmost(h, false, game); }
    }
}

fn run(app: AppHandle) {
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
                    let payload = layout_payload(&now);
                    if let Ok(mut s) = SCREENS.lock() { *s = Some(now); }
                    for (label, _) in MODES { let _ = app.emit_to(label, "center-layout", payload.clone()); }
                }
            }
        }
        for (label, mode) in MODES {
            let Some(c) = app.get_webview_window(label) else { continue };
            let Ok(ch) = hwnd_of(&c) else { continue };
            win::keep_style(ch);
            apply_mode(ch, mode, game, &mut last);
            // the blur windows of this center follow it: the same order (the layer of the center), and directly under it
            let blurs: Vec<(String, isize)> = BLURS.lock().map(|b| b.iter().filter(|(_, v)| v.0 == label).map(|(k, v)| (k.clone(), v.2)).collect()).unwrap_or_default();
            // the web windows: in the order the center draws their frames (the highest `z` first), so that a page and its frame are never one over and one under another window's
            let mut webs: Vec<(i64, isize)> = WEBS.lock().map(|m| m.iter().filter(|(_, v)| v.0 == label).filter_map(|(k, v)| app.get_webview_window(k).and_then(|w| hwnd_of(&w).ok()).map(|h| (v.2, h))).collect()).unwrap_or_default();
            webs.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            // from the front: the center, the blurs of its windows (they blur what is under the windows: the pages too), the web windows
            let mut want: Vec<isize> = vec![ch];
            for bh in blurs.into_iter().map(|b| b.1).chain(webs.into_iter().map(|w| w.1)) {
                win::keep_style(bh);
                apply_mode(bh, mode, game, &mut last);
                want.push(bh);
            }
            if want.len() > 1 {
                let seen = win::z_order(&want);
                let expected: Vec<isize> = want.iter().copied().filter(|h| seen.contains(h)).collect();
                if seen != expected { for pair in want.windows(2) { win::place_below(pair[1], pair[0]); } }
            }
        }
    }
}
