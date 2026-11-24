//! Everything that calls Windows directly. No Tauri in here, and no external crate:
//! the handful of Win32 functions are declared by hand, so this file does not depend on any library version.
#![allow(non_snake_case, dead_code)]
use std::ffi::c_void;

type Handle = isize; // HWND / HDC / HBITMAP are all pointer-sized

#[repr(C)]
struct POINT { x: i32, y: i32 }

#[repr(C)]
struct GuiThreadInfo { size: u32, flags: u32, active: Handle, focus: Handle, capture: Handle, menu_owner: Handle, move_size: Handle, caret: Handle, rc: [i32; 4] }

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
    fn SetPropW(hwnd: Handle, name: *const u16, data: Handle) -> i32;
    fn ReleaseDC(hwnd: Handle, hdc: Handle) -> i32;
    fn GetCursorPos(p: *mut POINT) -> i32;
    fn SetLayeredWindowAttributes(hwnd: Handle, key: u32, alpha: u8, flags: u32) -> i32;
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
    fn GetTopWindow(hwnd: Handle) -> Handle;
    fn WindowFromPoint(p: POINT) -> Handle;
    fn GetAncestor(hwnd: Handle, flags: u32) -> Handle;
    fn GetGUIThreadInfo(thread: u32, info: *mut GuiThreadInfo) -> i32;
    fn GetClassNameW(hwnd: Handle, buf: *mut u16, max: i32) -> i32;
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

/// The shell takes a window that covers a whole screen for a full-screen program and keeps the taskbar down while it is on top. The property "NonRudeHWND" tells it this one is not (the control
/// centers cover all the screens but are transparent).
pub fn set_not_rude(hwnd: isize) {
    let name: Vec<u16> = "NonRudeHWND\0".encode_utf16().collect();
    unsafe { SetPropW(hwnd, name.as_ptr(), 1); }
}

/// (macOS only: a window that never becomes the key window unless allowed; on Windows the "no activate" style does it)
pub fn make_no_key(_hwnd: isize) {}
/// Only the "may it be activated" bit, nothing else is redrawn (a text box of a page or of the bar is used: the big center must not be redone by the system: the pictures of the other screens
/// went black for a moment). The first time (no tool window style yet) it is the whole thing.
pub fn set_noactivate_light(hwnd: isize, on: bool) {
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if on && style & 0x80 == 0 { set_noactivate(hwnd, true); return; }
        if let Ok(mut l) = KEEP.lock() { l.retain(|&h| h != hwnd); if on { l.push(hwnd); } }
        let new = if on { style | WS_EX_NOACTIVATE } else { style & !WS_EX_NOACTIVATE };
        if new != style { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new); }
    }
}
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

/// The transparency of a window (0 = invisible, 1 = opaque): the "layered" style and one number for the whole window (what is drawn in it, too).
pub fn set_alpha(hwnd: isize, alpha: f64) {
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if style & 0x8_0000 == 0 { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | 0x8_0000); }           // WS_EX_LAYERED
        SetLayeredWindowAttributes(hwnd, 0, (alpha.clamp(0.0, 1.0) * 255.0).round() as u8, 0x2);         // LWA_ALPHA
    }
}

/// A window the mouse goes through (click-through): the clicks, the wheel and the pointer go to what is behind it. `WS_EX_TRANSPARENT` on a layered window: the system skips the window
/// (and the web view in it) when it looks for what is under the pointer. Only the two style bits (tao is not asked: the window it thinks is hidden is hidden by a change of its flags).
pub fn set_clickthrough(hwnd: isize, on: bool) {
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new = if on { style | 0x20 | 0x8_0000 } else { style & !0x20 };          // WS_EX_TRANSPARENT | WS_EX_LAYERED (the layered style stays when it is off: the fade of the page uses it)
        if new == style { return; }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
        if on && style & 0x8_0000 == 0 { SetLayeredWindowAttributes(hwnd, 0, 255, 0x2); }          // (a layered window that has no attributes is not drawn)
    }
}

/// (macOS: see mac.rs; here nothing: a layered window fades by itself)
pub fn fade_begin(_hwnd: isize) {}
pub fn fade_end(_hwnd: isize) {}

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
// wheel turn: a pane of a control center that is click-through has the turns over it taken away from the game (the hook swallows them) and told
// to its page (center_wheel), which then lets the user scroll back through the chat.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static WHEEL: Mutex<Vec<(u64, isize, i16)>> = Mutex::new(Vec::new());      // (number, window, delta)
static WHEEL_SEQ: AtomicU64 = AtomicU64::new(0);
static PANE_ZONES: Mutex<Vec<(isize, isize, [f64; 4])>> = Mutex::new(Vec::new());   // the panes of the control centers that want the wheel: (center, key, rectangle l, t, r, b in pixels)

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
        // the panes of the control centers that are click-through (center.rs): the wheel over them is not for the program in front
        if let Ok(zones) = PANE_ZONES.try_lock() {
            let (px, py) = (info.pt.x as f64, info.pt.y as f64);
            for &(_, key, r) in zones.iter() {
                if px >= r[0] && px < r[2] && py >= r[1] && py < r[3] {
                    if let Ok(mut list) = WHEEL.try_lock() {
                        list.push((WHEEL_SEQ.fetch_add(1, Ordering::SeqCst) + 1, key, delta));
                        if list.len() > 200 { list.remove(0); }
                    }
                    return 1;
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

/// The panes of a control center that want the wheel (all of them, in place of the earlier ones of that center): (key, rectangle l, t, r, b in pixels). Always true on Windows.
pub fn set_pane_zones(center: isize, zones: Vec<(isize, [f64; 4])>) -> bool {
    if let Ok(mut z) = PANE_ZONES.lock() {
        z.retain(|e| e.0 != center);
        z.extend(zones.into_iter().map(|(k, r)| (center, k, r)));
    }
    true
}

/// The turns told to the panes (their keys are negative) after number `seq`: (the newest number, (key, delta)).
pub fn wheel_since_panes(seq: u64) -> (u64, Vec<(isize, i16)>) {
    let list = WHEEL.lock().map(|l| l.clone()).unwrap_or_default();
    let newest = list.iter().map(|e| e.0).max().unwrap_or(seq).max(seq);
    (newest, list.iter().filter(|e| e.0 > seq && e.1 < 0).map(|e| (e.1, e.2)).collect())
}

// ---------------------------------------------------------------------------------------------- the title bar of the options window
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: Handle, attr: u32, value: *const c_void, size: u32) -> i32;
}

/// (only for the log) What a window is: its class and its program (not its title).
pub fn describe(hwnd: isize) -> String {
    if hwnd == 0 { return "none".into(); }
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
    format!("class {class}, program {}", exe_of(hwnd))          // (no title: it may say what the user reads or does)
}
/// (only for the log) The top-level window under a point of the screen (0 = none).
pub fn window_at(x: i32, y: i32) -> isize {
    unsafe { let h = WindowFromPoint(POINT { x, y }); if h == 0 { 0 } else { let root = GetAncestor(h, 2); if root == 0 { h } else { root } } }          // GA_ROOT
}
/// (only for the log) The window that is active and the one that has the keyboard, in the program that is in front now: (active, focus).
pub fn focus_owner() -> (isize, isize) {
    unsafe {
        let fg = GetForegroundWindow();
        if fg == 0 { return (0, 0); }
        let mut info = GuiThreadInfo { size: std::mem::size_of::<GuiThreadInfo>() as u32, flags: 0, active: 0, focus: 0, capture: 0, menu_owner: 0, move_size: 0, caret: 0, rc: [0; 4] };
        if GetGUIThreadInfo(GetWindowThreadProcessId(fg, std::ptr::null_mut()), &mut info) == 0 { return (0, 0); }
        (info.active, info.focus)
    }
}
/// (only for the log) A window in a few words for a list: "class/program".
pub fn short(hwnd: isize) -> String {
    let mut buf = [0u16; 96];
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    format!("{}/{}", String::from_utf16_lossy(&buf[..n.max(0) as usize]), exe_of(hwnd))
}
/// (only for the log) The first `n` windows of the stack that can be seen and are not small, from the front.
pub fn top_windows(n: usize) -> Vec<isize> {
    let mut out = Vec::new();
    unsafe {
        let mut x = GetTopWindow(0);
        let mut steps = 0;
        while x != 0 && steps < 3000 && out.len() < n {
            if IsWindowVisible(x) != 0 {
                let mut r = RECT::default();
                if GetWindowRect(x, &mut r) != 0 && r.right - r.left > 80 && r.bottom - r.top > 40 { out.push(x); }
            }
            x = GetWindow(x, 2);
            steps += 1;
        }
    }
    out
}
/// (only for the log) The owner of a window (0 = none) and whether it is a topmost one.
pub fn owner_of(hwnd: isize) -> isize { unsafe { GetWindow(hwnd, 4) } }
pub fn is_topmost(hwnd: isize) -> bool { unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & 0x8 != 0 } }
/// (only for the log) The given windows in the order of the whole stack of windows, from the front (the topmost ones first), so a window of another band is found too.
pub fn z_order_global(hwnds: &[isize]) -> Vec<isize> {
    let mut out = Vec::new();
    unsafe {
        let mut x = GetTopWindow(0);
        let mut n = 0;
        while x != 0 && n < 5000 && out.len() < hwnds.len() {
            if hwnds.contains(&x) { out.push(x); }
            x = GetWindow(x, 2);
            n += 1;
        }
    }
    out
}

/// The window is not faded in and out by the system when it is shown or hidden (DWMWA_TRANSITIONS_FORCEDISABLED). The blur windows: the text goes at once, so the blur under it must go at once too.
pub fn no_transitions(hwnd: isize) {
    unsafe {
        let on: i32 = 1;
        DwmSetWindowAttribute(hwnd, 3, &on as *const i32 as *const c_void, 4);
    }
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

/// The windows of `hwnds` that exist, from the front to the back of the screen (the order the system has them in now).
pub fn z_order(hwnds: &[isize]) -> Vec<isize> {
    let mut out = Vec::new();
    if hwnds.is_empty() { return out; }
    unsafe {
        let mut x = GetWindow(hwnds[0], 0);                                 // GW_HWNDFIRST: the top of the stack this window is in
        let mut n = 0;
        while x != 0 && n < 5000 && out.len() < hwnds.len() {
            if hwnds.contains(&x) { out.push(x); }
            x = GetWindow(x, 2);                                            // GW_HWNDNEXT
            n += 1;
        }
    }
    out
}

/// Topmost on / off for a window, directly (the window library remembers its own idea of it and may skip a call that looks like no change).
/// Off with `game`: the window is put directly above the game (not at the top of the ordinary windows: that would drag the game up with it).
/// A small window that must be seen over everything of ours (the address box over the center): topmost, to the top of the topmost ones.
pub fn raise_above_all(hwnd: isize) {
    set_topmost(hwnd, true, 0);
    raise_top(hwnd);
}

pub fn set_topmost(hwnd: isize, on: bool, game: isize) {
    unsafe {
        let after = if on { -1 } else if game != 0 && IsWindow(game) != 0 { after_game(game) } else { -2 }; // HWND_TOPMOST / above the game / HWND_NOTOPMOST
        SetWindowPos(hwnd, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200);          // NOMOVE | NOSIZE | NOACTIVATE | NOOWNERZORDER (the owner of a window, the game, is not moved with it)
    }
}

/// A web window must not be brought over its center by the system when it is pressed (the center's edge and strips would be hidden for a moment, and the order of the windows is the center's to
/// decide): the request of the system to put it at the top is taken out of the change of position, and the center is told that the window was pressed (webwin::raise_request).
#[repr(C)]
struct WindowPos { hwnd: isize, insert_after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32 }
#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(hwnd: Handle, proc_: unsafe extern "system" fn(Handle, u32, usize, isize, usize, usize) -> isize, id: usize, data: usize) -> i32;
    fn DefSubclassProc(hwnd: Handle, msg: u32, wparam: usize, lparam: isize) -> isize;
}
unsafe extern "system" fn z_guard(hwnd: Handle, msg: u32, wparam: usize, lparam: isize, _id: usize, data: usize) -> isize {
    if msg == 0x0046 && lparam != 0 {                                      // WM_WINDOWPOSCHANGING
        let p = &mut *(lparam as *mut WindowPos);
        if p.flags & 0x0004 == 0 {                                         // the order is to change (not SWP_NOZORDER)
            // What a press does (found in the log): the system puts the window after some other window WITHOUT `SWP_NOACTIVATE` (flags 0x3), or at HWND_TOP. Everything this program asks of the order
            // (directly under the center, topmost on / off) has SWP_NOACTIVATE (0x10), so it passes.
            let raise = p.flags & 0x0010 == 0 || p.insert_after == 0;
            if raise {
                p.flags |= 0x0004;
                if data != 0 { crate::webwin::raise_request(&*(data as *const String)); }
            }
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}
/// Call it from the thread that made the window.
pub fn guard_z(hwnd: isize, label: &str) {
    let data = Box::into_raw(Box::new(label.to_string())) as usize;
    let ok = unsafe { SetWindowSubclass(hwnd, z_guard, hwnd as usize, data) };
    if ok == 0 { crate::startup_log(&format!("web window {label}: the order guard could not be put on")); }
}

/// The CLIENT area of the window (what the page fills) is put at exactly this rectangle, whatever frame the window has around it (a window of the system may have an invisible one): it is put
/// there, measured, and moved by what was wrong. true = it fits now.
pub fn set_client_rect(hwnd: isize, x: i32, y: i32, w: i32, h: i32) -> bool {
    unsafe {
        let (mut l, mut t, mut ww, mut hh) = (x, y, w, h);
        for _ in 0..3 {
            SetWindowPos(hwnd, 0, l, t, ww, hh, 0x0004 | 0x0010);                // NOZORDER | NOACTIVATE
            let mut c = RECT::default(); let mut o = POINT { x: 0, y: 0 };
            if GetClientRect(hwnd, &mut c) == 0 || ClientToScreen(hwnd, &mut o) == 0 { return false; }
            let (dx, dy, dw, dh) = (o.x - x, o.y - y, (c.right - c.left) - w, (c.bottom - c.top) - h);
            if dx == 0 && dy == 0 && dw == 0 && dh == 0 { return true; }
            l -= dx; t -= dy; ww -= dw; hh -= dh;
        }
        false
    }
}

/// `hwnd` goes directly below `above` (and stays in its band: topmost or not) without taking the focus.
pub fn place_below(hwnd: isize, above: isize) {
    unsafe { SetWindowPos(hwnd, above, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200); }          // NOMOVE | NOSIZE | NOACTIVATE | NOOWNERZORDER
}

/// A center, its blur windows and its web windows (`group`, from the front) are put in the state of the mode, one behind the other, in the order in which no window is ever over the one that is to be
/// over it, not even between two calls: going UP (topmost, or the top of the ordinary windows) the front one goes first and each next one directly behind it; going DOWN (22: directly over the
/// game) the one at the back goes first and each next one directly over it. State: 0 ordinary, 1 / 21 / 23 on top, 22 over the game; `was`: the state before (23 -> 22 puts the order first, then the owner).
pub fn place_group(group: &[isize], state: u32, was: u32, game: isize) {
    if group.is_empty() { return; }
    let own = |owner: isize| { for h in group { set_owner(*h, owner); } };
    let flags = 0x0001 | 0x0002 | 0x0010 | 0x0200;                                         // NOMOVE | NOSIZE | NOACTIVATE | NOOWNERZORDER
    if state == 22 {
        // the order first, the owner after, when the windows come from over everything (this program was in front: 23; or the windows are put for the first time: 99): an owner that is set
        // while its window is over everything is lifted by the system under the window, over the windows of the user that were over it
        let first = was == 23 || was == 99;
        if !first { own(game); }
        let n = group.len();
        set_topmost(group[n - 1], false, game);
        for i in (0..n - 1).rev() { set_topmost(group[i], false, group[i + 1]); }
        if first { own(game); }
    } else {
        own(0);                                                                            // (the owner goes first: a window that is owned is not asked to be topmost)
        unsafe {
            SetWindowPos(group[0], if state == 0 { -2 } else { -1 }, 0, 0, 0, 0, flags);   // HWND_NOTOPMOST (the top of the ordinary windows) / HWND_TOPMOST
            for i in 1..group.len() { SetWindowPos(group[i], group[i - 1], 0, 0, 0, 0, flags); }
        }
    }
}

/// Can the window be seen now (shown, not hidden)?
pub fn is_visible(hwnd: isize) -> bool { unsafe { IsWindowVisible(hwnd) != 0 } }

/// The window is shown and put directly below `above` in one call, without taking the focus (shown first and put there after, it would be at the top for a moment).
pub fn show_below(hwnd: isize, above: isize) {
    unsafe { SetWindowPos(hwnd, above, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040 | 0x0200); }          // NOMOVE | NOSIZE | NOACTIVATE | SHOWWINDOW | NOOWNERZORDER
}

/// The window goes to the top of the ordinary windows without taking the focus (what a click does to a normal window; ours do not take the focus).
pub fn raise_top(hwnd: isize) {
    unsafe {
        SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // HWND_TOP; NOMOVE | NOSIZE | NOACTIVATE
    }
}
