//! Everything that calls Windows directly. No Tauri in here, and no external crate:
//! the handful of Win32 functions are declared by hand, so this file does not depend on any library version.
#![allow(non_snake_case, dead_code)]
use std::ffi::c_void;

type Handle = isize; // HWND / HDC / HBITMAP are all pointer-sized

#[repr(C)]
struct POINT { x: i32, y: i32 }

#[repr(C)]
#[derive(Default)]
struct RECT { left: i32, top: i32, right: i32, bottom: i32 }

#[repr(C)]
struct BITMAPINFOHEADER {
    biSize: u32, biWidth: i32, biHeight: i32, biPlanes: u16, biBitCount: u16, biCompression: u32,
    biSizeImage: u32, biXPelsPerMeter: i32, biYPelsPerMeter: i32, biClrUsed: u32, biClrImportant: u32,
}

#[repr(C)]
struct BITMAPINFO { header: BITMAPINFOHEADER, colors: [u32; 3] }

#[repr(C)]
#[derive(Clone, Copy)]
struct KEYBDINPUT { wVk: u16, wScan: u16, dwFlags: u32, time: u32, dwExtraInfo: usize }

#[repr(C)]
#[derive(Clone, Copy)]
struct MOUSEINPUT { dx: i32, dy: i32, mouseData: u32, dwFlags: u32, time: u32, dwExtraInfo: usize }

#[repr(C)]
union InputUnion { ki: KEYBDINPUT, mi: MOUSEINPUT } // mi only gives the union its real size

#[repr(C)]
struct INPUT { kind: u32, u: InputUnion }

#[repr(C)]
struct AccentPolicy { state: i32, flags: i32, gradient: u32, animation: i32 }

#[repr(C)]
struct CompositionData { attribute: i32, data: *mut c_void, size: usize }

#[link(name = "user32")]
extern "system" {
    fn GetDC(hwnd: Handle) -> Handle;
    fn ReleaseDC(hwnd: Handle, hdc: Handle) -> i32;
    fn GetCursorPos(p: *mut POINT) -> i32;
    fn GetAsyncKeyState(vk: i32) -> i16;
    fn GetForegroundWindow() -> Handle;
    fn SetForegroundWindow(hwnd: Handle) -> i32;
    fn GetWindowTextW(hwnd: Handle, buf: *mut u16, max: i32) -> i32;
    fn GetWindowLongPtrW(hwnd: Handle, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: Handle, index: i32, value: isize) -> isize;
    fn SendInput(count: u32, inputs: *const INPUT, size: i32) -> u32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetWindowThreadProcessId(hwnd: Handle, pid: *mut u32) -> u32;
    fn AttachThreadInput(attach: u32, to: u32, on: i32) -> i32;
    fn BringWindowToTop(hwnd: Handle) -> i32;
    fn IsWindow(hwnd: Handle) -> i32;
    fn IsWindowVisible(hwnd: Handle) -> i32;
    fn IsIconic(hwnd: Handle) -> i32;
    fn GetWindow(hwnd: Handle, cmd: u32) -> Handle;
    fn GetWindowRect(hwnd: Handle, r: *mut RECT) -> i32;
    fn GetClientRect(hwnd: Handle, r: *mut RECT) -> i32;
    fn ClientToScreen(hwnd: Handle, p: *mut POINT) -> i32;
    fn EnumWindows(callback: unsafe extern "system" fn(Handle, isize) -> i32, lparam: isize) -> i32;
}

// SetWindowCompositionAttribute is undocumented and NOT in user32.lib (linking against it fails with LNK2019): it is looked up in
// user32.dll while the program runs, the same way the Python reader's ctypes did.
type CompositionFn = unsafe extern "system" fn(Handle, *mut CompositionData) -> i32;



#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThreadId() -> u32;
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *const c_void;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn QueryFullProcessImageNameW(process: Handle, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(hdc: Handle) -> Handle;
    fn CreateCompatibleBitmap(hdc: Handle, w: i32, h: i32) -> Handle;
    fn SelectObject(hdc: Handle, obj: Handle) -> Handle;
    fn BitBlt(dst: Handle, x: i32, y: i32, w: i32, h: i32, src: Handle, sx: i32, sy: i32, rop: u32) -> i32;
    fn GetDIBits(hdc: Handle, bmp: Handle, start: u32, lines: u32, bits: *mut c_void, info: *mut BITMAPINFO, usage: u32) -> i32;
    fn DeleteObject(obj: Handle) -> i32;
    fn DeleteDC(hdc: Handle) -> i32;
}

const SRCCOPY: u32 = 0x00CC_0020; // no CAPTUREBLT: layered windows (our own overlay) are not copied
const GWL_EXSTYLE: i32 = -20;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;
const KEYEVENTF_KEYUP: u32 = 2;
const VK_CONTROL: u16 = 0x11;
const VK_V: u16 = 0x56;

/// The whole desktop (all monitors): x, y, width, height in real pixels.
pub fn screen_rect() -> [i32; 4] {
    unsafe { [GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79)] }
}

/// Copies a rectangle of the screen. Result: 8 bytes header (width, height as u32 little endian) + width*height*4 bytes BGRA.
pub fn capture(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    if w <= 0 || h <= 0 || w > 16384 || h > 16384 {
        return Err(format!("bad size {w}x{h}"));
    }
    let mut buf = vec![0u8; 8 + (w as usize) * (h as usize) * 4];
    buf[0..4].copy_from_slice(&(w as u32).to_le_bytes());
    buf[4..8].copy_from_slice(&(h as u32).to_le_bytes());
    unsafe {
        let screen = GetDC(0);
        if screen == 0 {
            return Err("GetDC failed".into());
        }
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);
        let copied = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY);
        SelectObject(mem, old); // GetDIBits wants the bitmap not selected into a DC
        let mut info = BITMAPINFO {
            header: BITMAPINFOHEADER {
                biSize: 40, biWidth: w, biHeight: -h, // negative height = top row first
                biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0,
                biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
            },
            colors: [0; 3],
        };
        let lines = if copied != 0 {
            GetDIBits(mem, bmp, 0, h as u32, buf[8..].as_mut_ptr() as *mut c_void, &mut info, 0)
        } else {
            0
        };
        DeleteObject(bmp);
        DeleteDC(mem);
        ReleaseDC(0, screen);
        if copied == 0 {
            return Err("BitBlt failed".into());
        }
        if lines == 0 {
            return Err("GetDIBits failed".into());
        }
    }
    Ok(buf)
}

pub fn cursor_pos() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

/// Is this key held down right now (virtual-key code: 0x10 Shift, 0x11 Ctrl, 0x12 Alt)?
pub fn key_down(vk: i32) -> bool {
    unsafe { GetAsyncKeyState(vk) < 0 }
}

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow() }
}

/// Does this window belong to this program (the options window, the send box ...)?
pub fn is_mine(hwnd: isize) -> bool {
    unsafe {
        if hwnd == 0 { return false; }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        pid == std::process::id()
    }
}

pub fn set_foreground(hwnd: isize) -> bool {
    unsafe { SetForegroundWindow(hwnd) != 0 }
}

/// Makes `hwnd` (ours) the active window although another program has the keyboard. Call it from the thread that owns the window.
/// Windows only lets the program that received the last input take the focus; the key press went to the game, so for a
/// moment our input queue is attached to the game's thread, which lifts that restriction (same as the Python reader).
pub fn grab_focus(hwnd: isize) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        let cur = GetCurrentThreadId();
        let fgt = if fg != 0 { GetWindowThreadProcessId(fg, std::ptr::null_mut()) } else { 0 };
        let attached = fgt != 0 && fgt != cur && AttachThreadInput(cur, fgt, 1) != 0;
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if attached {
            AttachThreadInput(cur, fgt, 0);
        }
        for _ in 0..10 {
            if GetForegroundWindow() == hwnd {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        GetForegroundWindow() == hwnd
    }
}

/// Does this window have the keyboard now?
pub fn has_keyboard(hwnd: isize) -> bool {
    unsafe { GetForegroundWindow() == hwnd }
}

/// (macOS only: a window that never becomes the key window unless allowed; on Windows the "no activate" style does it)
pub fn make_no_key(_hwnd: isize) {}
pub fn set_noactivate_light(hwnd: isize, on: bool) { set_noactivate(hwnd, on); }
pub fn allow_key(_hwnd: isize, _on: bool) {}
pub fn forget(_hwnd: isize) {}

/// Asks once more for the keyboard (macOS needs this: see mac.rs). Windows: grab_focus has already waited for it.
pub fn ask_keyboard(_hwnd: isize) {}

/// Is a window of this program the one in front?
pub fn self_front() -> bool {
    is_mine(foreground())
}

pub fn window_title(hwnd: isize) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// File name of the program a window belongs to, lower case ("wow.exe"); "" when it cannot be read.
pub fn exe_of(hwnd: isize) -> String {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return String::new();
        }
        let process = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION: also works for elevated programs
        if process == 0 {
            return String::new();
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(process);
        if ok == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase()
    }
}

/// A window with this style never becomes the active window when clicked: the game keeps the keyboard.
// Windows that asked for the style: the window library rewrites the extended style of a window whenever it changes one of ITS flags
// (click-through, always on top ...), which wipes WS_EX_NOACTIVATE / WS_EX_TOOLWINDOW; keep_style() puts them back (the pages poll os_state).
static KEEP: Mutex<Vec<isize>> = Mutex::new(Vec::new());
pub fn keep_style(hwnd: isize) {
    let wanted = match KEEP.lock() { Ok(l) => l.contains(&hwnd), Err(_) => false };
    if wanted {
        unsafe {
            if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & (WS_EX_NOACTIVATE | 0x80) != (WS_EX_NOACTIVATE | 0x80) {
                set_noactivate(hwnd, true);
            }
        }
    }
}
/// The extended style of a window (for the diagnosis in the options).
pub fn ex_style(hwnd: isize) -> isize {
    unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
}

pub fn set_noactivate(hwnd: isize, on: bool) {
    if let Ok(mut l) = KEEP.lock() {
        l.retain(|&h| h != hwnd);
        if on { l.push(hwnd); }
    }
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        // a tool window is no "application window" for the shell: no taskbar button, and it does not count when Windows decides whether
        // a full-screen program is in front (the taskbar hides); WS_EX_APPWINDOW (0x40000) would bring the button back
        let new = if on { (style | WS_EX_NOACTIVATE | 0x80) & !0x4_0000 } else { style & !(WS_EX_NOACTIVATE | 0x80) };
        if new != style {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
            SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020); // NOMOVE | NOSIZE | NOZORDER | NOACTIVATE | FRAMECHANGED
        }
    }
}

#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(key: isize, sub: *const u16, options: u32, sam: u32, out: *mut isize) -> i32;
    fn RegEnumValueW(key: isize, index: u32, name: *mut u16, name_len: *mut u32, reserved: *mut u32, kind: *mut u32, data: *mut u8, data_len: *mut u32) -> i32;
    fn RegCloseKey(key: isize) -> i32;
}

/// The names of the fonts installed in Windows (all users and this user), without the style words, sorted, each once.
pub fn installed_fonts() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let sub: Vec<u16> = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts\0".encode_utf16().collect();
    for root in [0x8000_0002u32, 0x8000_0001u32] {
        unsafe {
            let mut key: isize = 0;
            // HKEY_LOCAL_MACHINE / HKEY_CURRENT_USER are small numbers sign-extended to the size of a pointer
            if RegOpenKeyExW(root as i32 as isize, sub.as_ptr(), 0, 0x20019, &mut key) != 0 {
                continue;
            }
            let mut index = 0u32;
            loop {
                let mut buf = [0u16; 512];
                let mut len = buf.len() as u32;
                if RegEnumValueW(key, index, buf.as_mut_ptr(), &mut len, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) != 0 {
                    break;
                }
                index += 1;
                let name = String::from_utf16_lossy(&buf[..len as usize]);
                let name = name.rsplit_once(" (").map(|(a, _)| a.to_string()).unwrap_or(name);   // "Arial Bold (TrueType)" -> "Arial Bold"
                for part in name.split(" & ") {
                    let mut f = part.trim().to_string();
                    for style in [" Bold Italic", " Bold", " Italic", " Regular"] {
                        if let Some(stripped) = f.strip_suffix(style) {
                            f = stripped.trim().to_string();
                        }
                    }
                    if !f.is_empty() {
                        out.push(f);
                    }
                }
            }
            RegCloseKey(key);
        }
    }
    out.sort_by_key(|s| s.to_lowercase());
    out.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    out
}

/// Makes `owner` (the game window) the owner of `hwnd`: Windows keeps an owned window just above its owner and behind everything that
/// covers the owner. owner = 0 undoes it. (GWLP_HWNDPARENT = -8; for a top-level window this sets the OWNER, not a parent.)
pub fn set_owner(hwnd: isize, owner: isize) {
    unsafe {
        if owner != 0 && IsWindow(owner) == 0 {
            return;
        }
        SetWindowLongPtrW(hwnd, -8, owner);
    }
}

fn composition_fn() -> Option<CompositionFn> {
    unsafe {
        let name: Vec<u16> = "user32.dll\0".encode_utf16().collect();
        let module = GetModuleHandleW(name.as_ptr()); // user32 is always loaded in a program with windows
        if module == 0 {
            return None;
        }
        let p = GetProcAddress(module, b"SetWindowCompositionAttribute\0".as_ptr());
        if p.is_null() { None } else { Some(std::mem::transmute::<*const c_void, CompositionFn>(p)) }
    }
}

/// state: 3 = blur, 4 = acrylic (stronger, lags when the window is moved); r/g/b + alpha (0..1) = the tint laid over the blur.
fn accent(hwnd: isize, state: i32, r: u8, g: u8, b: u8, alpha: f64) -> bool {
    let Some(f) = composition_fn() else { return false };
    let a = (alpha.clamp(0.0, 1.0) * 255.0) as u32;
    let mut accent = AccentPolicy {
        state,
        flags: if state != 0 { 2 } else { 0 },
        gradient: (a << 24) | ((b as u32) << 16) | ((g as u32) << 8) | r as u32,
        animation: 0,
    };
    let mut data = CompositionData {
        attribute: 19, // WCA_ACCENT_POLICY
        data: &mut accent as *mut AccentPolicy as *mut c_void,
        size: std::mem::size_of::<AccentPolicy>(),
    };
    unsafe { f(hwnd, &mut data) != 0 }
}

/// Blurs what is behind a window (the Python reader's levels 1 and 2). state: 3 = blur, 4 = strong blur (lags when the window is
/// moved); r/g/b + alpha (0..1) = the tint laid over the blur; on=false switches it off.
/// The Windows 11 backdrop (DWM type 38) is deliberately not used: it needs DwmExtendFrameIntoClientArea(-1), which cannot be
/// taken back and breaks the other two blurs for the rest of the window's life on Windows 10.
pub fn set_blur(hwnd: isize, on: bool, state: i32, r: u8, g: u8, b: u8, alpha: f64) -> bool {
    accent(hwnd, if on { state } else { 0 }, r, g, b, alpha)
}

/// Presses Ctrl+V in whatever window has the keyboard.
pub fn send_ctrl_v() -> bool {
    let key = |vk: u16, flags: u32| INPUT {
        kind: 1, // INPUT_KEYBOARD
        u: InputUnion { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let inputs = [key(VK_CONTROL, 0), key(VK_V, 0), key(VK_V, KEYEVENTF_KEYUP), key(VK_CONTROL, KEYEVENTF_KEYUP)];
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) == inputs.len() as u32 }
}

// ------------------------------------------------------------------------------------------------- the game window
const GW_OWNER: u32 = 4;
const NOT_GAME_EXES: [&str; 12] = ["explorer.exe", "chrome.exe", "msedge.exe", "firefox.exe", "notepad.exe", "code.exe", "notepad++.exe",
    "cmd.exe", "powershell.exe", "windowsterminal.exe", "pythonw.exe", "python.exe"];

/// What the search for the game window found: window handle, its client area on the screen (None when minimised), program, title.
pub struct GameWindow { pub hwnd: isize, pub rect: Option<[i32; 4]>, pub exe: String, pub title: String }

fn describe_game(hwnd: isize) -> GameWindow {
    let mut r = RECT::default();
    let mut p = POINT { x: 0, y: 0 };
    let rect = unsafe {
        if IsIconic(hwnd) != 0 || GetClientRect(hwnd, &mut r) == 0 || ClientToScreen(hwnd, &mut p) == 0 { None }
        else { Some([p.x, p.y, r.right - r.left, r.bottom - r.top]) }
    };
    GameWindow { hwnd, rect, exe: exe_of(hwnd), title: window_title(hwnd) }
}

struct Found { by_exe: Vec<(i64, isize)>, by_title: Vec<(i64, isize)>, title: String, mine: u32 }

unsafe extern "system" fn each_window(hwnd: Handle, lparam: isize) -> i32 {
    let found = &mut *(lparam as *mut Found);
    if IsWindowVisible(hwnd) == 0 || GetWindow(hwnd, GW_OWNER) != 0 {
        return 1; // top-level windows only
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == found.mine {
        return 1; // never our own windows
    }
    let mut r = RECT::default();
    GetWindowRect(hwnd, &mut r);
    let area = (r.right - r.left).max(0) as i64 * (r.bottom - r.top).max(0) as i64;
    let exe = exe_of(hwnd);
    if exe.starts_with("wow") && exe.ends_with(".exe") {
        found.by_exe.push((area, hwnd));
    } else if !found.title.is_empty() && window_title(hwnd).trim().to_lowercase() == found.title && !NOT_GAME_EXES.contains(&exe.as_str()) {
        found.by_title.push((area, hwnd));
    }
    1
}

/// The game: `known` (the window found last time) while it still exists and is visible; else a visible top-level window of Wow*.exe (any
/// language), else one with exactly this title (never a browser, explorer ...). The biggest one wins.
pub fn find_game(known: isize, title: &str) -> Option<GameWindow> {
    unsafe {
        if known != 0 && IsWindow(known) != 0 && IsWindowVisible(known) != 0 {
            return Some(describe_game(known));
        }
        let mut found = Found { by_exe: vec![], by_title: vec![], title: title.trim().to_lowercase(), mine: std::process::id() };
        EnumWindows(each_window, &mut found as *mut Found as isize);
        let pool = if found.by_exe.is_empty() { &found.by_title } else { &found.by_exe };
        pool.iter().max_by_key(|(area, _)| *area).map(|(_, hwnd)| describe_game(*hwnd))
    }
}

// ---------------------------------------------------------------------------------------------- the wheel over a click-through window
// A click-through window gets no mouse messages, so the wheel over it would go to the game. A low-level mouse hook (its own thread) sees every
// wheel turn: a window that asked for it (wheel_zone) has the turns over it taken away from the game (the hook swallows them) and told
// to the window (wheel_since), which then lets the user scroll back through the chat.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static WHEEL: Mutex<Vec<(u64, isize, i16)>> = Mutex::new(Vec::new());      // (number, window, delta)
static ZONES: Mutex<Vec<(isize, bool, bool)>> = Mutex::new(Vec::new());    // windows that want the wheel: (window, usable, down)  usable = the window takes the mouse itself; down = the turns DOWN too
static WHEEL_SEQ: AtomicU64 = AtomicU64::new(0);

#[repr(C)]
struct MsllHook { pt: POINT, mouseData: u32, flags: u32, time: u32, dwExtraInfo: usize }

#[repr(C)]
struct Msg { hwnd: Handle, message: u32, wParam: usize, lParam: isize, time: u32, pt: POINT }

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(id: i32, proc_: unsafe extern "system" fn(i32, usize, isize) -> isize, module: Handle, thread: u32) -> Handle;
    fn CallNextHookEx(hook: Handle, code: i32, w: usize, l: isize) -> isize;
    fn GetMessageW(msg: *mut Msg, hwnd: Handle, min: u32, max: u32) -> i32;
    fn RegisterHotKey(hwnd: Handle, id: i32, modifiers: u32, vk: u32) -> i32;
    fn SetWindowPos(hwnd: Handle, after: Handle, x: i32, y: i32, w: i32, h: i32, flags: u32) -> i32;
    fn MessageBoxW(hwnd: Handle, text: *const u16, caption: *const u16, flags: u32) -> i32;
}

unsafe extern "system" fn wheel_proc(code: i32, w: usize, l: isize) -> isize {
    if code == 0 && w == 0x020A {                                          // WM_MOUSEWHEEL
        let info = &*(l as *const MsllHook);
        let delta = (info.mouseData >> 16) as i16;
        // a window the mouse goes through (usable = false): only the turns UP are taken (the game would scroll its own chat with them); the turns DOWN too
        // while the window asks for them (`down`: it has lines that faded away and a turn down brings them back).
        // A usable window gets the wheel from Windows itself, except while Shift / Ctrl / Alt is held (Windows then keeps the wheel for the program
        // in front, not for the window under the mouse): those turns, both ways, are taken here.
        let modifier = GetAsyncKeyState(0x10) < 0 || GetAsyncKeyState(0x11) < 0 || GetAsyncKeyState(0x12) < 0;
        if let Ok(zones) = ZONES.try_lock() {
            for &(h, usable, down) in zones.iter() {
                // (a window the mouse goes through takes the turns both ways: the wheel over it is not for the game; `down` is no longer asked)
                let _ = down;
                if !(if usable { modifier } else { true }) {
                    continue;
                }
                let mut r = RECT::default();
                if IsWindow(h) != 0 && GetWindowRect(h, &mut r) != 0 && info.pt.x >= r.left && info.pt.x < r.right && info.pt.y >= r.top && info.pt.y < r.bottom {
                    if let Ok(mut list) = WHEEL.try_lock() {
                        list.push((WHEEL_SEQ.fetch_add(1, Ordering::SeqCst) + 1, h, delta));
                        if list.len() > 200 { list.remove(0); }
                    }
                    return 1;                                              // the program in front does not get this turn
                }
            }
        }
    }
    CallNextHookEx(0, code, w, l)
}

pub fn start_wheel_hook() {
    std::thread::spawn(|| unsafe {
        if SetWindowsHookExW(14, wheel_proc, 0, 0) == 0 {                  // WH_MOUSE_LL
            return;
        }
        let mut msg: Msg = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {}                        // (the hook is served by this loop)
    });
}

pub fn wheel_zone(hwnd: isize, on: bool, usable: bool, down: bool) -> bool {
    if let Ok(mut z) = ZONES.lock() {
        z.retain(|&(h, _, _)| h != hwnd);
        if on { z.push((hwnd, usable, down)); }
    }
    true
}

/// The turns told to `hwnd` after number `seq`: (the newest number, the deltas).
pub fn wheel_since(hwnd: isize, seq: u64) -> (u64, Vec<i16>) {
    let list = WHEEL.lock().map(|l| l.clone()).unwrap_or_default();
    let newest = list.iter().map(|e| e.0).max().unwrap_or(seq).max(seq);
    (newest, list.iter().filter(|e| e.0 > seq && e.1 == hwnd).map(|e| e.2).collect())
}

// ---------------------------------------------------------------------------------------------- the title bar of the options window
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: Handle, attr: u32, value: *const c_void, size: u32) -> i32;
}

/// Dark title bar in the colours of the options window (Windows 10: dark; Windows 11: the exact colours). Anything not supported is skipped.
pub fn style_caption(hwnd: isize) {
    unsafe {
        let dark: i32 = 1;
        DwmSetWindowAttribute(hwnd, 20, &dark as *const i32 as *const c_void, 4);              // USE_IMMERSIVE_DARK_MODE
        let rgb = |r: u32, g: u32, b: u32| -> u32 { (b << 16) | (g << 8) | r };
        for (attr, color) in [(35u32, rgb(0x20, 0x22, 0x26)), (36, rgb(0xdc, 0xdd, 0xe0)), (34, rgb(0x39, 0x3c, 0x43))] {   // caption, text, border
            DwmSetWindowAttribute(hwnd, attr, &color as *const u32 as *const c_void, 4);
        }
        // the title bar is painted again now (else the old colours stay until the window is touched): SWP_NOSIZE | NOMOVE | NOZORDER | NOACTIVATE | FRAMECHANGED
        SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020);
    }
}

// ---------------------------------------------------------------------------------------------- Ctrl+Alt+O from anywhere
// The way back to the options while a window lets the mouse go through. RegisterHotKey in a thread of its own; `callback` is called on
// every press. Returns false when the key is taken by another program.
pub fn start_options_hotkey(callback: impl Fn() + Send + 'static) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || unsafe {
        let ok = RegisterHotKey(0, 1, 0x0002 | 0x0001 | 0x4000, 0x4F) != 0;       // MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, "O"
        let _ = tx.send(ok);
        if !ok {
            return;
        }
        let mut msg: Msg = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            if msg.message == 0x0312 {                                             // WM_HOTKEY
                callback();
            }
        }
    });
    rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap_or(false)
}

// ---------------------------------------------------------------------------------------------- one program at a time
#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attrs: *const c_void, owner: i32, name: *const u16) -> Handle;
    fn GetLastError() -> u32;
}

/// true when this is the first copy. (The mutex lives as long as the program.)
pub fn first_instance() -> bool {
    let name: Vec<u16> = "Local\\ChatMatrixReader.single\0".encode_utf16().collect();
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        h != 0 && GetLastError() != 183                                    // ERROR_ALREADY_EXISTS
    }
}

pub fn message(title: &str, text: &str) {
    let t: Vec<u16> = format!("{title}\0").encode_utf16().collect();
    let x: Vec<u16> = format!("{text}\0").encode_utf16().collect();
    unsafe { MessageBoxW(0, x.as_ptr(), t.as_ptr(), 0x40); }               // MB_OK | MB_ICONINFORMATION
}

// ---------------------------------------------------------------------------------------------- "just above the game"
/// The `hwndInsertAfter` that puts a window directly above the game: the window that is above the game (a browser ...) so that this one stands
/// between them; HWND_NOTOPMOST (top of the ordinary windows) when only topmost windows (the taskbar ...) are above the game, HWND_TOP when none is.
/// (HWND_NOTOPMOST for a window that shares its stack with the game would raise the game over everything: only used where the game IS the top.)
fn after_game(game: isize) -> isize {
    unsafe {
        let prev = GetWindow(game, 3); // GW_HWNDPREV
        if prev == 0 { 0 } else if GetWindowLongPtrW(prev, GWL_EXSTYLE) & 0x8 != 0 { -2 } else { prev }
    }
}

/// Puts the window directly above the game window in the stacking order (no owner, no topmost): whatever covers the game (a browser ...)
/// stays above it, the game's own focus and the taskbar are left alone. Cheap when the place is right already, so the page can ask often.
pub fn place_above(hwnd: isize, game: isize) {
    unsafe {
        if game == 0 || IsWindow(game) == 0 || IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 || IsIconic(game) != 0 {
            return;
        }
        let mine = std::process::id();
        let pid_of = |h: isize| { let mut p = 0u32; GetWindowThreadProcessId(h, &mut p); p };
        // from the game upwards: our own windows and hidden ones may stand there, anything else in between means we are not right above it
        let mut x = game;
        loop {
            x = GetWindow(x, 3); // GW_HWNDPREV
            if x == 0 {
                break;
            }
            if x == hwnd {
                return;
            }
            if pid_of(x) != mine && IsWindowVisible(x) != 0 {
                break;
            }
        }
        SetWindowPos(hwnd, after_game(game), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // NOMOVE | NOSIZE | NOACTIVATE
    }
}

/// Topmost on / off for a window, directly (the window library remembers its own idea of it and may skip a call that looks like no change).
/// Off with `game`: the window is put directly above the game (not at the top of the ordinary windows: that would drag the game up with it).
pub fn set_topmost(hwnd: isize, on: bool, game: isize) {
    unsafe {
        let after = if on { -1 } else if game != 0 && IsWindow(game) != 0 { after_game(game) } else { -2 }; // HWND_TOPMOST / above the game / HWND_NOTOPMOST
        SetWindowPos(hwnd, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    }
}

/// The window goes to the top of the ordinary windows without taking the focus (what a click does to a normal window; ours do not take the focus).
pub fn raise_top(hwnd: isize) {
    unsafe {
        SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // HWND_TOP; NOMOVE | NOSIZE | NOACTIVATE
    }
}
