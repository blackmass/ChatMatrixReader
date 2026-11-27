//! The blur of the translation windows on Windows 11 (docs/HANDOFF.md 4-0aq). The system's blur does not work there, so a pane that wants blur gets a window of ours that shows a blurred piece of the
//! picture of the GAME (the capture session of wgc.rs: the game window only, so nothing of ours is in it). The window is opaque, is as large as the part of the pane that is over the game, stands
//! directly under its center (the loop in center.rs orders it like the blur windows of the system) and lets the mouse through; the translucent colour of the pane is drawn over it by the center.
//!
//! A thread of its own makes the windows (a window needs a thread that handles its messages), takes the newest picture of the game when there is one and draws every pane's piece (blurgl.rs, on the
//! graphics card) into the swap chain of its window. Nothing is read back to the processor. A pane (or the part of it) that is not over the game has no window, so there is no blur there.
//! Off unless the option is on: Windows 11 AND the way of reading is "game window" (the hub tells center.rs, which tells `set_enabled`).
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::{w, Interface};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::Win32::Graphics::Dwm::DwmSetWindowAttribute;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, DXGI_PRESENT, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_DISCARD, DXGI_USAGE_RENDER_TARGET_OUTPUT};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW, RegisterClassExW, SetLayeredWindowAttributes, SetWindowPos, ShowWindow, TranslateMessage, LWA_ALPHA, MSG, PM_REMOVE,
    SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

use crate::blurgl::{Blur, Chain};
use crate::wgc;
use crate::win;

/// What a pane wants: its key, its center (the label and the handle of its window), the level (1 weak, 2 strong) and where it is on the screen: x, y, w, h in pixels.
#[derive(Clone)]
pub struct Want { pub key: String, pub center: String, pub center_hwnd: isize, pub level: u32, pub rect: [i32; 4] }

static WANTS: LazyLock<Mutex<Vec<Want>>> = LazyLock::new(|| Mutex::new(Vec::new()));
/// key -> (center, handle) of the windows that are there now: the loop of the centers orders them and the option "hide the overlay" cloaks them
static WINS: LazyLock<Mutex<HashMap<String, (String, isize)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static ENABLED: AtomicBool = AtomicBool::new(false);
static GAME: AtomicIsize = AtomicIsize::new(0);
static DIRTY: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(on: bool) { if ENABLED.swap(on, Ordering::Relaxed) != on { DIRTY.store(true, Ordering::Relaxed); } }
pub fn set_game(hwnd: isize) { if GAME.swap(hwnd, Ordering::Relaxed) != hwnd { DIRTY.store(true, Ordering::Relaxed); } }
/// The panes of one center that want blur (the list replaces what that center asked for before).
pub fn set_wants(center: &str, list: Vec<Want>) {
    if let Ok(mut w) = WANTS.lock() { w.retain(|x| x.center != center); w.extend(list); }
    DIRTY.store(true, Ordering::Relaxed);
}
/// The windows of a center that are there now: (key, handle).
pub fn windows_of(center: &str) -> Vec<(String, isize)> {
    WINS.lock().map(|w| w.iter().filter(|(_, v)| v.0 == center).map(|(k, v)| (k.clone(), v.1)).collect()).unwrap_or_default()
}
/// All of them: (key, handle).
pub fn all_windows() -> Vec<(String, isize)> { WINS.lock().map(|w| w.iter().map(|(k, v)| (k.clone(), v.1)).collect()).unwrap_or_default() }

unsafe extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == 0x0021 { return LRESULT(3); }              // WM_MOUSEACTIVATE: MA_NOACTIVATE
    DefWindowProcW(h, msg, w, l)
}

struct Own { hwnd: HWND, swap: Option<(IDXGISwapChain1, u32, u32)>, chain: Option<Chain>, placed: [i32; 4], shown: bool, idle: Option<Instant> }

fn make_window(rect: [i32; 4]) -> Result<HWND, String> {
    unsafe {
        let module = GetModuleHandleW(None).map_err(|e| format!("module: {e}"))?;
        let h = CreateWindowExW(WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0), w!("CMROwnBlur"), w!("CMR Own Blur"), WINDOW_STYLE(WS_POPUP.0),
            rect[0], rect[1], rect[2], rect[3], None, None, Some(HINSTANCE(module.0)), None).map_err(|e| format!("window: {e}"))?;
        let _ = SetLayeredWindowAttributes(h, COLORREF(0), 255, LWA_ALPHA);                      // (layered and not see-through: the click goes through by WS_EX_TRANSPARENT)
        let square: i32 = 1;                                                                     // DWMWA_WINDOW_CORNER_PREFERENCE = DONOTROUND: the panes have square corners
        let _ = DwmSetWindowAttribute(h, windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE(33), &square as *const i32 as *const c_void, 4);
        win::set_not_rude(h.0 as isize);
        win::no_transitions(h.0 as isize);
        Ok(h)
    }
}

fn register_class() -> Result<(), String> {
    unsafe {
        let module = GetModuleHandleW(None).map_err(|e| format!("module: {e}"))?;
        let class = WNDCLASSEXW { cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32, lpfnWndProc: Some(wndproc), hInstance: HINSTANCE(module.0), lpszClassName: w!("CMROwnBlur"), ..Default::default() };
        if RegisterClassExW(&class) == 0 { return Err("the window class was not registered".into()); }
        Ok(())
    }
}

fn make_swap(device: &ID3D11Device, hwnd: HWND, w: u32, h: u32) -> Result<IDXGISwapChain1, String> {
    unsafe {
        let dxgi: IDXGIDevice = device.cast().map_err(|e| format!("dxgi device: {e}"))?;
        let adapter: IDXGIAdapter = dxgi.GetAdapter().map_err(|e| format!("adapter: {e}"))?;
        let factory: IDXGIFactory2 = adapter.GetParent().map_err(|e| format!("factory: {e}"))?;
        // (the old way of swapping: it is what a layered window takes without any care; one picture, drawn into it and shown)
        let desc = DXGI_SWAP_CHAIN_DESC1 { Width: w, Height: h, Format: DXGI_FORMAT_B8G8R8A8_UNORM, Stereo: false.into(), SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT, BufferCount: 1, Scaling: DXGI_SCALING_STRETCH, SwapEffect: DXGI_SWAP_EFFECT_DISCARD, AlphaMode: DXGI_ALPHA_MODE_IGNORE, Flags: 0 };
        factory.CreateSwapChainForHwnd(device, hwnd, &desc, None, None).map_err(|e| format!("swap chain {w}x{h}: {e}"))
    }
}

fn destroy(key: &str, mut o: Own) {
    o.swap = None; o.chain = None;
    unsafe { let _ = DestroyWindow(o.hwnd); }
    if let Ok(mut w) = WINS.lock() { w.remove(key); }
}

fn hide(o: &mut Own) { if o.shown { unsafe { let _ = ShowWindow(o.hwnd, SW_HIDE); } o.shown = false; } }

fn pump() {
    unsafe {
        let mut m = MSG::default();
        while PeekMessageW(&mut m, None, 0, 0, PM_REMOVE).as_bool() { let _ = TranslateMessage(&m); DispatchMessageW(&m); }
    }
}

fn log(msg: &str) { crate::debug_log("blur", &format!("own blur: {msg}")); }

/// A window whose pane does not want blur for a moment (the mouse clears the pane, it is resized ...) is only hidden, with its swap chain and textures, and shown again at once when the pane comes back
/// (made again every time it was late: making a window, its swap chain and its textures and its first composition by the system took longer than the pane was away). It is destroyed when it has been
/// unwanted for this long.
const KEEP: Duration = Duration::from_secs(30);

const FRAME: Duration = Duration::from_millis(5);                  // (how often the session is looked at: a picture is drawn as soon as the game has sent a new one, so it follows the game up to the refresh rate of the screen; nothing is drawn while the game sends nothing new. It was 33 ms, about 30 pictures a second)

/// Starts the thread (once, at the start of the program).
pub fn start(_app: AppHandle) {
    let _ = std::thread::Builder::new().name("own-blur".into()).spawn(move || {
        if let Err(e) = register_class() { log(&e); return; }
        let mut wins: HashMap<String, Own> = HashMap::new();
        let mut blur: Option<(usize, Blur)> = None;                // (the shaders belong to a device: made again when the session has another)
        let (mut last_frames, mut last_err) = (u64::MAX, String::new());
        loop {
            let started = Instant::now();
            pump();
            let game = GAME.load(Ordering::Relaxed);
            let wants: Vec<Want> = WANTS.lock().map(|w| w.clone()).unwrap_or_default();
            if !ENABLED.load(Ordering::Relaxed) {                                       // (the option is off for good: nothing is kept)
                for (k, o) in wins.drain() { destroy(&k, o); }
                last_frames = u64::MAX;
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            let wants: Vec<Want> = if game == 0 { Vec::new() } else { wants };            // (no game: nothing is wanted for now)
            // a window that is not wanted now is hidden and kept (see KEEP); the one that is wanted again is shown by the drawing below
            let mut gone: Vec<String> = Vec::new();
            for (k, o) in wins.iter_mut() {
                if wants.iter().any(|w| &w.key == k) { o.idle = None; }
                else { hide(o); if o.idle.get_or_insert_with(Instant::now).elapsed() > KEEP { gone.push(k.clone()); } }
            }
            for k in gone { if let Some(o) = wins.remove(&k) { destroy(&k, o); } }
            if wants.is_empty() { last_frames = u64::MAX; std::thread::sleep(Duration::from_millis(50)); continue; }
            let dirty = DIRTY.swap(false, Ordering::Relaxed);
            let res = wgc::with_frame(game, |device, ctx, frame, origin, frames| {
                if frames == last_frames && !dirty { return Ok(()); }                  // (nothing new: what is shown stays)
                last_frames = frames;
                let id = device.as_raw() as usize;
                if blur.as_ref().map_or(true, |b| b.0 != id) {
                    for (_, o) in wins.iter_mut() { o.swap = None; o.chain = None; }
                    blur = Some((id, Blur::new(device)?));
                }
                let b = &blur.as_ref().ok_or("no blur")?.1;
                let mut d = windows::Win32::Graphics::Direct3D11::D3D11_TEXTURE2D_DESC::default();
                unsafe { frame.GetDesc(&mut d); }
                let (fw, fh) = (d.Width as i32, d.Height as i32);
                for want in &wants {
                    // the part of the pane that is over the game window (in pixels of the picture)
                    let (x0, y0) = ((want.rect[0] - origin.0).max(0), (want.rect[1] - origin.1).max(0));
                    let (x1, y1) = ((want.rect[0] - origin.0 + want.rect[2]).min(fw), (want.rect[1] - origin.1 + want.rect[3]).min(fh));
                    if x1 - x0 < 2 || y1 - y0 < 2 { if let Some(o) = wins.get_mut(&want.key) { hide(o); } continue; }
                    let (cw, ch) = ((x1 - x0) as u32, (y1 - y0) as u32);
                    let screen = [origin.0 + x0, origin.1 + y0, cw as i32, ch as i32];
                    if !wins.contains_key(&want.key) {
                        let hwnd = make_window(screen)?;
                        if let Ok(mut w) = WINS.lock() { w.insert(want.key.clone(), (want.center.clone(), hwnd.0 as isize)); }
                        wins.insert(want.key.clone(), Own { hwnd, swap: None, chain: None, placed: screen, shown: false, idle: None });
                    }
                    let o = wins.get_mut(&want.key).ok_or("no window")?;
                    if o.placed != screen { unsafe { let _ = SetWindowPos(o.hwnd, None, screen[0], screen[1], screen[2], screen[3], SWP_NOZORDER | SWP_NOACTIVATE); } o.placed = screen; }
                    if o.swap.as_ref().map_or(true, |s| (s.1, s.2) != (cw, ch)) { o.swap = None; o.swap = Some((make_swap(device, o.hwnd, cw, ch)?, cw, ch)); }
                    if o.chain.as_ref().map_or(true, |c| (c.w, c.h, c.level) != (cw, ch, want.level)) { o.chain = Some(b.chain(device, cw, ch, want.level)?); }
                    let chain = o.chain.as_ref().ok_or("no chain")?;
                    // the sides of the window that are the sides of the pane fade out and have round corners; a side where the pane goes beyond the game window is not an edge (it is pushed far outside)
                    let far = 1000.0f32;
                    let edge = [if want.rect[0] - origin.0 < 0 { -far } else { 0.0 }, if want.rect[1] - origin.1 < 0 { -far } else { 0.0 },
                        cw as f32 + if want.rect[0] - origin.0 + want.rect[2] > fw { far } else { 0.0 }, ch as f32 + if want.rect[1] - origin.1 + want.rect[3] > fh { far } else { 0.0 }];
                    let out = b.run_chain(ctx, frame, (x0 as u32, y0 as u32), chain, Some(edge));
                    let swap = &o.swap.as_ref().ok_or("no swap chain")?.0;
                    let back: ID3D11Texture2D = unsafe { swap.GetBuffer(0) }.map_err(|e| format!("back buffer: {e}"))?;
                    unsafe { ctx.CopyResource(&back, out); let _ = swap.Present(0, DXGI_PRESENT(0)); }
                    if !o.shown { win::show_below(o.hwnd.0 as isize, want.center_hwnd); o.shown = true; }
                }
                Ok(())
            });
            match res {
                Ok(()) => { last_err.clear(); }
                Err(e) => {
                    for o in wins.values_mut() { hide(o); }                    // (no picture of the game: nothing old is left on the screen)
                    DIRTY.store(true, Ordering::Relaxed); last_frames = u64::MAX;
                    if e != last_err { log(&e); last_err = e; }
                    std::thread::sleep(Duration::from_millis(300));
                }
            }
            if let Some(rest) = FRAME.checked_sub(started.elapsed()) { std::thread::sleep(rest); }
        }
    });
}
