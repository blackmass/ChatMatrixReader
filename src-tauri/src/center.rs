//! The control centers (3.2): THREE transparent windows over all the screens, one for each kind of order of the translation windows (0 ordinary, 1 always on top, 2 above the game
//! only: treated like always on top while the game or a window of ours is in front, else right above the game), each drawing the translation windows that belong to it (panes) in its
//! page (center.html). A center takes the mouse only while the pointer is over one of its panes (read here, 60 times a second, from the system); the rest of it lets the mouse go
//! through to the game. Started by the file `center_mode` next to the program (until the centers replace the windows of 3.1.1).
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{base_dir, hwnd_of, make_window, win};

#[derive(Clone, Debug)]
pub struct Pane { id: String, x: f64, y: f64, w: f64, h: f64, bar: f64, hit: bool }             // (the place of a pane in screen pixels, the bar above its text included; `bar`: the height of the bar; `hit`: it takes the mouse: a window that is click-through only has a place)

static RECTS: LazyLock<Mutex<HashMap<String, Vec<Pane>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static LOCK: Mutex<Option<String>> = Mutex::new(None);                    // the center that holds the mouse while a button is down

const MODES: [(&str, u32); 3] = [("center0", 0), ("center1", 1), ("center2", 2)];

pub fn wanted() -> bool { base_dir().join("center_mode").exists() }

/// Makes the three centers (a few seconds after the start) and runs the loop that serves them.
pub fn start(app: AppHandle) {
    if !wanted() { return; }
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(3000))).await;
        // the rectangle of all the screens together (physical pixels)
        let (mut l, mut t, mut r, mut b) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for m in app.available_monitors().unwrap_or_default() {
            let (p, s) = (m.position(), m.size());
            l = l.min(p.x); t = t.min(p.y); r = r.max(p.x + s.width as i32); b = b.max(p.y + s.height as i32);
        }
        if l == i32::MAX { return; }
        for (label, mode) in MODES {
            let page = format!("center.html?mode={mode}&ox={l}&oy={t}");
            if let Ok(w) = make_window(&app, label, &page, "center") {
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
        x: f(v, "x") + ox, y: f(v, "y") + oy, w: f(v, "w"), h: f(v, "h"), bar: f(v, "bar"), hit: v.get("hit").and_then(|x| x.as_bool()).unwrap_or(true),
    }).filter(|p| !p.id.is_empty()).collect()).unwrap_or_default();
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
            game = win::find_game(game, "World of Warcraft").map(|g| g.hwnd).unwrap_or(0);
            game_at = Instant::now();
        }
        for (label, mode) in MODES {
            let Some(c) = app.get_webview_window(label) else { continue };
            let Ok(ch) = hwnd_of(&c) else { continue };
            win::keep_style(ch);
            apply_mode(ch, mode, game, &mut last);
        }
    }
}
