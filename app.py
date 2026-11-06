"""ChatMatrix Reader - borderless translation window fed by the on-screen ChatMatrix.

Window layout
  * No Windows title bar / border. A small custom title bar, a thin scrollbar, a resize grip and an edge line
    appear only while the mouse is over the window.
  * Background opacity and text opacity are separate. When they differ, two windows are used:
      back  = solid background colour with its own alpha (never takes focus)
      front = the text, with the background colour keyed out (transparent) and its own alpha
    When they are equal, a single ordinary window is used.
"""
import ctypes
from ctypes import wintypes


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

import itertools
import logging
import os
import queue
import sys
import traceback
import threading
import time
import tkinter as tk
import tkinter.font as tkfont

import config
import chattext
import glossary
import hotkeys
import outgoing
import winutil
import i18n
import logsetup
import translator
from i18n import tr
from capture import CaptureWorker
from options import OptionsWindow

logsetup.setup()
log = logging.getLogger("cmr.app")

BG = "#1e1f22"            # also the colour key of the front window in two-window mode: nothing else may use it
TITLE_BG = "#2b2d31"
INPUT_BG = "#262a31"
EDGE = "#3a3d44"
DIM = "#8a8d93"
SB_TRACK = "#26282c"
SB_THUMB = "#4d5f80"
SB_THUMB_HOT = "#6b83b3"
TITLE_H = 22
SB_W = 10
GRIP = 14

TAG_COLORS = {
    "say": "#e8e8e8", "party": "#a8b8ff", "raid": "#ffa040", "guild": "#50e050",
    "officer": "#40c040", "whisper": "#ff80ff", "channel": "#ffc8c8",
    "community": "#80d0d0", "other": "#aaaaaa", "restricted": "#777777", "system": DIM,
    "trans": "#7fd6b0", "error": "#d67f7f",
}


def channel_tag(ch: str) -> str:
    if ch in ("S", "Y", "E"):
        return "say"
    if ch == "P":
        return "party"
    if ch in ("R", "RW", "I"):
        return "raid"
    if ch == "G":
        return "guild"
    if ch == "O":
        return "officer"
    if ch in ("W", "B"):
        return "whisper"
    if ch == "CM":
        return "community"
    if ch.startswith("C"):
        return "channel"
    return "other"


# ----------------------------------------------------------------------
# small Win32 helpers
# ----------------------------------------------------------------------
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


class MiniScrollbar(tk.Canvas):
    """Thin custom scrollbar: dark track, one rounded-ish thumb."""

    def __init__(self, parent, command):
        super().__init__(parent, width=SB_W, bg=SB_TRACK, highlightthickness=0, bd=0, cursor="arrow")
        self.command = command
        self.lo, self.hi = 0.0, 1.0
        self.grab = None
        self.bind("<Configure>", lambda e: self.redraw())
        self.bind("<ButtonPress-1>", self.on_press)
        self.bind("<B1-Motion>", self.on_move)
        self.bind("<ButtonRelease-1>", self.on_release)

    def set(self, lo, hi):
        self.lo, self.hi = float(lo), float(hi)
        self.redraw()

    def _thumb(self):
        h = max(1, self.winfo_height())
        y0, y1 = self.lo * h, self.hi * h
        if y1 - y0 < 24:
            y1 = y0 + 24
            if y1 > h:
                y1, y0 = h, h - 24
        return y0, y1

    def redraw(self):
        self.delete("all")
        if self.hi - self.lo >= 0.999:
            return                                              # nothing to scroll
        y0, y1 = self._thumb()
        self.create_rectangle(2, y0, SB_W - 2, y1, fill=SB_THUMB_HOT if self.grab is not None else SB_THUMB, width=0)

    def on_press(self, e):
        y0, y1 = self._thumb()
        if y0 <= e.y <= y1:
            self.grab = e.y - y0
            self.redraw()
        else:
            self.command("scroll", -1 if e.y < y0 else 1, "pages")

    def on_move(self, e):
        if self.grab is not None:
            self.command("moveto", (e.y - self.grab) / max(1, self.winfo_height()))

    def on_release(self, _e):
        self.grab = None
        self.redraw()


class App:
    def __init__(self):
        self.cfg = config.load()
        i18n.init(self.cfg.get("language", i18n.AUTO))      # before any text is created
        glossary.ensure_default(self.cfg.get("glossary_file"))
        self.q = queue.Queue()
        self.opt = None
        self.tokens = itertools.count(1)
        self.marks = {}            # token -> text mark name (where the translation goes)
        self.last_error = None
        self.chrome_on = False
        self.dragging = False
        self.two_window = False
        self.tick_n = 0

        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self._connected = False
        self._interactive = False      # click-through temporarily lifted by holding Shift
        self._game_hwnd = None         # cached game window (for "only above the game window")
        self._follow_failed = False
        self._game_next_search = 0.0
        self._game_warned = 0.0
        self._follow_logged = 0.0
        self._placed_for = None        # game window we last stacked above
        self._follow_top = False       # currently kept topmost because the game has the focus
        self._prev_fg = None           # window that had focus before we became interactive
        self._send_open = False        # the send box (input line) is shown
        self._send_busy = False        # a translation is running
        self._send_armed = False       # Enter was let go once since the box opened
        self._send_pending = False     # box closed, focus is being handed back to the game
        self._send_prev = True         # hotkey was down in the previous tick (needs a release before it can fire)
        self._send_lost = None
        self._send_opened = 0.0
        self._send_game = None
        self._send_combo_cache = (None, None)
        self._owner = None             # invisible owner window: owned windows never get a taskbar button
        self.root.report_callback_exception = lambda exc, val, tb: log.error("UI 오류", exc_info=(exc, val, tb))
        threading.excepthook = lambda a: log.error("스레드 오류 (%s)", a.thread, exc_info=(a.exc_type, a.exc_value, a.exc_traceback))
        self.root.title("ChatMatrix Reader")
        self.root.geometry(self.cfg["geometry"])
        self.root.configure(bg=BG)

        self.hotkey = Hotkey(self.q)
        self.hotkey.start()
        self.hotkey.ready.wait(1.0)
        self.tray = Tray(self.q, tr("ChatMatrix Reader  (클릭: 옵션)"))
        self.tray.start()
        self.tray.ready.wait(2.0)
        log.info("트레이 아이콘: %s", "표시됨" if self.tray.ok else "만들지 못함")
        if self.cfg["click_through"] and not self.hotkey.ok:
            self.cfg["click_through"] = False     # never lock the user out of the options

        self.font = tkfont.Font(family="Malgun Gothic", size=int(self.cfg["font_size"]))
        self._build_main()
        self._build_back()
        self.root.update_idletasks()
        self.apply_window_settings()

        self.worker = CaptureWorker(self.q, lambda: self.cfg)
        self.worker.start()
        self.translations = translator.TranslationService(
            self.q, lambda: self.cfg, workers=max(1, min(8, int(self.cfg.get("max_parallel", 2)))))

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.bind("<Configure>", self._on_configure)
        self.root.bind("<FocusIn>", lambda e: self._stack_back())
        self.root.after(50, self.poll)
        self.root.after(80, self._hover_tick)
        self.root.after(500, self._follow_game)
        self.root.after(300, self._send_tick)
        self.root.after(400, self._fix_taskbar)
        log.info("시작 | python %s | 번역=%s | 목표=%s | 로그 파일: %s", sys.version.split()[0],
                 self.cfg.get("translator"), self.cfg.get("target_lang"), logsetup.PATH)

    # ------------------------------------------------------------------ UI
    def _build_main(self):
        self.body = tk.Frame(self.root, bg=BG, highlightthickness=1, highlightbackground=BG, highlightcolor=BG)
        self.body.pack(fill="both", expand=True)

        self.text = tk.Text(
            self.body, wrap="word", bg=BG, fg="#e6e6e6", relief="flat", font=self.font, bd=0, highlightthickness=0,
            padx=8, pady=6, selectbackground="#3a5a8c", inactiveselectbackground="#3a5a8c",
            insertwidth=0, cursor="xterm", spacing1=2, spacing3=2,
        )
        self.text.pack(fill="both", expand=True, padx=(0, SB_W + 2))
        for name, color in TAG_COLORS.items():
            self.text.tag_configure(name, foreground=color)
        for q, color in chattext.QUALITY_COLORS.items():          # created after the channel tags -> they win
            self.text.tag_configure(f"q{q}", foreground=color)

        self.status = tk.StringVar(value=tr("시작 중..."))

        # ---- send box: an input line at the bottom of the window (hidden until the hotkey)
        self.sendbar = tk.Frame(self.body, bg=INPUT_BG)
        self.send_lang_lbl = tk.Label(self.sendbar, text="", bg=INPUT_BG, fg=DIM, font=("Malgun Gothic", 9))
        self.send_lang_lbl.pack(side="right", padx=(8, SB_W + 8))
        self.send_entry = tk.Entry(self.sendbar, bg=INPUT_BG, fg="#f0f0f0", insertbackground="#f0f0f0", relief="flat",
                                   font=self.font, bd=0, highlightthickness=0, disabledbackground=INPUT_BG,
                                   readonlybackground=INPUT_BG, disabledforeground="#a0a0a0")
        self.send_entry.pack(side="left", fill="x", expand=True, padx=(10, 0), pady=6)
        for seq in ("<Return>", "<KP_Enter>"):
            self.send_entry.bind(seq, self._send_submit)
        self.send_entry.bind("<Escape>", self._send_cancel)

        # ---- overlay: title bar (only while hovering)
        self.title = tk.Frame(self.body, bg=TITLE_BG, height=TITLE_H)
        self.title.pack_propagate(False)
        btn_font = ("Segoe UI Symbol", 10)
        self.btn_close = tk.Label(self.title, text="✕", bg=TITLE_BG, fg=DIM, font=btn_font, width=3, cursor="hand2")
        self.btn_close.pack(side="right", fill="y")
        self.btn_opt = tk.Label(self.title, text="⚙", bg=TITLE_BG, fg=DIM, font=btn_font, width=3, cursor="hand2")
        self.btn_opt.pack(side="right", fill="y")
        self.btn_refresh = tk.Label(self.title, text="⟳", bg=TITLE_BG, fg=DIM, font=btn_font, width=3, cursor="hand2")
        self.btn_refresh.pack(side="right", fill="y")
        self.lbl_title = tk.Label(self.title, text="ChatMatrix", bg=TITLE_BG, fg="#cfd2d8",
                                  font=("Malgun Gothic", 9, "bold"), padx=8)
        self.lbl_title.pack(side="left", fill="y")
        self.lbl_status = tk.Label(self.title, textvariable=self.status, bg=TITLE_BG, fg=DIM,
                                   font=("Malgun Gothic", 8), anchor="w")
        self.lbl_status.pack(side="left", fill="both", expand=True)

        for w, hot in ((self.btn_close, "#e5484d"), (self.btn_opt, "#6b83b3"), (self.btn_refresh, "#6bb38a")):
            w.bind("<Enter>", lambda e, w=w, hot=hot: w.configure(fg=hot))
            w.bind("<Leave>", lambda e, w=w: w.configure(fg=DIM))
        self.btn_close.bind("<Button-1>", lambda e: self.on_close())
        self.btn_opt.bind("<Button-1>", lambda e: self.open_options())
        self.btn_refresh.bind("<Button-1>", lambda e: self._refresh_matrix())
        for w in (self.title, self.lbl_title, self.lbl_status):
            w.configure(cursor="fleur")
            w.bind("<ButtonPress-1>", self._drag_start)
            w.bind("<B1-Motion>", self._drag_move)
            w.bind("<ButtonRelease-1>", self._drag_end)

        # ---- overlay: scrollbar and resize grip
        self.sb = MiniScrollbar(self.body, self.text.yview)
        self.text.configure(yscrollcommand=self.sb.set)
        self.sb.bind("<MouseWheel>", self._wheel)
        self.grip = tk.Label(self.body, text="◢", bg=BG, fg="#5a5f69", font=("Segoe UI Symbol", 9),
                             cursor="size_nw_se")
        self.grip.bind("<ButtonPress-1>", lambda e: setattr(self, "dragging", True))
        self.grip.bind("<B1-Motion>", self._resize_move)
        self.grip.bind("<ButtonRelease-1>", lambda e: setattr(self, "dragging", False))

        # ---- read-only but selectable / copyable
        nav = {"Up", "Down", "Left", "Right", "Prior", "Next", "Home", "End"}

        def on_key(e):
            ctrl = bool(e.state & 0x4)
            if ctrl and e.keysym.lower() == "c":
                return None
            if e.keysym in nav:
                return None
            return "break"

        def select_all(_e):
            self.text.tag_add("sel", "1.0", "end-1c")
            return "break"

        self.text.bind("<Key>", on_key)
        self.text.bind("<Control-a>", select_all)
        self.text.bind("<Control-A>", select_all)
        self.text.bind("<Button-1>", lambda e: self.text.focus_set())
        self.text.bind("<ButtonRelease-1>", self._auto_copy, add="+")
        self.text.bind("<Control-Shift-C>", self._copy_selection)
        self.text.bind("<Control-Shift-c>", self._copy_selection)
        self.root.bind("<Button-3>", lambda e: self.open_options())

        self.add_system(tr("제목줄/스크롤은 마우스를 올리면 나타납니다 | 우클릭 또는 ⚙: 옵션 | Ctrl+Alt+O: 옵션 | 클릭 통과 중에는 Shift를 누른 채로 조작"))

    def _build_back(self):
        """Background-only window used when background and text opacity differ."""
        self.back = tk.Toplevel(self.root)
        self.back.overrideredirect(True)
        self.back.configure(bg=BG)
        self.back.withdraw()
        self.back.update_idletasks()
        _set_exstyle(self.back, add=WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
        # clicks on the transparent parts of the front window land here: forward what matters
        self.back.bind("<ButtonPress-1>", self._back_press)
        self.back.bind("<B1-Motion>", self._back_motion)
        self.back.bind("<ButtonRelease-1>", self._auto_copy)
        self.back.bind("<MouseWheel>", self._wheel)
        self.back.bind("<Button-3>", lambda e: self.open_options())

    # ---- overlay chrome (shown only while the mouse is over the window)
    def set_chrome(self, on):
        if on == self.chrome_on:
            return
        self.chrome_on = on
        if on:
            self.title.place(x=0, y=0, relwidth=1.0, height=TITLE_H)
            self.sb.place(relx=1.0, rely=0, x=-1, y=TITLE_H, anchor="ne", width=SB_W,
                          relheight=1.0, height=-(TITLE_H + GRIP))
            self.grip.place(relx=1.0, rely=1.0, anchor="se")
            self.body.configure(highlightbackground=EDGE)
        else:
            for w in (self.title, self.sb, self.grip):
                w.place_forget()
            self.body.configure(highlightbackground=BG)

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

    def _hover_tick(self):
        try:
            ct = bool(self.cfg["click_through"])
            inside = self._cursor_inside()
            if ct:
                # Shift + mouse over the window = behave like a normal window; a started drag/selection is finished first
                keep = self._interactive and (self.dragging or self._key_down(0x01))      # 0x01 = left button
                interactive = (self._key_down(0x10) and inside) or keep                   # 0x10 = Shift
                if interactive != self._interactive:
                    self._interactive = interactive
                    self._set_passthrough(not interactive)
                    if interactive:
                        self._enter_interactive()
                    else:
                        self._leave_interactive()
                want = self.dragging or interactive
            else:
                want = self.dragging or inside
            self.set_chrome(bool(want))
            self.tick_n += 1
            if self.two_window and self.tick_n % 10 == 0:
                self._stack_back()
        finally:
            self.root.after(50, self._hover_tick)

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

    def _enter_interactive(self):
        if self._send_open or self._send_pending:        # the send box has the focus: never hand it back
            self._prev_fg = None
            return
        try:
            fg, pid = self._fg_info()
            self._prev_fg = fg if (fg and pid != os.getpid()) else None
        except Exception:
            self._prev_fg = None

    def _leave_interactive(self):
        """Shift released: if clicking made us the active window, give the focus back to the game."""
        prev, self._prev_fg = self._prev_fg, None
        if not prev or self._send_open or self._send_pending or (self.opt is not None and self.opt.alive()):
            return
        try:
            fg, pid = self._fg_info()
            if pid == os.getpid():
                u = ctypes.windll.user32
                u.IsWindow.argtypes = [wintypes.HWND]
                u.SetForegroundWindow.argtypes = [wintypes.HWND]
                if u.IsWindow(prev):
                    u.SetForegroundWindow(prev)
        except Exception:
            pass


    # ------------------------------------------------------------------ send box
    # Shift+Enter (the game opens its chat box as usual) -> an input line appears at the bottom of this window ->
    # type in your own language, Enter -> the translation is put on the clipboard -> focus goes back to the game,
    # where the chat box is still open: Ctrl+V, Enter. Nothing is ever sent to the game by this program
    # (except Ctrl+V, and only when the option "auto paste" is on).
    def _refresh_matrix(self):
        log.info("매트릭스 다시 찾기 (새로고침 버튼)")
        self.worker.research()

    def _send_combo(self):
        text = self.cfg.get("send_hotkey") or hotkeys.DEFAULT
        if self._send_combo_cache[0] != text:
            try:
                parsed = hotkeys.parse(text)
            except ValueError:
                log.warning("보내기 단축키가 올바르지 않아 기본값을 씁니다: %r", text)
                parsed = hotkeys.parse(hotkeys.DEFAULT)
            self._send_combo_cache = (text, parsed)
        return self._send_combo_cache[1]

    def _send_tick(self):
        try:
            self._send_step()
        except Exception:
            log.exception("보내기 번역 오류 - 이번 실행 동안 이 기능을 끕니다")
            self.cfg["send_enabled"] = False
            try:
                self._send_close(refocus=False)
                self.add_system("⚠ " + tr("보내기 번역에서 오류가 나서 이번 실행 동안 껐습니다 (로그 확인)"), "error")
            except Exception:
                pass
            return
        self.root.after(25, self._send_tick)

    def _send_step(self):
        if not self.cfg.get("send_enabled", True):
            self._send_prev = True
            if self._send_open:
                self._send_close(refocus=False)
            return
        if self._send_open:
            self._send_open_step()
            return
        if self._send_pending:
            return
        g = self._find_game()
        if not g or winutil.foreground() != g:
            self._send_prev = True               # the key must be released once before it can trigger
            return
        down = winutil.combo_down(self._send_combo())
        if down and not self._send_prev:
            self._send_prev = True
            self._send_open_box(g)
        elif not down:
            self._send_prev = False

    def _send_open_box(self, game):
        if self.cfg.get("translator", "none") == "none":
            self.add_system("⚠ " + tr("번역 방식이 '사용 안 함'이라 보내기 번역을 쓸 수 없습니다 (옵션 → 번역)"), "error")
            return
        self._send_game = game
        self.send_lang_lbl.configure(text=tr("→ {lang}", lang=self.cfg.get("send_lang") or "English"))
        self.send_entry.configure(state="normal")
        self.send_entry.delete(0, "end")
        self.sendbar.pack(side="bottom", fill="x", before=self.text)
        self.text.see("end")
        self.root.update_idletasks()
        if not winutil.grab_focus(_hwnd(self.root)):
            self.sendbar.pack_forget()
            log.warning("보내기 입력줄: 포커스를 가져오지 못했습니다")
            self.add_system("⚠ " + tr("입력줄로 포커스를 가져오지 못했습니다"), "error")
            return
        self.send_entry.focus_force()
        self._send_open = True
        self._send_busy = False
        self._send_armed = False
        self._send_lost = None
        self._send_opened = time.monotonic()
        log.info("보내기 입력줄 열림")

    def _send_open_step(self):
        now = time.monotonic()
        # Enter only counts after it was let go once (so a long Shift+Enter cannot submit anything)
        if not self._send_armed and now - self._send_opened >= 0.1 and not winutil.key_down(winutil.VK_RETURN):
            self._send_armed = True
        if self._send_busy:
            return
        if self._pid_of(winutil.foreground()) != os.getpid():
            if self._send_lost is None:
                self._send_lost = now
            elif now - self._send_lost > 0.7:            # the user switched to another program: forget the box
                log.info("보내기 입력줄: 포커스를 잃어 닫음")
                self._send_close(refocus=False)
        else:
            self._send_lost = None

    def _send_submit(self, _e=None):
        if self._send_busy or not self._send_armed:
            return "break"
        raw = self.send_entry.get().strip()
        if not raw:
            return "break"
        self._send_busy = True
        self.send_entry.configure(state="readonly")
        self.send_lang_lbl.configure(text=tr("번역 중..."))
        cfg = dict(self.cfg)

        def work():
            try:
                res, err = outgoing.prepare(cfg, raw), None
            except outgoing.OutgoingError as e:
                res, err = None, str(e)
            except Exception as e:
                log.exception("보내기 번역 실패")
                res, err = None, tr("번역 실패: {err}", err=str(e) or e.__class__.__name__)
            self.q.put(("call", lambda: self._send_done(res, err, cfg)))

        threading.Thread(target=work, daemon=True).start()
        return "break"

    def _send_done(self, res, err, cfg):
        self._send_busy = False
        if not self._send_open:                          # cancelled while translating
            return
        self.send_entry.configure(state="normal")
        self.send_lang_lbl.configure(text=tr("→ {lang}", lang=cfg.get("send_lang") or "English"))
        if err:                                          # problems go to the chat log; the box stays open for another try
            self.add_system("⚠ " + err, "error")
            return
        if not winutil.set_clipboard(res.text):
            self.add_system("⚠ " + tr("클립보드에 복사하지 못했습니다"), "error")
            return
        log.info("보내기: 클립보드에 복사 (%d바이트)", len(res.text.encode("utf-8")))
        self._insert("↗ " + res.text + "\n", "trans")
        if res.note:
            self.add_system(res.note)
        self._send_close(refocus=True, paste=bool(cfg.get("send_autopaste")))

    def _send_cancel(self, _e=None):
        self._send_close(refocus=True)
        return "break"

    def _send_close(self, refocus, paste=False):
        was = self._send_open
        self._send_open = False
        self._send_busy = False
        try:
            self.sendbar.pack_forget()
        except tk.TclError:
            pass
        if was and refocus:
            self._send_refocus(paste)

    def _send_refocus(self, paste):
        self._send_pending = True
        t0 = time.monotonic()

        def step():
            if winutil.key_down(winutil.VK_RETURN) and time.monotonic() - t0 < 1.5:
                self.root.after(25, step)                # let go of Enter first
                return
            game = self._send_game
            ok = winutil.focus_window(game)
            if not ok:
                log.warning("와우로 포커스를 돌리지 못했습니다")
            if paste and ok:
                self.root.after(160, lambda: self._send_paste(game))
            else:
                self._send_pending = False

        step()

    def _send_paste(self, game, tries=0):
        try:
            if winutil.foreground() != game:
                self.add_system("⚠ " + tr("자동 붙여넣기를 하지 않았습니다: 와우가 활성 창이 아닙니다"), "error")
            elif any(winutil.key_down(k) for k in (winutil.VK_SHIFT, winutil.VK_CONTROL, winutil.VK_MENU)) and tries < 40:
                self.root.after(25, lambda: self._send_paste(game, tries + 1))      # wait until modifier keys are up
                return
            else:
                winutil.send_ctrl_v()
        finally:
            self._send_pending = False

    # ---- moving / resizing
    def _drag_start(self, e):
        self.dragging = True
        self._dx = e.x_root - self.root.winfo_x()
        self._dy = e.y_root - self.root.winfo_y()

    def _drag_move(self, e):
        self.root.geometry(f"+{e.x_root - self._dx}+{e.y_root - self._dy}")

    def _drag_end(self, _e):
        self.dragging = False

    def _resize_move(self, e):
        w = max(260, e.x_root - self.root.winfo_rootx())
        h = max(120, e.y_root - self.root.winfo_rooty())
        self.root.geometry(f"{w}x{h}")

    def _wheel(self, e):
        self.text.yview_scroll(-3 if e.delta > 0 else 3, "units")

    # ---- two-window plumbing
    def _on_configure(self, e):
        if e.widget is self.root:
            self._sync_back()

    def _sync_back(self):
        if self.two_window:
            r = self.root
            self.back.geometry(f"{r.winfo_width()}x{r.winfo_height()}+{r.winfo_x()}+{r.winfo_y()}")

    # ---- taskbar: both windows must stay invisible to the taskbar / Alt+Tab
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

    def _fix_taskbar(self):
        if self._owner is None:
            self._owner = self._make_owner()
        for win in (self.root, self.back):
            try:
                shown = bool(win.winfo_ismapped())
                if shown:
                    win.withdraw()                  # the taskbar only re-reads the style when a window is shown again
                self._hide_from_taskbar(win)
                if shown:
                    win.deiconify()
                    self._hide_from_taskbar(win)
            except tk.TclError:
                pass
        self._stack_back()
        self.root.after(1000, self._log_windows)

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

    # ------------------------------------------------------------------ "only above the game window"
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
        me = (_hwnd(self.root), _hwnd(self.back))
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
        except Exception:
            if not self._follow_failed:
                self._follow_failed = True
                log.exception("게임 창 위 배치 실패")
        self.root.after(120, self._follow_game)

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
            if self.two_window:
                u.SetWindowPos(back, me, 0, 0, 0, 0, flags)
            log.info("게임에 포커스: 창을 맨 위로 (게임=%s)", game)
        else:
            if game:
                self._place_above_game(force=True)               # just above the game, no longer topmost
            else:
                u.SetWindowPos(me, -2, 0, 0, 0, 0, flags)        # HWND_NOTOPMOST
                if self.two_window:
                    u.SetWindowPos(back, me, 0, 0, 0, 0, flags)
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
        mine = (me, back) if self.two_window else (me,)
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
        if self.two_window:
            u.SetWindowPos(back, me, 0, 0, 0, 0, flags)
        now = time.monotonic()
        if now - self._follow_logged > 10:                 # leave a trace in the log tab without flooding it
            self._follow_logged = now
            log.info("게임 창 위로 재배치 | 게임=%s 바로 위 창=%s 기준=%s 결과=%s", g, above, ia, bool(ok1))

    def _stack_back(self):
        """Put the background window directly below the text window."""
        if not self.two_window:
            return
        try:
            _user32().SetWindowPos(_hwnd(self.back), _hwnd(self.root), 0, 0, 0, 0, 0x1 | 0x2 | 0x10)
        except Exception:
            pass

    def _copy_selection(self, _e=None):
        try:
            txt = self.text.get("sel.first", "sel.last")
        except tk.TclError:
            return "break"
        if txt:
            self.root.clipboard_clear()
            self.root.clipboard_append(txt)
            self.lbl_title.configure(text=tr("복사됨 ✓ ({n}자)", n=len(txt)))
            self.root.after(1500, lambda: self.lbl_title.configure(text="ChatMatrix"))
        return "break"

    def _auto_copy(self, _e=None):
        """With click-through on there is no keyboard focus to press Ctrl+C: copy as soon as a selection is made."""
        if self.cfg["click_through"]:
            self._copy_selection()

    def _back_xy(self, e):
        return e.x_root - self.text.winfo_rootx(), e.y_root - self.text.winfo_rooty()

    def _back_press(self, e):
        try:
            self.root.focus_force()
            self.text.focus_set()
            x, y = self._back_xy(e)
            self.text.tag_remove("sel", "1.0", "end")
            self.text.mark_set("anchor_b", f"@{x},{y}")
        except tk.TclError:
            pass

    def _back_motion(self, e):
        try:
            x, y = self._back_xy(e)
            a, b = self.text.index("anchor_b"), self.text.index(f"@{x},{y}")
            if self.text.compare(a, ">", b):
                a, b = b, a
            self.text.tag_remove("sel", "1.0", "end")
            self.text.tag_add("sel", a, b)
        except tk.TclError:
            pass

    # ------------------------------------------------------------------ text area
    def add_system(self, msg, tag="system"):
        self._insert(msg + "\n", tag)

    def clear_text(self):
        self.text.delete("1.0", "end")
        self.marks.clear()

    def _insert(self, s, tag, index="end"):
        """`s` is a string, or a list of (text, extra_tag_or_None) pieces drawn in `tag` (+ the extra tag)."""
        at_bottom = self.text.yview()[1] >= 0.999
        if isinstance(s, str):
            self.text.insert(index, s, tag)
        else:
            args = []
            for piece, extra in s:
                args += [piece, (tag, extra) if extra else tag]
            self.text.insert(index, *args)                      # one call: the pieces stay in order at a mark too
        n = int(self.text.index("end-1c").split(".")[0])
        keep = int(self.cfg["max_lines"])
        if n > keep:
            self.text.delete("1.0", f"{n - keep}.0")
        if at_bottom:
            self.text.see("end")

    # ------------------------------------------------------------------ data flow
    def on_new_line(self, line):
        """A chat line that has not been seen before: show it, and ask for a translation."""
        ts = (time.strftime("%H:%M:%S") + " ") if self.cfg.get("show_time", True) else ""
        restricted = line.text == "[restricted]"
        tag = "restricted" if restricted else channel_tag(line.channel)
        who = f"[{line.sender}]: " if line.sender else ""          # [name]: message
        parts = [(f"{ts}({line.channel}) {who}", None)]
        parts += [(p, f"q{q}" if q in chattext.QUALITY_COLORS else None) for p, q in chattext.segments(line.text)]
        parts.append(("\n", None))
        self._insert(parts, tag)

        text = chattext.plain(line.text)                          # item-link markers removed
        if restricted or not translator.should_translate(text, self.cfg):
            return
        token = next(self.tokens)
        mark = f"tr{token}"
        self.text.mark_set(mark, "end-1c")
        self.text.mark_gravity(mark, "left")          # later lines are inserted after the mark
        self.marks[token] = mark
        if not self.translations.submit(token, text):
            self._drop_mark(token)
            self.status.set(tr("번역 대기열이 가득 차서 일부 줄을 번역하지 못했습니다"))

    def _drop_mark(self, token):
        mark = self.marks.pop(token, None)
        if mark:
            try:
                self.text.mark_unset(mark)
            except tk.TclError:
                pass

    def on_translation(self, token, result, err):
        mark = self.marks.get(token)
        if mark is None:
            return
        try:
            if err:
                self.status.set(tr("번역 오류: {err}", err=err))
                if err != self.last_error:                  # don't flood the window with the same error
                    self.last_error = err
                    self._insert("    ⚠ " + tr("번역 오류: {err}", err=err) + "\n", "error", index=mark)
            elif result:
                self.last_error = None
                self._insert(f"    → {result}\n", "trans", index=mark)
        except tk.TclError:
            pass
        finally:
            self._drop_mark(token)

    def _log_status(self, text):
        """Log capture state changes only (the status text itself changes on every frame)."""
        if text.startswith(tr("연결됨")):
            if not self._connected:
                self._connected = True
                log.info("캡처: %s", text)
        elif text.startswith((tr("매트릭스를 잃어버림"), tr("캡처 오류"))):
            self._connected = False
            log.warning("캡처: %s", text)

    def poll(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "status":
                    self.status.set(payload)
                    self._log_status(payload)
                elif kind == "lines":
                    for line in payload:
                        self.on_new_line(line)
                elif kind == "trans":
                    self.on_translation(*payload)
                elif kind == "call":
                    payload()
                elif kind == "options":
                    self.open_options()
                elif kind == "quit":
                    self.on_close()
        except queue.Empty:
            pass
        self.root.after(50, self.poll)

    # ------------------------------------------------------------------ window settings
    def apply_window_settings(self):
        self.font.configure(size=int(self.cfg["font_size"]))
        gap = max(0, min(40, int(self.cfg.get("line_spacing", 4))))
        self.text.configure(spacing1=gap // 2, spacing3=gap - gap // 2, spacing2=gap // 2)   # between lines / wrapped rows
        top = bool(self.cfg["topmost"]) and not self.cfg.get("topmost_wow_only")
        self.root.attributes("-topmost", top)
        self.back.attributes("-topmost", top)
        self._placed_for = None          # let the "only above the game" loop re-apply its state
        self.apply_opacity()
        self.set_click_through(bool(self.cfg["click_through"]))

    def apply_opacity(self):
        bg = max(0.03, min(1.0, float(self.cfg.get("bg_opacity", 1.0))))
        tx = max(0.2, min(1.0, float(self.cfg.get("text_opacity", 1.0))))
        self.two_window = abs(bg - tx) >= 0.005
        if not self.two_window:
            self.root.attributes("-transparentcolor", "")
            self.root.attributes("-alpha", tx)
            self.back.withdraw()
            return
        self.back.attributes("-alpha", bg)
        self.root.attributes("-transparentcolor", BG)       # background pixels of the text window disappear
        self.root.attributes("-alpha", tx)
        self.root.update_idletasks()
        self._sync_back()
        self._hide_from_taskbar(self.back)
        self.back.deiconify()
        self._hide_from_taskbar(self.back)
        self._stack_back()

    def _set_passthrough(self, on):
        for win in (self.root, self.back):
            if on:
                _set_exstyle(win, add=WS_EX_LAYERED | WS_EX_TRANSPARENT)
            else:
                _set_exstyle(win, remove=WS_EX_TRANSPARENT)

    def set_click_through(self, on):
        self._interactive = False
        self._set_passthrough(bool(on))

    def open_options(self):
        if self.opt is not None and self.opt.alive():
            self.opt.lift()
            return
        self.opt = OptionsWindow(self)

    def reopen_options(self, select_tab=None):
        """Rebuild the options window (after a language change)."""
        try:
            if self.opt is not None and self.opt.alive():
                x, y = self.opt.win.winfo_x(), self.opt.win.winfo_y()
                self.opt.win.destroy()
            else:
                x = y = None
        except tk.TclError:
            x = y = None
        self.opt = OptionsWindow(self)
        if x is not None:
            self.opt.win.geometry(f"+{x}+{y}")
        if select_tab is not None:
            self.opt.nb.select(select_tab)

    # ------------------------------------------------------------------
    def on_close(self):
        """X button: save, stop everything and end the whole Python process (no console window is left behind)."""
        try:
            log.info("종료")
            self.cfg["geometry"] = self.root.geometry()
            config.save(self.cfg)
            self.worker.stop()
            self.translations.shutdown()
        except Exception:
            log.exception("종료 정리 중 오류")
        try:
            self.tray.remove()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass
        logging.shutdown()
        os._exit(0)           # translation threads or the hotkey thread may still be waiting; do not wait for them

    def run(self):
        self.root.mainloop()


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


def main():
    try:
        i18n.init(config.load().get("language", i18n.AUTO))
    except Exception:
        pass
    if not _single_instance():
        _msgbox(tr("ChatMatrix Reader가 이미 실행 중입니다."), 0x40)
        return
    try:
        App().run()
    except Exception:
        log.exception("치명적 오류")
        last = traceback.format_exc().strip().splitlines()[-1]
        _msgbox(tr("오류가 발생해서 종료합니다.\n\n{last}\n\n자세한 내용: {path}", last=last, path=logsetup.PATH))
        logging.shutdown()
        os._exit(1)


if __name__ == "__main__":
    main()
