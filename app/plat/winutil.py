"""Small Windows helpers for the send box: clipboard, key state, focus, Ctrl+V. (Windows only; imported lazily.)"""
import ctypes
import logging
import time
from ctypes import wintypes

log = logging.getLogger("cmr.winutil")
log.addHandler(logging.NullHandler())

VK_SHIFT, VK_CONTROL, VK_MENU, VK_RETURN, VK_V = 0x10, 0x11, 0x12, 0x0D, 0x56
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002


def _u():
    u = ctypes.windll.user32
    u.GetAsyncKeyState.argtypes = [ctypes.c_int]
    u.GetAsyncKeyState.restype = ctypes.c_short
    u.GetForegroundWindow.restype = wintypes.HWND
    u.SetForegroundWindow.argtypes = [wintypes.HWND]
    u.BringWindowToTop.argtypes = [wintypes.HWND]
    u.IsWindow.argtypes = [wintypes.HWND]
    u.IsIconic.argtypes = [wintypes.HWND]
    u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    u.GetWindowThreadProcessId.restype = wintypes.DWORD
    u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    u.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
    u.keybd_event.argtypes = [ctypes.c_ubyte, ctypes.c_ubyte, wintypes.DWORD, ctypes.c_void_p]
    return u


def key_down(vk):
    try:
        return bool(_u().GetAsyncKeyState(vk) & 0x8000)
    except Exception:
        return False


def foreground():
    try:
        return _u().GetForegroundWindow()
    except Exception:
        return None


def combo_down(combo):
    """combo = (set of 'Shift'/'Ctrl'/'Alt', vk): exactly these modifiers and the key are held."""
    mods, vk = combo
    held = {name for name, code in (("Shift", VK_SHIFT), ("Ctrl", VK_CONTROL), ("Alt", VK_MENU)) if key_down(code)}
    return held == set(mods) and key_down(vk)


def grab_focus(hwnd):
    """Make `hwnd` (ours) the active window although another program has the focus. True if it worked.

    Windows only lets the program that received the last input take the focus; the user's key press went to the game,
    so for a few milliseconds our input queue is attached to the game's thread, which lifts that restriction."""
    u = _u()
    k = ctypes.windll.kernel32
    k.GetCurrentThreadId.restype = wintypes.DWORD
    fg = u.GetForegroundWindow()
    cur = k.GetCurrentThreadId()
    fgt = u.GetWindowThreadProcessId(fg, None) if fg else 0
    attached = False
    try:
        if fgt and fgt != cur:
            attached = bool(u.AttachThreadInput(cur, fgt, True))
        u.BringWindowToTop(hwnd)
        u.SetForegroundWindow(hwnd)
    finally:
        if attached:
            u.AttachThreadInput(cur, fgt, False)
    for _ in range(10):                                  # the switch is not instantaneous
        if u.GetForegroundWindow() == hwnd:
            return True
        time.sleep(0.01)
    return u.GetForegroundWindow() == hwnd


def focus_window(hwnd):
    """Give the focus back to `hwnd` (we are the active program at this moment, so this is allowed)."""
    u = _u()
    try:
        if not hwnd or not u.IsWindow(hwnd):
            return False
        if u.IsIconic(hwnd):
            u.ShowWindow(hwnd, 9)                        # SW_RESTORE
        u.SetForegroundWindow(hwnd)
        for _ in range(15):
            if u.GetForegroundWindow() == hwnd:
                return True
            time.sleep(0.01)
    except Exception:
        log.exception("포커스 되돌리기 실패")
    return False


def set_clipboard(text):
    """Put `text` on the clipboard as Unicode text. True on success."""
    u = ctypes.windll.user32
    k = ctypes.windll.kernel32
    u.OpenClipboard.argtypes = [wintypes.HWND]
    u.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    u.SetClipboardData.restype = wintypes.HANDLE
    k.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    k.GlobalAlloc.restype = wintypes.HGLOBAL
    k.GlobalLock.argtypes = [wintypes.HGLOBAL]
    k.GlobalLock.restype = ctypes.c_void_p
    k.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    k.GlobalFree.argtypes = [wintypes.HGLOBAL]
    data = (text + "\0").encode("utf-16-le")
    for _ in range(20):                                  # another program may hold the clipboard for a moment
        if u.OpenClipboard(None):
            break
        time.sleep(0.02)
    else:
        log.warning("클립보드를 열지 못했습니다")
        return False
    try:
        u.EmptyClipboard()
        h = k.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            return False
        p = k.GlobalLock(h)
        if not p:
            k.GlobalFree(h)
            return False
        ctypes.memmove(p, data, len(data))
        k.GlobalUnlock(h)
        if not u.SetClipboardData(CF_UNICODETEXT, h):
            k.GlobalFree(h)                              # on success the system owns the memory
            return False
        return True
    finally:
        u.CloseClipboard()


def send_ctrl_v():
    """Press and release Ctrl+V once (what the user would do by hand)."""
    u = _u()
    scan = lambda vk: u.MapVirtualKeyW(vk, 0)
    u.keybd_event(VK_CONTROL, scan(VK_CONTROL), 0, None)
    u.keybd_event(VK_V, scan(VK_V), 0, None)
    u.keybd_event(VK_V, scan(VK_V), 2, None)             # KEYEVENTF_KEYUP
    u.keybd_event(VK_CONTROL, scan(VK_CONTROL), 2, None)
