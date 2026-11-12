"""Small macOS helpers for the send box: clipboard, key state, focus, Cmd+V.  (macOS only; needs pyobjc.)

Same names as plat/winutil.py. A "window handle" here is simply a process id: the game is identified by the pid of
the frontmost-capable WoW process, and foreground() returns the pid of the frontmost application."""
import logging
import os
import time

log = logging.getLogger("cmr.macutil")
log.addHandler(logging.NullHandler())

# The rest of the program speaks in Windows virtual-key codes (hotkeys.py); they are translated here.
VK_SHIFT, VK_CONTROL, VK_MENU, VK_RETURN, VK_V = 0x10, 0x11, 0x12, 0x0D, 0x56

# virtual key -> macOS key code (ANSI layout; these are physical key positions)
_MAC = {0x0D: 36, 0x20: 49, 0x09: 48, 0x08: 51, 0x2E: 117, 0x24: 115, 0x23: 119, 0x21: 116, 0x22: 121,
        0x25: 123, 0x26: 126, 0x27: 124, 0x28: 125, 0xC0: 50, 0x2D: 114}
_MAC.update({0x6F + i: c for i, c in enumerate((122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111), 1)})   # F1..F12
_LETTERS = dict(zip("ASDFHGZXCVBQWERYT", (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17)))
_LETTERS.update(zip("OUIPLJKNM", (31, 32, 34, 35, 37, 38, 40, 45, 46)))
_MAC.update({ord(k): v for k, v in _LETTERS.items()})
_MAC.update({0x30 + d: c for d, c in zip(range(10), (29, 18, 19, 20, 21, 23, 22, 26, 28, 25))})

_SESSION = 1                      # kCGEventSourceStateCombinedSessionState
FLAG_SHIFT, FLAG_CTRL, FLAG_ALT, FLAG_CMD = 0x20000, 0x40000, 0x80000, 0x100000


def _q():
    import Quartz
    return Quartz


def _flags():
    try:
        return int(_q().CGEventSourceFlagsState(_SESSION))
    except Exception:
        return 0


def listen_access():
    """True when the system lets us read the keyboard state while another program (the game) is active."""
    try:
        pre = getattr(_q(), "CGPreflightListenEventAccess", None)
        return True if pre is None else bool(pre())
    except Exception:
        return False


def request_listen_access():
    try:
        req = getattr(_q(), "CGRequestListenEventAccess", None)
        if req is not None:
            req()
    except Exception:
        log.exception("입력 모니터링 권한 요청 실패")


def key_down(vk):
    try:
        Q = _q()
        if vk == VK_SHIFT:
            return bool(_flags() & FLAG_SHIFT)
        if vk == VK_CONTROL:                       # the Windows "Ctrl" of a hotkey is the Control key here
            return bool(_flags() & FLAG_CTRL)
        if vk == VK_MENU:
            return bool(_flags() & FLAG_ALT)
        if vk == 0x01:
            import AppKit
            return bool(Q.CGEventSourceButtonState(_SESSION, 0)) or bool(AppKit.NSEvent.pressedMouseButtons() & 1)
        if vk == 0x02:                                 # right button
            import AppKit
            return bool(Q.CGEventSourceButtonState(_SESSION, 1)) or bool(AppKit.NSEvent.pressedMouseButtons() & 2)
        code = _MAC.get(vk)
        return code is not None and bool(Q.CGEventSourceKeyState(_SESSION, code))
    except Exception:
        return False


def _front_pid():
    import AppKit
    app = AppKit.NSWorkspace.sharedWorkspace().frontmostApplication()
    return int(app.processIdentifier()) if app is not None else None


def foreground():
    try:
        import AppKit
        if AppKit.NSApp.isActive():                # the workspace may report -1 for a program like ours
            return os.getpid()
        return _front_pid()
    except Exception:
        return None


def combo_down(combo):
    mods, vk = combo
    held = {name for name, flag in (("Shift", FLAG_SHIFT), ("Ctrl", FLAG_CTRL), ("Alt", FLAG_ALT)) if _flags() & flag}
    return held == set(mods) and key_down(vk)


def _activate(pid):
    import AppKit
    app = AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
    if app is None:
        return False
    app.activateWithOptions_(AppKit.NSApplicationActivateIgnoringOtherApps)
    return True


def _set_front_process():
    """Old Carbon call; still works where NSApplication.activate is refused (macOS 14+ lets an app take the focus
    from another program only when that program 'yields')."""
    import ctypes
    class PSN(ctypes.Structure):
        _fields_ = [("hi", ctypes.c_uint32), ("lo", ctypes.c_uint32)]
    lib = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
    psn = PSN()
    lib.GetCurrentProcess(ctypes.byref(psn))
    return lib.SetFrontProcess(ctypes.byref(psn))


def grab_focus(nswindow):
    """Make our window the active one although the game is frontmost. True if it worked."""
    try:
        import AppKit
        me = os.getpid()
        app = AppKit.NSApp
        if hasattr(app, "activate"):
            app.activate()
        app.activateIgnoringOtherApps_(True)
        r = _set_front_process()                   # the old call is the one that works when activate is refused
        how = "SetFrontProcess(%s)" % r
        for _ in range(15):
            if foreground() == me:
                how += " 확인됨"
                break
            time.sleep(0.01)
        else:
            if r != 0:
                log.warning("포커스 가져오기 실패 (결과=%s, 앞에 있는 프로그램 pid=%s)", r, _front_pid())
                return False
            how += " (확인 못 했지만 시스템이 받아들임)"
        if nswindow is not None:
            nswindow.makeKeyAndOrderFront_(None)
        log.info("포커스 가져옴: %s", how)
        return True
    except Exception:
        log.exception("포커스 가져오기 실패")
        return False


def focus_window(pid):
    """Give the focus back to the game's application."""
    try:
        if not pid or not _activate(pid):
            return False
        for _ in range(30):
            if _front_pid() == pid:
                return True
            time.sleep(0.01)
    except Exception:
        log.exception("포커스 되돌리기 실패")
    return False


def set_clipboard(text):
    try:
        import AppKit
        pb = AppKit.NSPasteboard.generalPasteboard()
        pb.clearContents()
        return bool(pb.setString_forType_(text, AppKit.NSPasteboardTypeString))
    except Exception:
        log.exception("클립보드 복사 실패")
        return False


def post_access():
    """May we press keys for the user? (macOS asks for 'Accessibility' and/or 'post event' access.)"""
    ok = False
    try:
        pre = getattr(_q(), "CGPreflightPostEventAccess", None)
        ok = bool(pre()) if pre is not None else False
    except Exception:
        pass
    try:
        from ApplicationServices import AXIsProcessTrusted
        ok = ok or bool(AXIsProcessTrusted())
    except Exception:
        pass
    return ok


def request_post_access():
    try:
        req = getattr(_q(), "CGRequestPostEventAccess", None)
        if req is not None:
            req()
    except Exception:
        log.exception("키 입력 권한 요청 실패")
    try:
        from ApplicationServices import AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt
        AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: True})       # opens the Accessibility prompt
    except Exception:
        log.exception("손쉬운 사용 권한 요청 실패")


def send_ctrl_v():
    """Press and release Cmd+V once (what the user would do by hand). Needs the 'post event' permission."""
    Q = _q()
    if not post_access():
        request_post_access()
        log.warning("자동 붙여넣기: 키 입력을 보낼 권한이 없습니다")
        return False
    for down in (True, False):
        ev = Q.CGEventCreateKeyboardEvent(None, 9, down)          # 9 = the V key
        Q.CGEventSetFlags(ev, Q.kCGEventFlagMaskCommand)
        Q.CGEventPost(Q.kCGHIDEventTap, ev)
    return True
