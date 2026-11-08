"""Windows implementation of everything that touches the operating system directly (window styles and order,
click-through, tray icon, global hotkey, single instance, message box).
Moved here unchanged from app.py. A macOS version would provide the same names in plat/mac.py."""
import ctypes
import logging
import os
import sys
import threading
import time
from ctypes import wintypes

from i18n import tr
log = logging.getLogger("cmr.app")

def _enable_dpi_awareness():
    # Must happen before any window is created / any screen is captured,
    # otherwise Windows display scaling shifts the capture coordinates.
    try:
        if ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):  # per-monitor v2
            return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


_enable_dpi_awareness()

def _user32():
    u = ctypes.windll.user32
    u.GetParent.argtypes = [wintypes.HWND]
    u.GetParent.restype = wintypes.HWND
    u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    u.GetWindowLongW.restype = ctypes.c_long
    u.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
    u.SetWindowLongW.restype = ctypes.c_long
    u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                               ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    u.SetWindowPos.restype = wintypes.BOOL
    return u


def _hwnd(win):
    wid = win.winfo_id()
    return _user32().GetParent(wid) or wid


def _set_exstyle(win, add=0, remove=0):
    try:
        u = _user32()
        h = _hwnd(win)
        style = u.GetWindowLongW(h, -20)                       # GWL_EXSTYLE
        u.SetWindowLongW(h, -20, (style | add) & ~remove)
    except Exception:
        pass


WS_EX_LAYERED, WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE = 0x80000, 0x20, 0x80, 0x08000000
WS_EX_APPWINDOW = 0x40000


class Hotkey(threading.Thread):
    """Global hotkey Ctrl+Alt+O -> reopen the options window (needed when click-through is on)."""

    def __init__(self, out_queue):
        super().__init__(daemon=True)
        self.out = out_queue
        self.ready = threading.Event()
        self.ok = False

    def run(self):
        user32 = ctypes.windll.user32
        MOD_ALT, MOD_CONTROL, MOD_NOREPEAT = 0x1, 0x2, 0x4000
        WM_HOTKEY = 0x0312
        self.ok = bool(user32.RegisterHotKey(None, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x4F))  # 'O'
        self.ready.set()
        if not self.ok:
            return
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            if msg.message == WM_HOTKEY:
                self.out.put(("options", None))


class NOTIFYICONDATAW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND), ("uID", wintypes.UINT),
                ("uFlags", wintypes.UINT), ("uCallbackMessage", wintypes.UINT), ("hIcon", wintypes.HANDLE),
                ("szTip", ctypes.c_wchar * 128), ("dwState", wintypes.DWORD), ("dwStateMask", wintypes.DWORD),
                ("szInfo", ctypes.c_wchar * 256), ("uTimeout", wintypes.UINT), ("szInfoTitle", ctypes.c_wchar * 64),
                ("dwInfoFlags", wintypes.DWORD), ("guidItem", ctypes.c_ubyte * 16), ("hBalloonIcon", wintypes.HANDLE)]


class WNDCLASSW(ctypes.Structure):
    _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", ctypes.c_void_p), ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HANDLE), ("hIcon", wintypes.HANDLE),
                ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HANDLE),
                ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]


_ICON_COLORS = [(0x4d, 0x7c, 0xff), (0x2e, 0xcc, 0x71), (0xf3, 0x9c, 0x12), (0x9b, 0x59, 0xb6),
                (0x2e, 0xcc, 0x71), (0xe7, 0x4c, 0x3c), (0x4d, 0x7c, 0xff), (0xf3, 0x9c, 0x12),
                (0xf3, 0x9c, 0x12), (0x4d, 0x7c, 0xff), (0x9b, 0x59, 0xb6), (0x2e, 0xcc, 0x71),
                (0x9b, 0x59, 0xb6), (0xf3, 0x9c, 0x12), (0x2e, 0xcc, 0x71), (0xe7, 0x4c, 0x3c)]


def _make_icon(user32, kernel32):
    """16x16 icon drawn in code: a 4x4 grid of coloured cells (like the matrix). Falls back to the stock icon."""
    try:
        bits = bytearray()
        for y in range(16):
            for x in range(16):
                if x % 4 == 3 or y % 4 == 3:
                    r, g, b = 0x1e, 0x1f, 0x22                      # gap between cells
                else:
                    r, g, b = _ICON_COLORS[(y // 4) * 4 + (x // 4)]
                bits += bytes((b, g, r, 255))                       # BGRA
        user32.CreateIcon.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_int, ctypes.c_ubyte,
                                      ctypes.c_ubyte, ctypes.c_char_p, ctypes.c_char_p]
        user32.CreateIcon.restype = wintypes.HANDLE
        icon = user32.CreateIcon(kernel32.GetModuleHandleW(None), 16, 16, 1, 32, bytes(32), bytes(bits))
        if icon:
            return icon
    except Exception:
        log.exception("아이콘 생성 실패")
    user32.LoadIconW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    user32.LoadIconW.restype = wintypes.HANDLE
    return user32.LoadIconW(None, 32512)                            # IDI_APPLICATION


class Tray(threading.Thread):
    """Notification-area icon. Left click -> options, right click -> small menu (options / quit).
    Runs its own message loop; talks to the UI only through the queue."""
    WM_TRAY = 0x0400 + 20

    def __init__(self, out_queue, tip):
        super().__init__(daemon=True)
        self.out = out_queue
        self.tip = tip
        self.ready = threading.Event()
        self.ok = False
        self.hwnd = None
        self.nid = None
        self.hicon = None
        self._proc = None
        self._taskbar_msg = 0

    def run(self):
        u = k = None
        try:
            self.u = u = ctypes.WinDLL("user32", use_last_error=True)
            self.k = k = ctypes.WinDLL("kernel32", use_last_error=True)
            self.sh = ctypes.WinDLL("shell32", use_last_error=True)
            self._prototypes()
            wndproc_t = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
            self._proc = wndproc_t(self._wndproc)                    # keep a reference or it gets garbage collected
            hinst = k.GetModuleHandleW(None)
            wc = WNDCLASSW()
            wc.lpfnWndProc = ctypes.cast(self._proc, ctypes.c_void_p)
            wc.hInstance = hinst
            wc.lpszClassName = "ChatMatrixTrayWnd"
            u.RegisterClassW(ctypes.byref(wc))
            self.hwnd = u.CreateWindowExW(0, "ChatMatrixTrayWnd", "ChatMatrixTray", 0x80000000, 0, 0, 0, 0,
                                          None, None, hinst, None)
            self._taskbar_msg = u.RegisterWindowMessageW("TaskbarCreated")
            self.hicon = _make_icon(u, k)
            self.ok = self._add()
        except Exception:
            log.exception("트레이 아이콘 시작 실패")
        finally:
            self.ready.set()
        if not self.ok:
            return
        msg = wintypes.MSG()
        while u.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            u.TranslateMessage(ctypes.byref(msg))
            u.DispatchMessageW(ctypes.byref(msg))

    def _prototypes(self):
        u, k, sh = self.u, self.k, self.sh
        u.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        u.DefWindowProcW.restype = ctypes.c_ssize_t
        u.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
        u.RegisterClassW.restype = wintypes.ATOM
        u.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                      ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                      wintypes.HWND, wintypes.HANDLE, wintypes.HANDLE, wintypes.LPVOID]
        u.CreateWindowExW.restype = wintypes.HWND
        u.RegisterWindowMessageW.argtypes = [wintypes.LPCWSTR]
        u.RegisterWindowMessageW.restype = wintypes.UINT
        u.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
        u.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        u.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        u.DispatchMessageW.restype = ctypes.c_ssize_t
        u.CreatePopupMenu.restype = wintypes.HANDLE
        u.AppendMenuW.argtypes = [wintypes.HANDLE, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR]
        u.TrackPopupMenu.argtypes = [wintypes.HANDLE, wintypes.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                     wintypes.HWND, ctypes.c_void_p]
        u.TrackPopupMenu.restype = ctypes.c_int
        u.DestroyMenu.argtypes = [wintypes.HANDLE]
        u.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
        u.SetForegroundWindow.argtypes = [wintypes.HWND]
        u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        k.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        k.GetModuleHandleW.restype = wintypes.HANDLE
        sh.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(NOTIFYICONDATAW)]
        sh.Shell_NotifyIconW.restype = wintypes.BOOL

    def _add(self):
        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(nid)
        nid.hWnd = self.hwnd
        nid.uID = 1
        nid.uFlags = 0x1 | 0x2 | 0x4                                # NIF_MESSAGE | NIF_ICON | NIF_TIP
        nid.uCallbackMessage = self.WM_TRAY
        nid.hIcon = self.hicon
        nid.szTip = self.tip[:127]
        self.nid = nid
        return bool(self.sh.Shell_NotifyIconW(0, ctypes.byref(nid)))  # NIM_ADD

    def remove(self):
        """Delete the icon (must be done before the process is killed, otherwise a ghost icon stays until hovered)."""
        if self.ok and self.nid is not None:
            self.sh.Shell_NotifyIconW(2, ctypes.byref(self.nid))      # NIM_DELETE

    def _wndproc(self, hwnd, msg, wparam, lparam):
        try:
            u = self.u
            if msg == self.WM_TRAY:
                event = lparam & 0xFFFF
                if event in (0x202, 0x203):                          # left button up / double click
                    self.out.put(("options", None))
                elif event == 0x205:                                 # right button up
                    self._menu(hwnd)
                return 0
            if self._taskbar_msg and msg == self._taskbar_msg:       # Explorer restarted: the icon must be added again
                self._add()
                return 0
        except Exception:
            log.exception("트레이 처리 오류")
            return 0
        return self.u.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _menu(self, hwnd):
        u = self.u
        pt = wintypes.POINT()
        u.GetCursorPos(ctypes.byref(pt))
        menu = u.CreatePopupMenu()
        u.AppendMenuW(menu, 0, 1, tr("옵션 열기"))
        u.AppendMenuW(menu, 0x800, 0, None)                          # separator
        u.AppendMenuW(menu, 0, 2, tr("종료"))
        u.SetForegroundWindow(hwnd)                                  # needed so the menu closes when clicking elsewhere
        cmd = u.TrackPopupMenu(menu, 0x2 | 0x20 | 0x100, pt.x, pt.y, 0, hwnd, None)   # right button | bottom | return id
        u.PostMessageW(hwnd, 0, 0, 0)
        u.DestroyMenu(menu)
        if cmd == 1:
            self.out.put(("options", None))
        elif cmd == 2:
            self.out.put(("quit", None))


def _msgbox(text, icon=0x10):
    try:
        ctypes.windll.user32.MessageBoxW(None, text, "ChatMatrix Reader", icon)
    except Exception:
        pass


_mutex = None

def _single_instance():
    """False if another copy is already running (it would fight for the hotkey and the capture)."""
    global _mutex
    try:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        k32.CreateMutexW.restype = wintypes.HANDLE
        _mutex = k32.CreateMutexW(None, False, "Local\\ChatMatrixReader.SingleInstance")
        return ctypes.get_last_error() != 183            # ERROR_ALREADY_EXISTS
    except Exception:
        return True



class WindowMixin:
    """Window-order / focus / game-window methods of the App (Windows). App inherits them."""

    def _cursor_inside(self):
        pt = wintypes.POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        x0, y0 = self.root.winfo_rootx(), self.root.winfo_rooty()
        return x0 <= pt.x < x0 + self.root.winfo_width() and y0 <= pt.y < y0 + self.root.winfo_height()

    @staticmethod
    def _key_down(vk):
        try:
            u = ctypes.windll.user32
            u.GetAsyncKeyState.restype = ctypes.c_short
            return bool(u.GetAsyncKeyState(vk) & 0x8000)
        except Exception:
            return False

    def _fg_info(self):
        u = ctypes.windll.user32
        u.GetForegroundWindow.restype = wintypes.HWND
        u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        u.GetWindowThreadProcessId.restype = wintypes.DWORD
        fg = u.GetForegroundWindow()
        pid = wintypes.DWORD(0)
        if fg:
            u.GetWindowThreadProcessId(fg, ctypes.byref(pid))
        return fg, pid.value

    def _make_owner(self):
        """Tiny invisible window that will own our windows (an owned window never has a taskbar button)."""
        try:
            u = ctypes.windll.user32
            u.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                          ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                          wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
            u.CreateWindowExW.restype = wintypes.HWND
            return u.CreateWindowExW(0, "STATIC", "ChatMatrixOwner", 0x80000000, 0, 0, 0, 0, None, None, None, None)
        except Exception:
            log.exception("소유자 창 생성 실패")
            return None

    def _hide_from_taskbar(self, win):
        try:
            h = _hwnd(win)
            if self._owner:
                u = ctypes.windll.user32
                setter = getattr(u, "SetWindowLongPtrW", None)
                if setter is not None:
                    setter.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]
                    setter.restype = ctypes.c_void_p
                    setter(h, -8, self._owner)                           # GWLP_HWNDPARENT = set the owner
                else:
                    _user32().SetWindowLongW(h, -8, self._owner)
            _set_exstyle(win, add=WS_EX_TOOLWINDOW, remove=WS_EX_APPWINDOW)
        except Exception:
            log.exception("작업 표시줄 숨기기 실패")

    def _log_windows(self):
        """Write our top-level windows to the log, so a leftover taskbar button can be traced."""
        try:
            u = _user32()
            u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
            u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
            u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
            u.IsWindowVisible.argtypes = [wintypes.HWND]
            u.GetWindow.argtypes = [wintypes.HWND, ctypes.c_uint]
            u.GetWindow.restype = wintypes.HWND
            found = []
            proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

            def cb(h, _):
                pid = wintypes.DWORD(0)
                u.GetWindowThreadProcessId(h, ctypes.byref(pid))
                if pid.value == os.getpid() and u.IsWindowVisible(h):
                    title = ctypes.create_unicode_buffer(128)
                    cls = ctypes.create_unicode_buffer(64)
                    u.GetWindowTextW(h, title, 128)
                    u.GetClassNameW(h, cls, 64)
                    ex = u.GetWindowLongW(h, -20) & 0xFFFFFFFF
                    found.append(f"[{cls.value} '{title.value}' ex=0x{ex:08x} owner={'yes' if u.GetWindow(h, 4) else 'no'}]")
                return True

            u.EnumWindows.argtypes = [proc, wintypes.LPARAM]
            u.EnumWindows(proc(cb), 0)
            log.info("보이는 최상위 창 %d개: %s", len(found), " ".join(found))
        except Exception:
            log.exception("창 목록 조회 실패")

    @staticmethod
    def _exe_of(hwnd):
        """File name of the program that owns the window (lower case), '' if unknown."""
        try:
            u, k = _user32(), ctypes.windll.kernel32
            k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            k.OpenProcess.restype = wintypes.HANDLE
            k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                                     ctypes.POINTER(wintypes.DWORD)]
            k.CloseHandle.argtypes = [wintypes.HANDLE]
            pid = wintypes.DWORD(0)
            u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            h = k.OpenProcess(0x1000, False, pid.value)          # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return ""
            try:
                buf = ctypes.create_unicode_buffer(520)
                n = wintypes.DWORD(520)
                if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                    return os.path.basename(buf.value).lower()
            finally:
                k.CloseHandle(h)
        except Exception:
            pass
        return ""

    def _find_game(self):
        """The game window: a visible top-level window of Wow*.exe (any language), else one with the configured title."""
        u = _user32()
        u.IsWindow.argtypes = [wintypes.HWND]
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.EnumWindows.argtypes = [ctypes.c_void_p, wintypes.LPARAM]
        u.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        u.GetWindow.restype = wintypes.HWND
        u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        g = self._game_hwnd
        if g and u.IsWindow(g) and u.IsWindowVisible(g):
            return g
        if g:
            log.info("게임 창이 사라졌습니다")
        self._game_hwnd = None
        now = time.monotonic()
        if now < self._game_next_search:                       # searching = enumerating every window: not too often
            return None
        self._game_next_search = now + 2.0
        title = (self.cfg.get("wow_window_title") or "").strip().lower()
        me = (_hwnd(self.root), _hwnd(self.back)) + ((_hwnd(self.shad),) if self.shad is not None else ())
        by_exe, by_title = [], []
        buf = ctypes.create_unicode_buffer(256)
        rect = wintypes.RECT()

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def cb(h, _lp):
            if h in me or not u.IsWindowVisible(h) or u.GetWindow(h, 4):      # GW_OWNER: top-level windows only
                return True
            u.GetWindowTextW(h, buf, 256)
            text = buf.value
            u.GetWindowRect(h, ctypes.byref(rect))
            area = max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top)
            exe = self._exe_of(h)
            if exe.startswith("wow") and exe.endswith(".exe"):
                by_exe.append((area, h, text, exe))
            elif title and text.strip().lower() == title:
                by_title.append((area, h, text, exe))
            return True

        u.EnumWindows(cb, 0)
        pool = by_exe or by_title
        if pool:
            area, h, text, exe = max(pool)
            self._game_hwnd = h
            log.info("게임 창 찾음: hwnd=%s 제목=%r 프로그램=%s 크기(면적)=%d", h, text, exe or "?", area)
            return h
        if now - self._game_warned > 60:
            self._game_warned = now
            log.warning("게임 창을 찾지 못했습니다 (Wow*.exe 창 없음, 제목 %r 일치 없음). 와우가 실행 중인지 확인하세요", title)
        return None

    def _follow_game(self):
        """While the game has the focus this window is topmost; as soon as another program gets the focus it is
        dropped to just above the game window (so that program can cover it). Changing only on focus changes
        keeps the window from flickering when the game re-raises itself (the topmost window cannot be covered)."""
        try:
            if self.cfg.get("topmost_wow_only"):
                u = _user32()
                u.GetForegroundWindow.restype = wintypes.HWND
                u.IsIconic.argtypes = [wintypes.HWND]
                g = self._find_game()
                fg = u.GetForegroundWindow()
                if not g or u.IsIconic(g):
                    if self._follow_top:
                        self._set_follow_topmost(False, g)
                elif fg and self._pid_of(fg) == os.getpid():
                    pass                                         # our own window has the focus: leave everything as it is
                elif fg:
                    want = (fg == g)
                    if want != self._follow_top or g != self._placed_for:
                        self._placed_for = g
                        self._set_follow_topmost(want, g)
            else:
                if self._follow_top:
                    self._set_follow_topmost(False, None)
                self._placed_for = None
            self._watch_game_focus()
            self._watchdog()
        except Exception:
            if not self._follow_failed:
                self._follow_failed = True
                log.exception("게임 창 위 배치 실패")
        self.root.after(120, self._follow_game)

    def _watch_game_focus(self):
        """The focus has just come back to the game: the game may raise its own window a moment later and cover this
        one. Look at the window order shortly after (0 / 0.4 / 1.2 s) and re-raise only if the game really is on top."""
        u = _user32()
        u.GetForegroundWindow.restype = wintypes.HWND
        fg = u.GetForegroundWindow()
        g = self._game_hwnd
        entering = bool(g) and fg == g and self._fg_last != g
        self._fg_last = fg
        if entering:
            for ms in (0, 400, 1200):
                self.root.after(ms, self._fix_order_if_covered)
            self._game_entered()

    def _above_game(self, g):
        """Is our text window higher in the stacking order than the game window?"""
        u = _user32()
        u.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        u.GetWindow.restype = wintypes.HWND
        me = _hwnd(self.root)
        p, n = u.GetWindow(g, 3), 0                              # GW_HWNDPREV: from the game upwards
        while p and n < 1000:
            if p == me:
                return True
            p, n = u.GetWindow(p, 3), n + 1
        return False

    def _ensure_above_game(self):
        """While another program has the focus we sit just above the game. The game may move itself above us
        afterwards (it did, seconds after the switch), and nothing else looks at the order then - so look again."""
        try:
            if not self.cfg.get("topmost_wow_only") or self._follow_top:
                return
            g = self._game_hwnd
            u = _user32()
            u.IsIconic.argtypes = [wintypes.HWND]
            u.GetForegroundWindow.restype = wintypes.HWND
            fg = u.GetForegroundWindow()
            if not g or u.IsIconic(g) or not fg or fg == g or self._pid_of(fg) == os.getpid():
                return
            if self._above_game(g):
                return
            now = time.monotonic()
            if now - self._ensure_logged > 5:
                self._ensure_logged = now
                log.warning("점검: 번역창이 게임 창 아래로 내려가 있음 -> 다시 게임 바로 위로 (최상위 속성: %s)", self._topmost_flags())
                log.info("점검 상태: %s", self._state_dump())
            self._place_above_game(force=True)
            if self._ensure_logged == now:
                log.info("다시 배치한 뒤: %s", "여전히 아래" if not self._above_game(g) else "게임 위로 올라감")
        except Exception:
            log.exception("게임 위 배치 점검 실패")

    def _state_dump(self):
        """One line describing our windows and what is stacked above the text window (for the log)."""
        u = _user32()
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.IsIconic.argtypes = [wintypes.HWND]
        u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        u.GetWindow.restype = wintypes.HWND
        u.GetLayeredWindowAttributes.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD),
                                                 ctypes.POINTER(ctypes.c_ubyte), ctypes.POINTER(wintypes.DWORD)]
        out = []
        for name, win in (("본창", self.root), ("배경", self.back), ("그림자", self.shad)):
            if win is None:
                continue
            try:
                h = _hwnd(win)
                r = wintypes.RECT()
                u.GetWindowRect(h, ctypes.byref(r))
                ck, al, fl = wintypes.DWORD(), ctypes.c_ubyte(), wintypes.DWORD()
                ok = u.GetLayeredWindowAttributes(h, ctypes.byref(ck), ctypes.byref(al), ctypes.byref(fl))
                out.append("%s hwnd=%s 보임=%s 최소화=%s 확장스타일=0x%X 알파=%s 위치=(%d,%d,%d,%d)" % (
                    name, h, bool(u.IsWindowVisible(h)), bool(u.IsIconic(h)), u.GetWindowLongW(h, -20) & 0xFFFFFFFF,
                    al.value if ok else "-", r.left, r.top, r.right, r.bottom))
            except Exception as e:
                out.append("%s 상태 읽기 실패 %r" % (name, e))
        try:
            above, p, n = [], u.GetWindow(_hwnd(self.root), 3), 0
            buf = ctypes.create_unicode_buffer(60)
            while p and n < 6:
                r = wintypes.RECT()
                u.GetWindowRect(p, ctypes.byref(r))
                u.GetWindowTextW(p, buf, 60)
                above.append("%s[%s|%s|%s|%s|(%d,%d,%d,%d)]" % (
                    p, self._exe_of(p) or "?", buf.value[:20], "보임" if u.IsWindowVisible(p) else "숨김",
                    "최상위" if u.GetWindowLongW(p, -20) & 0x8 else "일반", r.left, r.top, r.right, r.bottom))
                p, n = u.GetWindow(p, 3), n + 1
            out.append("본창 위 창(가까운 순): " + (" ".join(above) if above else "없음"))
        except Exception as e:
            out.append("위 창 읽기 실패 %r" % (e,))
        return " | ".join(out)

    _watchdog_next = 0.0
    _watchdog_logged = 0.0
    _ensure_logged = 0.0

    def _watchdog(self):
        """Safety net for what the focus events can miss (the game raising itself late, a window that vanished):
        once a second, while the game has the focus, check that our window is shown and not covered. When
        everything is right it does nothing at all."""
        now = time.monotonic()
        if now < self._watchdog_next:
            return
        self._watchdog_next = now + 1.0
        g = self._game_hwnd
        if not g:
            return
        if self._fg_last != g:                                  # another program has the focus
            self._ensure_above_game()
            return
        u = _user32()
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.IsIconic.argtypes = [wintypes.HWND]
        u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
        me = _hwnd(self.root)
        visible, iconic = bool(u.IsWindowVisible(me)), bool(u.IsIconic(me))
        topmost = bool(u.GetWindowLongW(me, -20) & 0x8)
        want_top = self._follow_top or bool(self.cfg.get("topmost") and not self.cfg.get("topmost_wow_only"))
        layered_lost = bool(self.two_window) and not (u.GetWindowLongW(me, -20) & 0x80000)      # WS_EX_LAYERED
        problem = (not visible) or iconic or (want_top and not topmost) or layered_lost
        if problem:
            if now - self._watchdog_logged > 30:
                self._watchdog_logged = now
                log.warning("점검: 번역창 상태 이상 | 보임=%s 최소화=%s 최상위=%s (필요=%s) 투명속성 유실=%s -> 복구", visible, iconic,
                            topmost, want_top, layered_lost)
                log.info("점검 상태: %s", self._state_dump())
            try:
                if iconic or not visible:
                    self.root.deiconify()
                if layered_lost:
                    self.apply_opacity()                      # what saving the options does: alpha / see-through again
                if want_top:
                    u.SetWindowPos(me, -1, 0, 0, 0, 0, 0x1 | 0x2 | 0x10)
                self._stack_back()
            except Exception:
                log.exception("점검 복구 실패")
            return
        self._fix_order_if_covered(late=True)

    def _is_covered(self, g):
        """Is the game window above any of our windows (text, shadow, background)?"""
        u = _user32()
        u.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        u.GetWindow.restype = wintypes.HWND
        me = _hwnd(self.root)
        for h in (me,) + tuple(self._below_hwnds()):
            p, n = u.GetWindow(h, 3), 0                           # GW_HWNDPREV: the windows above h, nearest first
            while p and n < 300:
                if p == g:
                    return True
                p, n = u.GetWindow(p, 3), n + 1
        return False

    def _topmost_flags(self):
        u = _user32()
        u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
        res = []
        for name, win in (("본창", self.root), ("배경", self.back), ("그림자", self.shad)):
            if win is not None:
                try:
                    res.append("%s=%s" % (name, bool(u.GetWindowLongW(_hwnd(win), -20) & 0x8)))
                except Exception:
                    pass
        return " ".join(res)

    def _raise_topmost(self):
        """Put the text window (and the ones under it) topmost. Returns (SetWindowPos result, last error)."""
        u = _user32()
        me = _hwnd(self.root)
        flags = 0x1 | 0x2 | 0x10                                  # NOSIZE | NOMOVE | NOACTIVATE
        ok = u.SetWindowPos(me, -1, 0, 0, 0, 0, flags)            # HWND_TOPMOST
        err = ctypes.windll.kernel32.GetLastError() if not ok else 0
        self._stack_back()
        return bool(ok), err

    def _fix_order_if_covered(self, late=False):
        try:
            if not (self._follow_top or (self.cfg.get("topmost") and not self.cfg.get("topmost_wow_only"))):
                return
            g = self._game_hwnd
            if not g:
                return
            if not self._is_covered(g):
                return                                            # the order is right: touch nothing (no flicker)
            ok, err = self._raise_topmost()
            after = self._is_covered(g)
            how = "한 번에"
            if after:                                             # topmost did not stick: drop it and set it again
                u = _user32()
                me = _hwnd(self.root)
                u.SetWindowPos(me, -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x10)       # HWND_NOTOPMOST
                ok, err = self._raise_topmost()
                after = self._is_covered(g)
                how = "내렸다 다시 올려서"
            log.info("게임 창이 위에 있어 다시 맨 위로 올림%s | 결과: %s%s | SetWindowPos=%s 오류=%s | 최상위 속성: %s",
                     " (뒤늦게 발견: 점검)" if late else "", "여전히 가려짐" if after else "해결", ("(" + how + ")") if not after else "",
                     ok, err, self._topmost_flags())
            if after and self._watchdog_logged + 30 < time.monotonic():
                self._watchdog_logged = time.monotonic()
                log.info("점검 상태: %s", self._state_dump())
        except Exception:
            log.exception("창 순서 확인 실패")

    @staticmethod
    def _pid_of(hwnd):
        u = _user32()
        u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        pid = wintypes.DWORD(0)
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value

    def _set_follow_topmost(self, on, game):
        u = _user32()
        me, back = _hwnd(self.root), _hwnd(self.back)
        flags = 0x1 | 0x2 | 0x10                                 # NOSIZE | NOMOVE | NOACTIVATE
        self._follow_top = on
        if on:
            u.SetWindowPos(me, -1, 0, 0, 0, 0, flags)            # HWND_TOPMOST
            self._stack_back()
            log.info("게임에 포커스: 창을 맨 위로 (게임=%s)", game)
        else:
            if game:
                self._place_above_game(force=True)               # just above the game, no longer topmost
                for ms in (300, 1000):                           # the game may re-order itself right after the switch
                    self.root.after(ms, self._ensure_above_game)
            else:
                u.SetWindowPos(me, -2, 0, 0, 0, 0, flags)        # HWND_NOTOPMOST
                self._stack_back()
            log.info("다른 프로그램에 포커스: 창을 게임 바로 위로 (게임=%s)", game)

    def _place_above_game(self, force=False):
        u = _user32()
        u.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        u.GetWindow.restype = wintypes.HWND
        u.IsIconic.argtypes = [wintypes.HWND]
        u.IsWindow.argtypes = [wintypes.HWND]
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        g = self._find_game()
        if not g or u.IsIconic(g):
            return
        me, back = _hwnd(self.root), _hwnd(self.back)
        mine = (me,) + tuple(self._below_hwnds())
        # the windows directly above the game must be: ours (front window topmost of the pair)
        above = u.GetWindow(g, 3)                          # GW_HWNDPREV
        want = list(mine)[::-1]                            # nearest to the game first: back, then root
        ok = True
        cur = above
        for h in want:
            if cur != h:
                ok = False
                break
            cur = u.GetWindow(cur, 3)
        if ok and not force:
            return
        # the nearest window above the game that is not one of ours
        p = above
        while p and p in mine:
            p = u.GetWindow(p, 3)
        topmost = lambda h: bool(u.GetWindowLongW(h, -20) & 0x8)       # WS_EX_TOPMOST
        if topmost(g):
            ia = p if p else -1                                       # HWND_TOPMOST
        else:
            ia = p if (p and not topmost(p)) else -2                  # HWND_NOTOPMOST: top of the normal windows
        flags = 0x1 | 0x2 | 0x10                                      # NOSIZE | NOMOVE | NOACTIVATE
        ok1 = u.SetWindowPos(me, ia, 0, 0, 0, 0, flags)
        self._stack_back()
        now = time.monotonic()
        if now - self._follow_logged > 10:                 # leave a trace in the log tab without flooding it
            self._follow_logged = now
            log.info("게임 창 위로 재배치 | 게임=%s 바로 위 창=%s 기준=%s 결과=%s", g, above, ia, bool(ok1))

    def _stack_back(self):
        """Put the shadow window (if any) and the background window directly below the text window, in that order."""
        if not self.two_window:
            return
        try:
            prev = _hwnd(self.root)
            for h in self._below_hwnds():
                _user32().SetWindowPos(h, prev, 0, 0, 0, 0, 0x1 | 0x2 | 0x10)
                prev = h
        except Exception:
            pass

    def _set_passthrough(self, on):
        for win in (self.root, self.back):
            if on:
                _set_exstyle(win, add=WS_EX_LAYERED | WS_EX_TRANSPARENT)
            else:
                _set_exstyle(win, remove=WS_EX_TRANSPARENT)

    def _restore_foreground(self, hwnd):
        """Give the focus back to a window (the game) if it still exists."""
        u = ctypes.windll.user32
        u.IsWindow.argtypes = [wintypes.HWND]
        u.SetForegroundWindow.argtypes = [wintypes.HWND]
        if u.IsWindow(hwnd):
            u.SetForegroundWindow(hwnd)


# ---- names shared with plat/mac.py (app.py uses them without knowing the system)
KEY_BG = None                 # None: the program's own colour key is used (BG = "#1e1f22")
OPTIONS_KEY = "Ctrl+Alt+O"
SHIFT_GRACE = 0
POLL_RESIZE = False
RESIZE_CURSOR = "size_nw_se"
FORCE_TWO_WINDOW = False
RESHOW_FOR_TASKBAR = True
RIGHT_CLICKS = ("<Button-3>",)


def borderless(win, keyboard=True):
    win.overrideredirect(True)


def set_blur(win, on, color="#1e1f22", alpha=0.6, state=3):
    """Blur what is behind a window (undocumented SetWindowCompositionAttribute, Windows 10 1803+).
    `alpha` is the strength of the tint colour. Returns True when the system accepted it."""
    try:
        h = _hwnd(win)
        class ACCENT(ctypes.Structure):
            _fields_ = [("state", ctypes.c_int), ("flags", ctypes.c_int), ("gradient", ctypes.c_uint), ("anim", ctypes.c_int)]

        class DATA(ctypes.Structure):
            _fields_ = [("attr", ctypes.c_int), ("data", ctypes.c_void_p), ("size", ctypes.c_size_t)]
        r, g, b = int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)
        a = int(max(0.0, min(1.0, alpha)) * 255)
        acc = ACCENT(int(state) if on else 0, 2 if on else 0, (a << 24) | (b << 16) | (g << 8) | r, 0)
        d = DATA(19, ctypes.cast(ctypes.pointer(acc), ctypes.c_void_p), ctypes.sizeof(acc))      # 19 = WCA_ACCENT_POLICY
        f = ctypes.windll.user32.SetWindowCompositionAttribute
        f.argtypes = [wintypes.HWND, ctypes.POINTER(DATA)]
        f.restype = wintypes.BOOL
        ok = bool(f(h, ctypes.byref(d)))
        log.info("블러 %s: 결과=%s 상태=%s 투명도=%d 창 스타일=0x%X 윈도우 빌드=%s", "켬" if on else "끔", ok, state, a,
                 ctypes.windll.user32.GetWindowLongW(h, -20) & 0xFFFFFFFF, getattr(sys.getwindowsversion(), "build", "?"))
        return ok if on else True
    except Exception:
        log.exception("블러 적용 실패")
        return False


def set_keycolor(win, color):
    win.attributes("-transparentcolor", color or "")


def setup_front(win):
    pass


def setup_app(app):
    pass


def request_permissions(app):
    pass
