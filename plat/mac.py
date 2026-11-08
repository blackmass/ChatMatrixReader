"""macOS operating-system layer (needs pyobjc: AppKit + Quartz). Provides the same names as plat/win.py.

Differences from Windows that shape this file:
  * "window handle" of the game = the process id of WoW; our own windows are NSWindow objects found by their title.
  * Tk's overrideredirect on macOS keeps a title bar, so the windows are restyled through AppKit instead
    (borderless look, no shadow, visible on every Space / over full-screen Spaces).
  * Window order is controlled with window levels (floating while the game has the focus) and
    NSWindow.orderWindow:relativeTo: (just above the game's window otherwise).
  * There is no colour key: the front window is really transparent ("systemTransparent" background), so the
    program always uses the two-window mode.
  * No global hotkey (needs extra permissions); the options are reachable from the menu bar item,
    the application menu (Cmd+,), right click, and Shift+hover while click-through is on.
Nothing here touches the game."""
import fcntl
import logging
import os
import subprocess
import tempfile
import threading
import time

from i18n import tr
from . import macutil

log = logging.getLogger("cmr.mac")

KEY_BG = "systemTransparent"          # background of the front window: really see-through
OPTIONS_KEY = "Ctrl+Option+O / ⌘+,"
SHIFT_GRACE = 3                 # polls (50 ms each) the Shift state may read "up" before interaction ends
POLL_RESIZE = True
RESIZE_CURSOR = "bottom_right_corner"
FORCE_TWO_WINDOW = True
RESHOW_FOR_TASKBAR = False
RIGHT_CLICKS = ("<Button-2>", "<Button-3>", "<Control-Button-1>")      # Tk/Aqua: the secondary button is Button-2

# Windows-style flags kept so app.py can stay unchanged; only "transparent" (= clicks fall through) means anything here
WS_EX_APPWINDOW = WS_EX_LAYERED = WS_EX_NOACTIVATE = WS_EX_TOOLWINDOW = 0
WS_EX_TRANSPARENT = 1

LEVEL_NORMAL, LEVEL_FLOATING = 0, 3
ORDER_ABOVE, ORDER_BELOW = 1, -1


def _user32():
    return None


# ---------------------------------------------------------------------------------------------- NSWindow access
_cache = {}
_styled = set()
_want_keyboard = {}


def _hwnd(win):
    """The NSWindow of a Tk toplevel (matched by its unique title), None while it does not exist yet."""
    try:
        import AppKit
        title = win.wm_title()
        w = _cache.get(title)
        if w is not None and w in list(AppKit.NSApp.windows()):
            return w
        for w in AppKit.NSApp.windows():
            if str(w.title()) == title:
                _cache[title] = w
                return w
    except Exception:
        log.exception("NSWindow를 찾지 못했습니다")
    return None


def borderless(win, keyboard=True):
    """Window without any frame. `keyboard`: the window must be able to take keyboard input (the chat window)."""
    _want_keyboard[win.wm_title()] = keyboard
    _style(win)


def _style(win):
    """Apply the look once the NSWindow exists (harmless to call again)."""
    nsw = _hwnd(win)
    if nsw is None:
        return False
    key = win.wm_title()
    if key in _styled:
        return True
    try:
        import AppKit
        if _want_keyboard.get(key, True):
            mask = AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskFullSizeContentView
            nsw.setStyleMask_(mask)
            nsw.setTitlebarAppearsTransparent_(True)
            nsw.setTitleVisibility_(AppKit.NSWindowTitleHidden)
            for b in (AppKit.NSWindowCloseButton, AppKit.NSWindowMiniaturizeButton, AppKit.NSWindowZoomButton):
                btn = nsw.standardWindowButton_(b)
                if btn is not None:
                    btn.setHidden_(True)
            btn = nsw.standardWindowButton_(AppKit.NSWindowCloseButton)
            bar = btn.superview() if btn is not None else None
            while bar is not None and bar.superview() is not None and bar.superview() is not nsw.contentView().superview():
                bar = bar.superview()
            if bar is not None:
                bar.setHidden_(True)               # the invisible title bar would swallow clicks at the top edge
        else:
            nsw.setStyleMask_(AppKit.NSWindowStyleMaskBorderless)
        nsw.setMovableByWindowBackground_(False)
        nsw.setHasShadow_(False)
        nsw.setOpaque_(False)
        nsw.setBackgroundColor_(AppKit.NSColor.clearColor())
        nsw.setExcludedFromWindowsMenu_(True)
        nsw.setHidesOnDeactivate_(False)
        beh = (AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
               | AppKit.NSWindowCollectionBehaviorIgnoresCycle)
        nsw.setCollectionBehavior_(beh)
        _styled.add(key)
        log.info("창 모양 적용: %s (키보드=%s)", key, _want_keyboard.get(key, True))
        return True
    except Exception:
        log.exception("창 모양 적용 실패: %s", key)
        _styled.add(key)                                   # do not retry forever
        return False


def set_keycolor(win, color):
    """Windows: colour key. Here the front window is transparent by itself, so there is nothing to do."""


def setup_front(win):
    """Make a window's background really transparent (the text window and the shadow window)."""
    try:
        win.attributes("-transparent", True)
        win.configure(bg=KEY_BG)
    except Exception:
        log.exception("투명 창 설정 실패")


def _set_exstyle(win, add=0, remove=0):
    nsw = _hwnd(win)
    if nsw is None:
        return
    if add & WS_EX_TRANSPARENT:
        nsw.setIgnoresMouseEvents_(True)                   # clicks fall through
    elif remove & WS_EX_TRANSPARENT:
        nsw.setIgnoresMouseEvents_(False)


def setup_app(app):
    """Application-menu entries: Cmd+Q quits, Cmd+, opens the options."""
    try:
        app.root.createcommand("::tk::mac::Quit", app.on_close)
        app.root.createcommand("::tk::mac::ShowPreferences", app.open_options)
    except Exception:
        log.exception("응용 프로그램 메뉴 연결 실패")


def request_permissions(app):
    """Ask once, at start, for the permission the send box needs (so that all the system dialogs come together and
    one restart is enough). Screen recording is requested by the capture thread."""
    try:
        if app.cfg.get("send_enabled", True) and not macutil.listen_access():
            log.info("입력 모니터링 권한 요청")
            macutil.request_listen_access()
        if app.cfg.get("send_autopaste") and not macutil.post_access():
            log.info("키 입력(손쉬운 사용) 권한 요청")
            macutil.request_post_access()
    except Exception:
        log.exception("권한 요청 실패")


# ---------------------------------------------------------------------------------------------- hotkey / menu bar
class Hotkey:
    """No global hotkey on macOS (it would need another permission). Reported as 'ok' so that click-through stays
    available: the options remain reachable by right click, Shift+hover, Cmd+, and the menu bar item."""

    def __init__(self, out_queue):
        self.out = out_queue
        self.ready = threading.Event()
        self.ok = True

    def start(self):
        """Ctrl+Option+O anywhere. Read by polling the key state (the same way the send box does, same permission:
        'input monitoring'); without the permission it does nothing - Cmd+, and the menu bar item still work."""
        threading.Thread(target=self._poll, daemon=True).start()
        self.ready.set()

    def _poll(self):
        combo = (frozenset(("Ctrl", "Alt")), 0x4F)               # the O key
        was = True                                               # must be released once before it can fire
        logged = False
        while True:
            try:
                down = macutil.combo_down(combo)
                if down and not was:
                    log.info("전역 단축키 Ctrl+Option+O")
                    self.out.put(("options", None))
                was = down
                if not logged:
                    logged = True
                    log.info("전역 단축키 Ctrl+Option+O 감시 시작 (입력 모니터링 권한: %s)",
                             "있음" if macutil.listen_access() else "없음")
            except Exception:
                log.exception("전역 단축키 확인 실패")
                return
            time.sleep(0.04)


class Tray:
    """Menu bar item with a small menu (options / quit). Must be created on the main thread."""

    def __init__(self, out_queue, tip):
        self.out = out_queue
        self.tip = tip
        self.ready = threading.Event()
        self.ok = False
        self._item = None
        self._target = None

    def start(self):
        try:
            import AppKit
            import objc

            class CMTarget(AppKit.NSObject):
                def openOptions_(self, sender):
                    self.q.put(("options", None))

                def quitApp_(self, sender):
                    self.q.put(("quit", None))

            target = CMTarget.alloc().init()
            target.q = self.out
            bar = AppKit.NSStatusBar.systemStatusBar()
            item = bar.statusItemWithLength_(AppKit.NSVariableStatusItemLength)
            item.setVisible_(True)
            btn = item.button()
            btn.setTitle_("CM")
            btn.setToolTip_(self.tip)
            menu = AppKit.NSMenu.alloc().init()
            for title, sel in ((tr("옵션 열기"), "openOptions:"), (tr("종료"), "quitApp:")):
                mi = menu.addItemWithTitle_action_keyEquivalent_(title, sel, "")
                mi.setTarget_(target)
            item.setMenu_(menu)
            self._item, self._target = item, target
            self.ok = True
            try:
                log.info("메뉴 막대 아이콘: 버튼 창 위치 %s", btn.window().frame() if btn.window() is not None else None)
            except Exception:
                pass
        except Exception:
            log.exception("메뉴 막대 아이콘을 만들지 못했습니다")
        self.ready.set()

    def remove(self):
        try:
            if self._item is not None:
                import AppKit
                AppKit.NSStatusBar.systemStatusBar().removeStatusItem_(self._item)
        except Exception:
            pass


# ---------------------------------------------------------------------------------------------- message box / single instance
def _msgbox(text, icon=0x10):
    try:
        esc = str(text).replace("\\", "\\\\").replace('"', '\\"')
        kind = "caution" if icon == 0x10 else "note"
        subprocess.run(["osascript", "-e",
                        f'display dialog "{esc}" with title "ChatMatrix Reader" buttons {{"OK"}} '
                        f'default button "OK" with icon {kind}'], timeout=600, check=False)
    except Exception:
        pass


_lock_file = None


def _single_instance():
    """False if another copy is already running."""
    global _lock_file
    try:
        _lock_file = open(os.path.join(tempfile.gettempdir(), "chatmatrixreader.%d.lock" % os.getuid()), "w")
        fcntl.flock(_lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False
    except Exception:
        return True


# ---------------------------------------------------------------------------------------------- window mixin
class WindowMixin:
    """Window-order / focus / game-window methods of the App (macOS). App inherits them.
    A "window" of another program is represented by the pid of its application."""

    _game_win = None                 # CGWindowID of the game's main window (for ordering right above it)
    _game_checked = 0.0

    def _cursor_inside(self):
        x, y = self.root.winfo_pointerxy()
        x0, y0 = self.root.winfo_rootx(), self.root.winfo_rooty()
        return x0 <= x < x0 + self.root.winfo_width() and y0 <= y < y0 + self.root.winfo_height()

    @staticmethod
    def _key_down(vk):
        return macutil.key_down(vk)

    def _fg_info(self):
        pid = macutil.foreground()
        return pid, pid

    @staticmethod
    def _pid_of(handle):
        return handle

    def _make_owner(self):
        return 1                                           # nothing like a taskbar button exists here

    def _hide_from_taskbar(self, win):
        _style(win)
        if win is self.shad:                               # the shadow window never takes the mouse (its NSWindow only
            _set_exstyle(win, add=WS_EX_TRANSPARENT)       # exists once it has been shown, so this is the first chance)

    def _all(self):
        out = [self.root]
        if self.shad is not None and self._shadow_active():
            out.append(self.shad)
        out.append(self.back)
        return [w for w in (_hwnd(x) for x in out) if w is not None]

    def _log_windows(self):
        try:
            import AppKit
            found = []
            for w in AppKit.NSApp.windows():
                if w.isVisible():
                    found.append(f"['{w.title()}' level={int(w.level())} style={int(w.styleMask())} "
                                 f"frame={tuple(round(v) for v in (w.frame().origin.x, w.frame().origin.y, w.frame().size.width, w.frame().size.height))}]")
            log.info("보이는 창 %d개: %s", len(found), " ".join(found))
        except Exception:
            log.exception("창 목록 조회 실패")

    def _scan_game(self):
        """(pid, window number, area, owner, name) of the biggest normal window of WoW, else of the configured title."""
        import Quartz
        opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
        title = (self.cfg.get("wow_window_title") or "").strip().lower()
        me = os.getpid()
        by_app, by_title = [], []
        for w in Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []:
            pid = int(w.get(Quartz.kCGWindowOwnerPID, 0))
            if pid == me or int(w.get(Quartz.kCGWindowLayer, 0)) != 0:
                continue
            owner = str(w.get(Quartz.kCGWindowOwnerName, "") or "")
            name = str(w.get(Quartz.kCGWindowName, "") or "")
            b = w.get(Quartz.kCGWindowBounds) or {}
            area = int(b.get("Width", 0) * b.get("Height", 0))
            if area < 200 * 100:
                continue
            row = (area, pid, int(w.get(Quartz.kCGWindowNumber, 0)), owner, name)
            low = owner.lower()
            if low.startswith("wow") or low == "world of warcraft":
                by_app.append(row)
            elif title and name.strip().lower() == title:
                by_title.append(row)
        pool = by_app or by_title
        if not pool:
            return None
        area, pid, num, owner, name = max(pool)
        return pid, num, area, owner, name

    def _find_game(self):
        now = time.monotonic()
        g = self._game_hwnd
        if g and now - self._game_checked < 1.0:
            return g
        if not g and now < self._game_next_search:
            return None
        self._game_checked = now
        try:
            found = self._scan_game()
        except Exception:
            if not self._follow_failed:
                self._follow_failed = True
                log.exception("게임 창 찾기 실패")
            found = None
        if found:
            pid, num, area, owner, name = found
            if pid != g:
                log.info("게임 창 찾음: pid=%s 창번호=%s 프로그램=%s 제목=%r 크기(면적)=%d", pid, num, owner, name, area)
            self._game_hwnd, self._game_win = pid, num
            return pid
        if g:
            log.info("게임 창이 사라졌습니다")
        self._game_hwnd = self._game_win = None
        self._game_next_search = now + 2.0
        if now - self._game_warned > 60:
            self._game_warned = now
            log.warning("게임 창을 찾지 못했습니다 (WoW 창 없음, 제목 %r 일치 없음). 와우가 실행 중인지 확인하세요",
                        (self.cfg.get("wow_window_title") or ""))
        return None

    def _follow_game(self):
        """Same idea as on Windows: floating (above everything) while the game has the focus; as soon as another
        program is active the window drops to just above the game window, so that program can cover it.
        Also notices the moment the focus comes back to the game (the matrix is searched again if it was lost)."""
        try:
            g = self._find_game()
            fg = macutil.foreground()
            if g and fg == g and self._fg_last != g:
                self._game_entered()
            if fg:
                self._fg_last = fg
            if self.cfg.get("topmost_wow_only"):
                if not g:
                    if self._follow_top:
                        self._set_follow_topmost(False, None)
                elif fg == os.getpid():
                    pass                                   # our own window has the focus: leave everything as it is
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

    def _watch_game_focus(self):
        pass                                               # levels keep us above the game; no re-raise needed

    def _fix_order_if_covered(self):
        pass

    def _set_level(self, level):
        for w in self._all():
            w.setLevel_(level)

    def _set_follow_topmost(self, on, game):
        self._follow_top = on
        if on:
            self._set_level(LEVEL_FLOATING)
            root = _hwnd(self.root)
            if root is not None:
                root.orderFrontRegardless()                # in front, without becoming the active window
            self._stack_back(force=True)
            log.info("게임에 포커스: 창을 맨 위로 (게임=%s)", game)
        else:
            self._set_level(LEVEL_NORMAL)
            if game:
                self._place_above_game(force=True)
            else:
                self._stack_back(force=True)
            log.info("다른 프로그램에 포커스: 창을 게임 바로 위로 (게임=%s)", game)

    def _place_above_game(self, force=False):
        g = self._find_game()
        num = self._game_win
        root = _hwnd(self.root)
        if not g or not num or root is None:
            return
        root.orderWindow_relativeTo_(ORDER_ABOVE, num)
        self._stack_back(force=True)
        now = time.monotonic()
        if now - self._follow_logged > 10:
            self._follow_logged = now
            log.info("게임 창 위로 재배치 | 게임 창번호=%s", num)

    def _below_hwnds(self):
        out = []
        if self.two_window:
            if self._shadow_active():
                out.append(_hwnd(self.shad))
            out.append(_hwnd(self.back))
        return [w for w in out if w is not None]

    def _stack_back(self, force=False):
        """Shadow window (if any) and background window directly below the text window, in that order."""
        if not self.two_window:
            return
        try:
            import AppKit
            root = _hwnd(self.root)
            chain = [root] + self._below_hwnds()
            if root is None or len(chain) < 2:
                return
            if not force:
                order = list(AppKit.NSApp.orderedWindows())
                idx = [order.index(w) for w in chain if w in order]
                if len(idx) == len(chain) and idx == sorted(idx):
                    return                                 # already right: touch nothing (no flicker)
            prev = root
            for w in chain[1:]:
                w.orderWindow_relativeTo_(ORDER_BELOW, prev.windowNumber())
                prev = w
        except Exception:
            log.exception("창 순서 정리 실패")

    def _set_passthrough(self, on):
        for win in (self.root, self.back):
            if on:
                _set_exstyle(win, add=WS_EX_TRANSPARENT)
            else:
                _set_exstyle(win, remove=WS_EX_TRANSPARENT)

    def _restore_foreground(self, pid):
        macutil._activate(pid)
