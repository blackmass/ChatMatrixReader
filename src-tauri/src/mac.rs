//! Everything that calls macOS directly: the counterpart of win.rs, with the same function names, so main.rs does not care which one it is.
//! Written after the 2.x Python reader (app/native/mac.py), which worked on macOS: the same system calls, the same window levels.
//!
//! Words used here:
//!   window handle   a window of ours = the NSWindow pointer; a window of another program (the game) = its CGWindowID (a number)
//!   pixels          the pages count in screen pixels (like on Windows): points x the scale of the main display (2 on a Retina screen)
//!
//! All AppKit calls are made on the main thread (`on_main`): the pages ask from other threads.
#![allow(non_snake_case, dead_code)]
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowName,
    kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
};
use objc2::runtime::{AnyObject, Bool, Sel};
use objc2::{class, msg_send, sel};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceFlagsState(state: i32) -> u64;
    fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    fn CGImageGetBitmapInfo(image: *const c_void) -> u32;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
    // (private, what iTerm2 uses for the blur behind a window; the radius 0 = none)
    fn CGSDefaultConnectionForThread() -> i32;
    fn CGSSetWindowBackgroundBlurRadius(connection: i32, window: i32, radius: i32) -> i32;
    // (private) the tags of a window in the window server; the bit 1 << 16 is "clicking this window does not activate its program"
    fn CGSSetWindowTags(connection: i32, window: i32, tags: *const i32, size: i32) -> i32;
    fn CGSClearWindowTags(connection: i32, window: i32, tags: *const i32, size: i32) -> i32;
}
#[link(name = "objc")]
extern "C" {
    fn object_setClass(obj: *mut AnyObject, class: *const c_void) -> *const c_void;
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn GetCurrentProcess(psn: *mut [u32; 2]) -> i32;
    fn SetFrontProcess(psn: *const [u32; 2]) -> i32;
}
extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_sync_f(queue: *const c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
}

// ------------------------------------------------------------------------------------------------- the main thread
/// Runs `f` on the main thread and waits for it (at once when this already is the main thread).
fn on_main<R>(f: impl FnOnce() -> R) -> R {
    if unsafe { libc::pthread_main_np() } != 0 {
        return f();
    }
    struct Job<F, R> { f: Option<F>, r: Option<R> }
    extern "C" fn run<F: FnOnce() -> R, R>(ctx: *mut c_void) {
        let job = unsafe { &mut *(ctx as *mut Job<F, R>) };
        if let Some(f) = job.f.take() { job.r = Some(f()); }
    }
    let mut job: Job<_, R> = Job { f: Some(f), r: None };
    fn runner<F: FnOnce() -> R, R>(_: &Job<F, R>) -> extern "C" fn(*mut c_void) { run::<F, R> }
    let work = runner(&job);
    unsafe { dispatch_sync_f(&_dispatch_main_q as *const c_void, &mut job as *mut Job<_, R> as *mut c_void, work); }
    job.r.expect("the main thread did the job")
}

unsafe fn obj<'a>(handle: isize) -> &'a AnyObject {
    &*(handle as *const AnyObject)
}

fn ns_string(text: &str) -> *mut AnyObject {
    let c = CString::new(text.replace('\0', "")).unwrap_or_default();
    let s: *mut AnyObject = unsafe { msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()] };
    s
}

fn string_of(s: *mut AnyObject) -> String {
    if s.is_null() { return String::new(); }
    unsafe {
        let p: *const c_char = msg_send![&*s, UTF8String];
        if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
    }
}

fn shared_app() -> &'static AnyObject {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        &*app
    }
}

/// Lets the system's run loop work for a moment ("who is in front" only changes when the main thread takes its events).
fn pump(seconds: f64) {
    unsafe {
        let date: *mut AnyObject = msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: seconds];
        let run_loop: *mut AnyObject = msg_send![class!(NSRunLoop), currentRunLoop];
        let _: () = msg_send![&*run_loop, runUntilDate: date];
    }
}

// ------------------------------------------------------------------------------------------------- pixels and points
/// How many pixels a point is on the main display (2 on a Retina screen). (CGDisplayPixelsWide is no help: it counts in points. The display mode knows
/// the real pixels.)
fn scale() -> f64 {
    let main = CGDisplay::main();
    let points = main.bounds().size.width;
    let pixels = main.display_mode().map(|m| m.pixel_width() as f64).unwrap_or(points);
    if points > 0.0 && pixels > 0.0 { pixels / points } else { 1.0 }
}

/// The whole desktop (all displays): x, y, width, height in pixels.
pub fn screen_rect() -> [i32; 4] {
    let s = scale();
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for id in CGDisplay::active_displays().unwrap_or_default() {
        let b = CGDisplay::new(id).bounds();
        x0 = x0.min(b.origin.x); y0 = y0.min(b.origin.y);
        x1 = x1.max(b.origin.x + b.size.width); y1 = y1.max(b.origin.y + b.size.height);
    }
    if x0 > x1 { return [0, 0, 0, 0]; }
    [(x0 * s).round() as i32, (y0 * s).round() as i32, ((x1 - x0) * s).round() as i32, ((y1 - y0) * s).round() as i32]
}

/// Copies a rectangle of the screen at the display's real resolution (the pages' pixels: see above). Result: 8 bytes header (width, height
/// as u32 little endian, of the picture that came back) + width*height*4 bytes BGRA. Needs the permission "Screen & System Audio Recording".
pub fn capture(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    if w <= 0 || h <= 0 || w > 16384 || h > 16384 {
        return Err(format!("bad size {w}x{h}"));
    }
    // without the permission the system gives back only the desktop picture: ask once (a dialog of the system), then say so at every call
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        if !ASKED_SCREEN.swap(true, Ordering::SeqCst) { unsafe { CGRequestScreenCaptureAccess(); } }
        return Err("the permission \"Screen & System Audio Recording\" is missing (System Settings > Privacy & Security); restart the program after giving it".into());
    }
    let s = scale();
    let rect = CGRect::new(&CGPoint::new(x as f64 / s, y as f64 / s), &CGSize::new(w as f64 / s, h as f64 / s));
    let (ids, _) = CGDisplay::displays_with_rect(rect, 4).map_err(|e| format!("no display ({e})"))?;
    let id = *ids.first().ok_or("no display at that place")?;
    let display = CGDisplay::new(id);
    let origin = display.bounds().origin;
    let local = CGRect::new(&CGPoint::new(rect.origin.x - origin.x, rect.origin.y - origin.y), &rect.size);
    let img = display.image_for_rect(local).ok_or("the screen could not be copied (is the screen recording permission given?)")?;
    let (iw, ih, bpr, bpp) = (img.width(), img.height(), img.bytes_per_row(), img.bits_per_pixel());
    if bpp != 32 || iw == 0 || ih == 0 { return Err(format!("unexpected picture {iw}x{ih} with {bpp} bits")); }
    let info = unsafe { CGImageGetBitmapInfo(foreign_types::ForeignType::as_ptr(&img) as *const c_void) };
    let little = info & 0x7000 == 0x2000;                       // kCGBitmapByteOrder32Little: B G R A in memory
    let alpha_first = matches!(info & 0x1f, 2 | 4 | 6);         // premultiplied first, first, none skip first
    if !alpha_first { return Err(format!("unexpected pixel format {info:#x}")); }
    let data = img.data();
    let bytes = data.bytes();
    if bytes.len() < bpr * (ih - 1) + iw * 4 { return Err("the picture is smaller than it says".into()); }
    let mut out = vec![0u8; 8 + iw * ih * 4];
    out[0..4].copy_from_slice(&(iw as u32).to_le_bytes());
    out[4..8].copy_from_slice(&(ih as u32).to_le_bytes());
    for row in 0..ih {
        let src = &bytes[row * bpr..row * bpr + iw * 4];
        let dst = &mut out[8 + row * iw * 4..8 + (row + 1) * iw * 4];
        if little { dst.copy_from_slice(src); }
        else { for (d, p) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) { d[0] = p[3]; d[1] = p[2]; d[2] = p[1]; d[3] = p[0]; } }   // A R G B -> B G R A
    }
    Ok(out)
}

pub fn cursor_pos() -> (i32, i32) {
    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else { return (0, 0) };
    let Ok(event) = CGEvent::new(source) else { return (0, 0) };
    let p = event.location();
    let s = scale();
    ((p.x * s).round() as i32, (p.y * s).round() as i32)
}

const FLAG_SHIFT: u64 = 0x0002_0000;
const FLAG_CONTROL: u64 = 0x0004_0000;
const FLAG_OPTION: u64 = 0x0008_0000;

/// The key code of macOS (the position of the key on an ANSI keyboard: letters and digits are NOT in order) for a virtual-key code of Windows, which is how the
/// pages name the keys (letters 0x41.., digits 0x30.., F1 0x70.., Enter 0x0D ...). None = a key that has no such place on a Mac.
fn mac_key(vk: i32) -> Option<u16> {
    const LETTERS: [u16; 26] = [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6];     // A .. Z
    const DIGITS: [u16; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];                                                           // 0 .. 9
    const FKEYS: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];                                            // F1 .. F12
    Some(match vk {
        0x41..=0x5A => LETTERS[(vk - 0x41) as usize],
        0x30..=0x39 => DIGITS[(vk - 0x30) as usize],
        0x70..=0x7B => FKEYS[(vk - 0x70) as usize],
        0x0D => 36,   // Enter (Return)
        0x20 => 49,   // Space
        0x09 => 48,   // Tab
        0x08 => 51,   // Backspace (the Mac "delete")
        0x1B => 53,   // Esc
        0x2D => 114,  // Insert (the Mac "help" key)
        0x2E => 117,  // Delete (forward delete)
        0x24 => 115,  // Home
        0x23 => 119,  // End
        0x21 => 116,  // Page Up
        0x22 => 121,  // Page Down
        0x25 => 123,  // Left
        0x26 => 126,  // Up
        0x27 => 124,  // Right
        0x28 => 125,  // Down
        0xC0 => 50,   // ` (backtick)
        _ => return None,
    })
}

/// Is this key held down right now? (virtual-key codes of Windows, as the pages speak them: 0x10 Shift, 0x11 Ctrl = Control, 0x12 Alt = Option; the mouse
/// buttons 0x01 left, 0x02 right, 0x04 middle; letters, digits, F keys, Enter, Esc, the arrows and the like through mac_key.)
pub fn key_down(vk: i32) -> bool {
    match vk {
        0x10 | 0x11 | 0x12 => {
            let flags = unsafe { CGEventSourceFlagsState(1) };      // 1 = the state of the keyboard hardware
            flags & match vk { 0x10 => FLAG_SHIFT, 0x11 => FLAG_CONTROL, _ => FLAG_OPTION } != 0
        }
        0x01 => unsafe { CGEventSourceButtonState(1, 0) },      // left
        0x02 => unsafe { CGEventSourceButtonState(1, 1) },      // right
        0x04 => unsafe { CGEventSourceButtonState(1, 2) },      // middle
        _ => match mac_key(vk) { Some(k) => unsafe { CGEventSourceKeyState(1, k) }, None => false },
    }
}

// ------------------------------------------------------------------------------------------------- the windows of the system
#[derive(Clone, Debug, Default)]
struct SysWin { number: u32, pid: i32, layer: i32, owner: String, name: String, x: f64, y: f64, w: f64, h: f64 }

static WINDOWS: Mutex<Option<(Instant, Vec<SysWin>)>> = Mutex::new(None);

fn num_i(d: &CFDictionary<CFString, CFType>, key: *const c_void) -> Option<i64> {
    let k = unsafe { CFString::wrap_under_get_rule(key as _) };
    d.find(&k).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64())
}
fn text_of(d: &CFDictionary<CFString, CFType>, key: *const c_void) -> String {
    let k = unsafe { CFString::wrap_under_get_rule(key as _) };
    d.find(&k).and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string()).unwrap_or_default()
}

/// The windows on the screen, front to back (asked at most every 50 ms: the pages ask often).
fn windows() -> Vec<SysWin> {
    if let Ok(g) = WINDOWS.lock() {
        if let Some((at, list)) = g.as_ref() { if at.elapsed() < Duration::from_millis(50) { return list.clone(); } }
    }
    let mut out = Vec::new();
    let opts = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    if let Some(list) = copy_window_info(opts, kCGNullWindowID) {
        let list: CFArray<*const c_void> = list;
        for item in list.iter() {
            let d: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(*item as _) };
            let number = unsafe { num_i(&d, kCGWindowNumber as _) };
            let pid = unsafe { num_i(&d, kCGWindowOwnerPID as _) };
            let (Some(number), Some(pid)) = (number, pid) else { continue };
            let layer = unsafe { num_i(&d, kCGWindowLayer as _) }.unwrap_or(0);
            let (mut x, mut y, mut w, mut h) = (0.0, 0.0, 0.0, 0.0);
            let bk = unsafe { CFString::wrap_under_get_rule(kCGWindowBounds as _) };
            if let Some(b) = d.find(&bk).and_then(|v| v.downcast::<CFDictionary>()) {
                let b: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_get_rule(b.as_concrete_TypeRef()) };
                let f = |name: &str| b.find(&CFString::new(name)).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_f64()).unwrap_or(0.0);
                x = f("X"); y = f("Y"); w = f("Width"); h = f("Height");
            }
            out.push(SysWin {
                number: number as u32, pid: pid as i32, layer: layer as i32,
                owner: unsafe { text_of(&d, kCGWindowOwnerName as _) }, name: unsafe { text_of(&d, kCGWindowName as _) }, x, y, w, h,
            });
        }
    }
    if let Ok(mut g) = WINDOWS.lock() { *g = Some((Instant::now(), out.clone())); }
    out
}

fn window_by_number(number: isize) -> Option<SysWin> {
    if number <= 0 { return None; }
    windows().into_iter().find(|w| w.number as isize == number)
}

fn front_pid() -> i32 {
    on_main(|| unsafe {
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut AnyObject = msg_send![&*ws, frontmostApplication];
        if app.is_null() { return -1; }
        let pid: i32 = msg_send![&*app, processIdentifier];
        pid
    })
}

/// The window of the program in front: its biggest ordinary window (0 when there is none).
pub fn foreground() -> isize {
    let pid = front_pid();
    windows().into_iter().filter(|w| w.pid == pid && w.layer == 0).max_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h))).map(|w| w.number as isize).unwrap_or(0)
}

/// Does this window belong to this program?
pub fn is_mine(hwnd: isize) -> bool {
    window_by_number(hwnd).map(|w| w.pid as u32 == std::process::id()).unwrap_or(false)
}

pub fn window_title(hwnd: isize) -> String {
    window_by_number(hwnd).map(|w| w.name).unwrap_or_default()
}

/// The name of the program a window belongs to, lower case ("world of warcraft"); "" when unknown.
pub fn exe_of(hwnd: isize) -> String {
    window_by_number(hwnd).map(|w| w.owner.to_lowercase()).unwrap_or_default()
}

// ------------------------------------------------------------------------------------------------- the game window
/// What the search for the game window found: the window number, its rectangle in pixels (None when it cannot be seen), program, title.
pub struct GameWindow { pub hwnd: isize, pub rect: Option<[i32; 4]>, pub exe: String, pub title: String }

fn describe_game(w: &SysWin) -> GameWindow {
    let s = scale();
    GameWindow { hwnd: w.number as isize, rect: Some([(w.x * s).round() as i32, (w.y * s).round() as i32, (w.w * s).round() as i32, (w.h * s).round() as i32]), exe: w.owner.to_lowercase(), title: w.name.clone() }
}

/// The game: `known` (the window found last time) while it is still on the screen; else the biggest ordinary window of a program named "wow..."
/// or "World of Warcraft", else one with exactly this title.
pub fn find_game(known: isize, title: &str) -> Option<GameWindow> {
    if let Some(w) = window_by_number(known) { return Some(describe_game(&w)); }
    let me = std::process::id() as i32;
    let want = title.trim().to_lowercase();
    let (mut by_app, mut by_title): (Vec<SysWin>, Vec<SysWin>) = (vec![], vec![]);
    for w in windows() {
        if w.pid == me || w.layer != 0 || w.w * w.h < 200.0 * 100.0 { continue; }
        let owner = w.owner.to_lowercase();
        if owner.starts_with("wow") || owner == "world of warcraft" { by_app.push(w); }
        else if !want.is_empty() && w.name.trim().to_lowercase() == want { by_title.push(w); }
    }
    let pool = if by_app.is_empty() { by_title } else { by_app };
    pool.iter().max_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h))).map(describe_game)
}

// ------------------------------------------------------------------------------------------------- our windows
const LEVEL_NORMAL: isize = 0;
const LEVEL_FLOATING: isize = 3;
static KEEP: Mutex<Vec<isize>> = Mutex::new(Vec::new());
static PANELS: Mutex<Vec<isize>> = Mutex::new(Vec::new());
static PANEL_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Called once at the start with the program folder. An empty file `mac_no_panel` there switches the "panel" change of the windows off (a way out
/// in case it does not work on some system).
pub fn configure(base: &std::path::Path) {
    PANEL_ENABLED.store(!base.join("mac_no_panel").exists(), Ordering::SeqCst);
}

/// A window that takes clicks WITHOUT making this program the active one: it becomes an NSPanel with the "non-activating" style (what a Qt tool window
/// is on macOS, which the 2.x reader used). Else a click on it (or moving it) activates this program, and while the game is full screen the Dock and
/// the menu bar come up and the game loses the keyboard.
fn make_panel(hwnd: isize) {
    if !PANEL_ENABLED.load(Ordering::SeqCst) { return; }
    if PANELS.lock().map(|l| l.contains(&hwnd)).unwrap_or(true) { return; }
    unsafe {
        let w = obj(hwnd);
        let panel = class!(NSPanel);
        let is_panel: Bool = msg_send![w, isKindOfClass: panel];
        if !is_panel.as_bool() {
            // (the window class of the window library is a subclass of NSWindow; NSPanel is one as well, with the same memory layout)
            object_setClass(hwnd as *mut AnyObject, panel as *const _ as *const c_void);
        }
        let mask: usize = msg_send![w, styleMask];
        let _: () = msg_send![w, setStyleMask: mask | (1usize << 7)];                // NSWindowStyleMaskNonactivatingPanel
        let _: () = msg_send![w, setBecomesKeyOnlyIfNeeded: Bool::YES];
        let _: () = msg_send![w, setFloatingPanel: Bool::NO];                          // (the level is set by the program, see set_topmost)
        // The style bit alone is not taken in by the window server for a window that was made as an ordinary window: NSPanel's own private call (what
        // the Wine macOS driver does after it changes the bit) and the window tag of the server tell it.
        let can: Bool = msg_send![w, respondsToSelector: sel!(_setPreventsActivation:)];
        if can.as_bool() { let _: () = msg_send![w, _setPreventsActivation: Bool::YES]; }
    }
    if let Ok(mut l) = PANELS.lock() { l.push(hwnd); }
    prevent_activation(hwnd);
}

static TAGGED: Mutex<Vec<(isize, isize)>> = Mutex::new(Vec::new());      // (window, its window number when the tag was put)

/// The window server's tag "does not activate the program": needs the window number, which a window gets only once it is shown, so it is tried again
/// at every call (set_noactivate, keep_style) until it has been put for the number the window has now.
fn prevent_activation(hwnd: isize) {
    if !PANEL_ENABLED.load(Ordering::SeqCst) { return; }
    let number: isize = unsafe { msg_send![obj(hwnd), windowNumber] };
    if number <= 0 { return; }
    if TAGGED.lock().map(|l| l.contains(&(hwnd, number))).unwrap_or(true) { return; }
    let tags: [i32; 2] = [1 << 16, 0];
    unsafe { CGSSetWindowTags(CGSDefaultConnectionForThread(), number as i32, tags.as_ptr(), 32); }
    if let Ok(mut l) = TAGGED.lock() { l.retain(|e| e.0 != hwnd); l.push((hwnd, number)); }
}

fn prepare(hwnd: isize) {
    unsafe {
        let w = obj(hwnd);
        let _: () = msg_send![w, setHidesOnDeactivate: Bool::NO];                  // (a tool window is hidden while another program is active)
        let behavior: usize = (1 << 0) | (1 << 8) | (1 << 6);                      // CanJoinAllSpaces | FullScreenAuxiliary | IgnoresCycle
        let _: () = msg_send![w, setCollectionBehavior: behavior];
        let _: () = msg_send![w, setHasShadow: Bool::NO];                          // (a translucent window gets a dark outline from the system's shadow)
    }
}

/// The transparency of a window (0 = invisible, 1 = opaque). A window that is a little bit visible still counts as "seen" for the system (and its page
/// is not slowed down), a fully transparent one may not.
pub fn set_alpha(hwnd: isize, alpha: f64) {
    on_main(|| unsafe { let _: () = msg_send![obj(hwnd), setAlphaValue: alpha]; });
}

/// A window the mouse goes through (click-through): the clicks and the wheel go to what is behind it.
pub fn set_clickthrough(hwnd: isize, on: bool) {
    on_main(|| unsafe { let _: () = msg_send![obj(hwnd), setIgnoresMouseEvents: Bool::new(on)]; });
}

static ACTIVITY: Mutex<usize> = Mutex::new(0);

/// Tells the system that this program is doing work the user waits for (reading the game's screen): "App Nap" (the system slows down programs that are
/// not in front) is off, and timers are not delayed. Called once at the start; the activity lasts until the program ends.
pub fn keep_awake() {
    on_main(|| unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        // NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical
        let options: u64 = 0x00EF_FFFF | 0xFF_0000_0000;
        let token: *mut AnyObject = msg_send![&*info, beginActivityWithOptions: options, reason: ns_string("ChatMatrix reads the screen of the game")];
        if !token.is_null() {
            let kept: *mut AnyObject = msg_send![&*token, retain];
            if let Ok(mut a) = ACTIVITY.lock() { *a = kept as usize; }
        }
    });
}

// ---- a window that is never the key window (and so never takes the keyboard from the game) unless it is told that a text box of its page needs it.
// NOT done by changing the class of the window (object_setClass): the web view of the window watches the window with key-value observing, which is tied to the class, and a
// window whose class was changed makes the program abort when the web view leaves it ("Cannot remove an observer ... because it is not registered"). Instead the method
// canBecomeKeyWindow of the window's class is replaced by one that asks a list first and calls the old method for every window that is not in the list.
static KEY_ALLOWED: Mutex<Vec<isize>> = Mutex::new(Vec::new());
static NO_KEY: Mutex<Vec<isize>> = Mutex::new(Vec::new());
static ORIGINALS: Mutex<Vec<(usize, usize)>> = Mutex::new(Vec::new());          // (class, the method it had)
extern "C" {
    fn object_getClass(obj: *const AnyObject) -> *const c_void;
    fn class_getSuperclass(cls: *const c_void) -> *const c_void;
    fn class_getName(cls: *const c_void) -> *const c_char;
    fn class_getInstanceMethod(cls: *const c_void, name: Sel) -> *const c_void;
    fn method_getImplementation(m: *const c_void) -> *const c_void;
    fn method_getTypeEncoding(m: *const c_void) -> *const c_char;
    fn class_replaceMethod(cls: *const c_void, name: Sel, imp: *const c_void, types: *const c_char) -> *const c_void;
}
extern "C" fn can_become_key(this: *mut AnyObject, cmd: Sel) -> Bool {
    let me = this as isize;
    if NO_KEY.lock().map(|l| l.contains(&me)).unwrap_or(false) {
        return Bool::new(KEY_ALLOWED.lock().map(|l| l.contains(&me)).unwrap_or(false));
    }
    // a window that is not one of these: what its class did before
    let mut cls = unsafe { object_getClass(this) };
    while !cls.is_null() {
        let orig = ORIGINALS.lock().ok().and_then(|l| l.iter().find(|e| e.0 == cls as usize).map(|e| e.1));
        if let Some(f) = orig {
            let f: extern "C" fn(*mut AnyObject, Sel) -> Bool = unsafe { std::mem::transmute(f) };
            return f(this, cmd);
        }
        cls = unsafe { class_getSuperclass(cls) };
    }
    Bool::YES
}
/// The window becomes one that does not become the key window (a click on its page does not give it the keyboard). Before set_noactivate_light.
/// (Windows: a web window is kept from being brought over its center by a press, see win.rs guard_z. The Mac cannot be kept from it: what is over its center is put back by the loop of center.rs.)
pub fn guard_z(_hwnd: isize, _label: &str) {}
pub fn set_not_rude(_hwnd: isize) {}
pub fn no_transitions(_hwnd: isize) {}
pub fn show_below(_hwnd: isize, _above: isize) {}
pub fn describe(hwnd: isize) -> String { if hwnd == 0 { "none".into() } else { format!("program {}", exe_of(hwnd)) } }          // (only for the log)
pub fn owner_of(_hwnd: isize) -> isize { 0 }
pub fn is_topmost(hwnd: isize) -> bool { on_main(|| unsafe { let level: isize = msg_send![obj(hwnd), level]; level >= LEVEL_FLOATING }) }
pub fn z_order_global(hwnds: &[isize]) -> Vec<isize> { z_order(hwnds) }          // (only for the log: the windows of the list that are on the screen, from the front)
pub fn window_at(_x: i32, _y: i32) -> isize { 0 }
pub fn is_visible(_hwnd: isize) -> bool { true }
pub fn short(hwnd: isize) -> String { exe_of(hwnd) }
pub fn top_windows(_n: usize) -> Vec<isize> { Vec::new() }
pub fn focus_owner() -> (isize, isize) { (0, 0) }
pub fn make_no_key(hwnd: isize) {
    on_main(|| unsafe {
        let mut cls = object_getClass(hwnd as *const AnyObject);
        // (a window that is watched by key-value observing has a class made by the system on top of its own: the method goes to the window's own class)
        if CStr::from_ptr(class_getName(cls)).to_string_lossy().starts_with("NSKVONotifying_") { cls = class_getSuperclass(cls); }
        let have = ORIGINALS.lock().map(|l| l.iter().any(|e| e.0 == cls as usize)).unwrap_or(true);
        if !have {
            let m = class_getInstanceMethod(cls, sel!(canBecomeKeyWindow));
            if !m.is_null() {
                let orig = method_getImplementation(m) as usize;
                if let Ok(mut l) = ORIGINALS.lock() { l.push((cls as usize, orig)); }
                class_replaceMethod(cls, sel!(canBecomeKeyWindow), can_become_key as extern "C" fn(*mut AnyObject, Sel) -> Bool as *const c_void, method_getTypeEncoding(m));
            }
        }
        if let Ok(mut l) = NO_KEY.lock() { if !l.contains(&hwnd) { l.push(hwnd); } }
    });
}
/// A window that is being faded (the web window of the mini browser): while it is less than solid it is NOT "opaque", when it is solid again it is. Left "opaque" while it is see-through, the system
/// draws the window against black instead of what is behind it: the page darkens instead of fading (found out by trying: the other ways to draw it again did not help).
pub fn fade_begin(hwnd: isize) {
    on_main(|| unsafe { let _: () = msg_send![obj(hwnd), setOpaque: Bool::NO]; });
}
pub fn fade_end(hwnd: isize) {
    on_main(|| unsafe { let _: () = msg_send![obj(hwnd), setOpaque: Bool::YES]; });
}

/// The page of the window has a text box that needs the keyboard (true), or it does not any more (false).
pub fn allow_key(hwnd: isize, on: bool) {
    if let Ok(mut l) = KEY_ALLOWED.lock() { l.retain(|&h| h != hwnd); if on { l.push(hwnd); } }
}
/// A window of ours is going away: no list keeps its address any more (a later call must not touch it).
pub fn forget(hwnd: isize) {
    if let Ok(mut l) = KEEP.lock() { l.retain(|&h| h != hwnd); }
    if let Ok(mut l) = PANELS.lock() { l.retain(|&h| h != hwnd); }
    if let Ok(mut l) = KEY_ALLOWED.lock() { l.retain(|&h| h != hwnd); }
    if let Ok(mut l) = NO_KEY.lock() { l.retain(|&h| h != hwnd); }
    if let Ok(mut l) = TAGGED.lock() { l.retain(|e| e.0 != hwnd); }
}

/// A window of ours that must not take the game's keyboard or hide while the game is in front. (On Windows: the "no activate" style.)
pub fn set_noactivate(hwnd: isize, on: bool) {
    if let Ok(mut l) = KEEP.lock() {
        l.retain(|&h| h != hwnd);
        if on { l.push(hwnd); }
    }
    if on { on_main(|| { make_panel(hwnd); prevent_activation(hwnd); prepare(hwnd); }); }
}

/// Like set_noactivate but WITHOUT turning the window into a panel (no change of its class: see make_no_key). For the window of the web: the window server's tag, "not hidden
/// when another program is active" and the kept style are enough together with make_no_key.
pub fn set_noactivate_light(hwnd: isize, on: bool) {
    if let Ok(mut l) = KEEP.lock() {
        l.retain(|&h| h != hwnd);
        if on { l.push(hwnd); }
    }
    if on { on_main(|| { prevent_activation(hwnd); prepare(hwnd); }); }
    else {
        // The window may be activated by a click now (a text box of its page: the web window, see webwin.rs "prep"): the window server's tag "does not activate the program" is taken off,
        // and put again by the next call with `on` (TAGGED forgets the window).
        on_main(|| unsafe {
            let number: isize = msg_send![obj(hwnd), windowNumber];
            if number <= 0 { return; }
            let tags: [i32; 2] = [1 << 16, 0];
            CGSClearWindowTags(CGSDefaultConnectionForThread(), number as i32, tags.as_ptr(), 32);
            if let Ok(mut l) = TAGGED.lock() { l.retain(|e| e.0 != hwnd); }
        });
    }
}

/// Every poll of the page: the window stays what it was made (the window library may change it when it changes one of its own flags).
pub fn keep_style(hwnd: isize) {
    let wanted = KEEP.lock().map(|l| l.contains(&hwnd)).unwrap_or(false);
    if !wanted { return; }
    on_main(|| unsafe {
        let w = obj(hwnd);
        let hides: Bool = msg_send![w, hidesOnDeactivate];
        if hides.as_bool() { let _: () = msg_send![w, setHidesOnDeactivate: Bool::NO]; }
        prevent_activation(hwnd);
    });
}

/// The window level, plus 0x100 when the window is a non-activating panel (for the diagnosis in the options).
pub fn ex_style(hwnd: isize) -> isize {
    let panel = PANELS.lock().map(|l| l.contains(&hwnd)).unwrap_or(false);
    on_main(|| unsafe { let level: isize = msg_send![obj(hwnd), level]; level | if panel { 0x100 } else { 0 } })
}

/// No owner windows on macOS: "above the game" is done with the window order (place_above).
pub fn set_owner(_hwnd: isize, _owner: isize) {}

/// Blurs what is behind a window. state: 3 = blur, 4 = stronger; the tint (r, g, b, alpha) is not used here. on = false switches it off.
pub fn set_blur(hwnd: isize, on: bool, state: i32, _r: u8, _g: u8, _b: u8, _alpha: f64) -> bool {
    on_main(|| unsafe {
        let w = obj(hwnd);
        let _: () = msg_send![w, setOpaque: Bool::NO];                          // (the window must not be opaque)
        let number: isize = msg_send![w, windowNumber];
        let radius = if !on { 0 } else if state >= 4 { 40 } else { 14 };
        CGSSetWindowBackgroundBlurRadius(CGSDefaultConnectionForThread(), number as i32, radius) == 0
    })
}

/// (Windows only: the client area of a window is put at an exact rectangle; a window here has no frame of its own that would be in the way)
pub fn set_client_rect(_hwnd: isize, _x: i32, _y: i32, _w: i32, _h: i32) -> bool { false }

/// `hwnd` goes directly below `above` without taking the focus.
pub fn place_below(hwnd: isize, above: isize) {
    on_main(|| unsafe {
        let n: isize = msg_send![obj(above), windowNumber];
        let _: () = msg_send![obj(hwnd), orderWindow: -1isize, relativeTo: n];             // NSWindowBelow
    });
}

/// The window goes to the top of the ordinary windows without taking the focus.
pub fn raise_top(hwnd: isize) {
    on_main(|| unsafe { let _: () = msg_send![obj(hwnd), orderFrontRegardless]; });
}

/// The windows of `hwnds` that are on the screen, from the front to the back (the order the system has them in now).
pub fn z_order(hwnds: &[isize]) -> Vec<isize> {
    on_main(|| unsafe {
        let list = windows();
        let mut ranked: Vec<(usize, isize)> = hwnds.iter().filter_map(|&h| {
            let n: isize = msg_send![obj(h), windowNumber];
            list.iter().position(|x| x.number as isize == n).map(|p| (p, h))
        }).collect();
        ranked.sort();
        ranked.into_iter().map(|(_, h)| h).collect()
    })
}

/// Topmost on / off for a window. On: the level of floating windows (above the game, also while another program is in front). Off: an ordinary
/// window; with `game` it is put directly above the game window.
pub fn set_topmost(hwnd: isize, on: bool, game: isize) {
    on_main(|| unsafe {
        let w = obj(hwnd);
        if on {
            let _: () = msg_send![w, setLevel: LEVEL_FLOATING];
            let _: () = msg_send![w, orderFrontRegardless];
        } else {
            let _: () = msg_send![w, setLevel: LEVEL_NORMAL];
            if game > 0 { let _: () = msg_send![w, orderWindow: 1isize, relativeTo: game]; }      // NSWindowAbove
        }
    });
}

/// A small window that must be seen over everything of ours (the address box over the center): a level above the floating windows, to the front.
pub fn raise_above_all(hwnd: isize) {
    on_main(|| unsafe {
        let w = obj(hwnd);
        let _: () = msg_send![w, setLevel: LEVEL_FLOATING + 1];
        let _: () = msg_send![w, orderFrontRegardless];
    });
}

/// Dark title bar of the options window.
pub fn style_caption(hwnd: isize) {
    on_main(|| unsafe {
        let name = ns_string("NSAppearanceNameDarkAqua");
        let appearance: *mut AnyObject = msg_send![class!(NSAppearance), appearanceNamed: name];
        if !appearance.is_null() { let _: () = msg_send![obj(hwnd), setAppearance: appearance]; }
    });
}

/// Makes this window of ours the key window although the game has the keyboard: the program is activated. (macOS 14 and later let a program take the
/// focus from another only when that one yields: the old SetFrontProcess call is the one that still works - what the 2.x reader found out.)
pub fn grab_focus(hwnd: isize) -> bool {
    on_main(|| unsafe {
        let app = shared_app();
        let _: () = msg_send![app, activateIgnoringOtherApps: Bool::YES];
        let mut psn = [0u32; 2];
        GetCurrentProcess(&mut psn);
        SetFrontProcess(&psn);
        // (the system takes its time to make a program active when another one - the game - has the keyboard: up to 0.6 s, usually a fraction of it)
        for _ in 0..60 {
            let active: Bool = msg_send![app, isActive];
            if active.as_bool() { break; }
            pump(0.01);
        }
        let w = obj(hwnd);
        let nothing: *const AnyObject = std::ptr::null();
        let _: () = msg_send![w, makeKeyAndOrderFront: nothing];
        let active: Bool = msg_send![app, isActive];
        active.as_bool()
    })
}

/// Does this window of ours have the keyboard now: it is the key window and this program is the active one. (No waiting: the system takes its time, see ask_keyboard.)
pub fn has_keyboard(hwnd: isize) -> bool {
    on_main(|| unsafe {
        let key: Bool = msg_send![obj(hwnd), isKeyWindow];
        let active: Bool = msg_send![shared_app(), isActive];
        key.as_bool() && active.as_bool()
    })
}

/// Asks once more for the keyboard: this window to be the key window (the system may take a second or more to do it; the box asks again every 0.2 s until it has it).
pub fn ask_keyboard(hwnd: isize) {
    on_main(|| unsafe {
        let nothing: *const AnyObject = std::ptr::null();
        let _: () = msg_send![obj(hwnd), makeKeyAndOrderFront: nothing];
    });
}

/// Is this program the one in front? (`foreground` is no help: it looks for an ordinary window of the front program, and the send box is a floating one.)
pub fn self_front() -> bool {
    front_pid() == std::process::id() as i32
}

/// Gives the keyboard back to the game (`hwnd` is the window number of the game window). Does not wait.
pub fn set_foreground(hwnd: isize) -> bool {
    let Some(game) = window_by_number(hwnd) else { return false };
    on_main(|| unsafe {
        let running: *mut AnyObject = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: game.pid];
        if running.is_null() { return false; }
        let app = shared_app();
        let can: Bool = msg_send![app, respondsToSelector: sel!(yieldActivationToApplication:)];
        if can.as_bool() { let _: () = msg_send![app, yieldActivationToApplication: running]; }
        let ok: Bool = msg_send![&*running, activateWithOptions: 2usize];        // NSApplicationActivateIgnoringOtherApps
        ok.as_bool()
    })
}

/// Presses Cmd+V in whatever program has the keyboard. Needs the permission to "post events" (the system asks once).
pub fn send_ctrl_v() -> bool {
    unsafe {
        if !CGPreflightPostEventAccess() {
            CGRequestPostEventAccess();
            return false;
        }
    }
    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else { return false };
    for down in [true, false] {
        let Ok(event) = CGEvent::new_keyboard_event(source.clone(), 9, down) else { return false };      // 9 = the V key
        event.set_flags(CGEventFlags::CGEventFlagCommand);
        event.post(CGEventTapLocation::HID);
    }
    true
}

/// The names of the font families installed, sorted, each once.
pub fn installed_fonts() -> Vec<String> {
    let mut out: Vec<String> = on_main(|| unsafe {
        let manager: *mut AnyObject = msg_send![class!(NSFontManager), sharedFontManager];
        let families: *mut AnyObject = msg_send![&*manager, availableFontFamilies];
        let count: usize = msg_send![&*families, count];
        (0..count).map(|i| { let s: *mut AnyObject = msg_send![&*families, objectAtIndex: i]; string_of(s) }).filter(|s| !s.is_empty() && !s.starts_with('.')).collect()
    });
    out.sort_by_key(|s| s.to_lowercase());
    out.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    out
}

// ------------------------------------------------------------------------------------------------- the wheel over a click-through window
// A click-through window gets no mouse events, so the wheel over it would go to the game. An event tap (its own thread) sees every wheel turn of the session: a window
// that asked for it (a pane of a control center that is click-through: set_pane_zones) has the turns over it taken away from the game (the tap swallows them) and told to its page at once (the sink: main.rs emits
// 'wheel-turn' to it). Same job as the
// mouse hook of win.rs. The tap can change events, so it needs the permission "Accessibility" (the one the auto-paste asks for) and may ask for "Input Monitoring":
// it is made when the first window asks for the wheel (not at the start), and tried again every 3 s while it cannot be made.
static ASKED_SCREEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static WHEEL_SEQ: AtomicU64 = AtomicU64::new(0);
static WHEEL: Mutex<Vec<(u64, isize, i16)>> = Mutex::new(Vec::new());                  // (number, window, delta in the units of Windows: 120 = one notch)
static ZONES: Mutex<Vec<(isize, bool, [f64; 4])>> = Mutex::new(Vec::new());            // (window, the turns DOWN too, its rectangle l, t, r, b in points, top left origin)
static TAP: std::sync::atomic::AtomicPtr<c_void> = std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());
static HOOK: Mutex<Option<(bool, Instant)>> = Mutex::new(None);                        // (made?, when it was tried): None = never tried
static ASKED_LISTEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SINK: std::sync::OnceLock<Box<dyn Fn(isize, i16) + Send + Sync>> = std::sync::OnceLock::new();
/// A turn of the wheel that was taken for a window is passed to this function at once (the window, the delta in Windows units).
pub fn set_wheel_sink(f: impl Fn(isize, i16) + Send + Sync + 'static) { let _ = SINK.set(Box::new(f)); }
// A trackpad gesture belongs to the window that got its first event, to the end (the fingers up and the glide after it): once a turn was taken, the events that
// follow within 0.25 s are taken for the same window wherever the cursor is, else the rest of a gesture goes to the game (a zoom) the moment the window changes.
static LOCK: Mutex<Option<(isize, Instant)>> = Mutex::new(None);
const GESTURE_GAP: Duration = Duration::from_millis(250);

type TapCallback = extern "C" fn(proxy: *mut c_void, kind: u32, event: *mut c_void, info: *mut c_void) -> *mut c_void;
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, events: u64, callback: TapCallback, info: *mut c_void) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    fn CGRequestListenEventAccess() -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: *mut c_void, order: isize) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: *const c_void;
}

const EVENT_SCROLL: u32 = 22;
const TAP_DISABLED_TIMEOUT: u32 = 0xFFFF_FFFE;
const TAP_DISABLED_USER: u32 = 0xFFFF_FFFF;
const FIELD_DELTA_AXIS_1: u32 = 11;
const FIELD_IS_CONTINUOUS: u32 = 88;
const FIELD_POINT_DELTA_AXIS_1: u32 = 96;

extern "C" fn wheel_tap(_proxy: *mut c_void, kind: u32, event: *mut c_void, _info: *mut c_void) -> *mut c_void {
    unsafe {
        if kind == TAP_DISABLED_TIMEOUT || kind == TAP_DISABLED_USER {          // (the system switches a tap off that was too slow, or by the user's input: on again)
            let tap = TAP.load(Ordering::SeqCst);
            if !tap.is_null() { CGEventTapEnable(tap, true); }
            return event;
        }
        if kind != EVENT_SCROLL { return event; }
        // positive = the content goes down = what is above comes into view (the system has already applied the "natural scrolling" setting): the same as the turn UP of Windows
        let continuous = CGEventGetIntegerValueField(event, FIELD_IS_CONTINUOUS) != 0;
        let mut delta = CGEventGetIntegerValueField(event, FIELD_POINT_DELTA_AXIS_1);
        if delta == 0 { delta = CGEventGetIntegerValueField(event, FIELD_DELTA_AXIS_1) * 10; }
        if delta == 0 { return event; }
        // the page scrolls units x 100 / 120 pixels: a wheel notch (about 10 points) is a notch of Windows, a trackpad moves as far as the fingers do
        let units = (delta as f64 * if continuous { 1.2 } else { 12.0 }).round().clamp(-32000.0, 32000.0) as i16;
        let at = CGEventGetLocation(event);
        let mut target: Option<isize> = None;
        if let Ok(lock) = LOCK.try_lock() {
            if let Some((h, at_t)) = *lock { if at_t.elapsed() < GESTURE_GAP { target = Some(h); } }
        }
        if target.is_none() {
            if let Ok(zones) = ZONES.try_lock() {
                for &(h, _down, r) in zones.iter() {
                    if at.x >= r[0] && at.x < r[2] && at.y >= r[1] && at.y < r[3] {
                        // a window of another program (the Finder, a browser) stands over the center here: the turn is for it, not for the window under it. Not locked either: the next turn of the gesture asks again.
                        let center = (-h) / 100000 - 1;
                        if covered_by_other(center, at.x, at.y) { continue; }
                        target = Some(h); break;
                    }
                }
            }
        }
        let Some(h) = target else { return event };
        if let Ok(mut lock) = LOCK.try_lock() { *lock = Some((h, Instant::now())); }
        match SINK.get() {
            Some(f) => f(h, units),
            None => if let Ok(mut list) = WHEEL.try_lock() {
                list.push((WHEEL_SEQ.fetch_add(1, Ordering::SeqCst) + 1, h, units));
                if list.len() > 200 { list.remove(0); }
            },
        }
        std::ptr::null_mut()                                                      // the program in front does not get this turn
    }
}

/// Makes the tap (in a thread of its own, which then serves it). true = it runs. Not made yet: false, and the permission is asked for once; tried again after 3 s.
fn ensure_hook() -> bool {
    if let Ok(h) = HOOK.lock() {
        match *h {
            Some((true, _)) => return true,
            Some((false, at)) if at.elapsed() < Duration::from_secs(3) => return false,
            _ => {}
        }
    }
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    std::thread::spawn(move || unsafe {
        // session tap, at the head, one that may change events; only the wheel
        let tap = CGEventTapCreate(1, 0, 0, 1u64 << EVENT_SCROLL, wheel_tap, std::ptr::null_mut());
        if tap.is_null() { let _ = tx.send(false); return; }
        TAP.store(tap, Ordering::SeqCst);
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        let _ = tx.send(true);
        CFRunLoopRun();
    });
    let made = rx.recv_timeout(Duration::from_millis(500)).unwrap_or(false);
    if !made && !ASKED_LISTEN.swap(true, Ordering::SeqCst) {
        unsafe { CGRequestListenEventAccess(); CGRequestPostEventAccess(); }       // (the system asks the user once: Input Monitoring, Accessibility)
    }
    if let Ok(mut h) = HOOK.lock() { *h = Some((made, Instant::now())); }
    made
}

pub fn start_wheel_hook() {}

/// The panes of a control center that want the wheel (in place of the earlier ones of that center): (key, rectangle in pixels). The tap works in points (top left origin).
/// false = the tap cannot be had yet (no permission).
static CENTER_NUMS: Mutex<Vec<(isize, isize, isize)>> = Mutex::new(Vec::new());        // the window of each control center: (center, handle, the number the system has for it)
/// The window of a control center (told by the page of the center): the wheel is not taken where a window of another program stands over it. The number is asked for once for a window (the main thread
/// is asked: not from the tap).
pub fn set_center_hwnd(center: isize, hwnd: isize) {
    if CENTER_NUMS.lock().map(|l| l.iter().any(|e| e.0 == center && e.1 == hwnd)).unwrap_or(false) { return; }
    let number: isize = on_main(|| unsafe { let n: isize = msg_send![obj(hwnd), windowNumber]; n });
    if let Ok(mut l) = CENTER_NUMS.lock() { l.retain(|e| e.0 != center); l.push((center, hwnd, number)); }
}

/// Does a window of another program stand over the window of this center at this point (points, top left origin)? The windows on the screen from the front to the back (windows(): the system's own order) are
/// looked at until the center is reached: the first one of another program, in the layers of the windows and the bars of the menu and the dock (not the layers of the screen saver and the pointer), that has the
/// point inside is it. The windows of this program are not counted (the centers go through the mouse; the other windows of ours stand under the mouse of the wheel as they did).
fn covered_by_other(center: isize, x: f64, y: f64) -> bool {
    let number = CENTER_NUMS.try_lock().ok().and_then(|l| l.iter().find(|e| e.0 == center).map(|e| e.2)).unwrap_or(0);
    if number <= 0 { return false; }
    let me = std::process::id() as i32;
    for w in windows() {
        if w.number as isize == number { return false; }                             // (the center itself: nothing above it covers)
        if w.pid == me || w.layer >= 100 || w.w < 1.0 || w.h < 1.0 { continue; }
        if x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h { return true; }
    }
    false
}

pub fn set_pane_zones(center: isize, zones: Vec<(isize, [f64; 4])>) -> bool {
    let owner = |k: isize| (-k) / 100000 - 1 == center;
    if zones.is_empty() {
        if let Ok(mut z) = ZONES.lock() { z.retain(|e| !(e.0 < 0 && owner(e.0))); }
        return true;
    }
    if !ensure_hook() { return false; }
    let s = scale();
    if let Ok(mut z) = ZONES.lock() {
        z.retain(|e| !(e.0 < 0 && owner(e.0)));
        z.extend(zones.into_iter().map(|(k, r)| (k, true, [r[0] / s, r[1] / s, r[2] / s, r[3] / s])));
    }
    true
}
/// (the turns come one by one through the sink on macOS)
pub fn wheel_since_panes(seq: u64) -> (u64, Vec<(isize, i16)>) { (seq, Vec::new()) }

// ------------------------------------------------------------------------------------------------- the options hot key
/// Not used on macOS: main.rs registers Ctrl+Option+O with the system's hot key service (no permission needed).
pub fn start_options_hotkey(_callback: impl Fn() + Send + 'static) -> bool { false }

// ------------------------------------------------------------------------------------------------- one program at a time
/// true when this is the first copy: a lock on a file in the temporary folder, held until the program ends (the system lets go when it dies).
pub fn first_instance() -> bool {
    use std::os::unix::io::AsRawFd;
    let path = std::env::temp_dir().join("chatmatrixreader.lock");
    let Ok(file) = std::fs::OpenOptions::new().create(true).write(true).open(path) else { return true };
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    if locked { std::mem::forget(file); }                      // (the lock lives as long as the descriptor: never closed)
    locked
}

/// A small message box (before the program has a window).
pub fn message(title: &str, text: &str) {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("display dialog \"{}\" with title \"{}\" buttons {{\"OK\"}} default button \"OK\" with icon note", esc(text), esc(title));
    let _ = std::process::Command::new("osascript").arg("-e").arg(script).status();
}
