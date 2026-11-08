"""ChatMatrix Reader - borderless translation window fed by the on-screen ChatMatrix.

Window layout
  * No Windows title bar / border. A small custom title bar, a thin scrollbar, a resize grip and an edge line
    appear only while the mouse is over the window.
  * Background opacity and text opacity are separate. When they differ, two windows are used:
      back  = solid background colour with its own alpha (never takes focus)
      front = the text, with the background colour keyed out (transparent) and its own alpha
    When they are equal, a single ordinary window is used.
"""
import plat
from plat import (Hotkey, Tray, WindowMixin, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
                  _hwnd, _msgbox, _set_exstyle, _single_instance)    # importing plat also switches on DPI awareness





import itertools
import logging
import os
import re
import queue
import sys
import traceback
import threading
import time
import tkinter as tk
import tkinter.font as tkfont

import config
import chattext
import fonts
import glossary
import hotkeys
import outgoing
from plat import winutil
import i18n
import logsetup
import translator
import updatecheck
import usage
import version
from i18n import tr
from capture import CaptureWorker
from options import OptionsWindow

logsetup.setup()
log = logging.getLogger("cmr.app")

BG_SOLID = "#1e1f22"      # the colour key of the front window in two-window mode (Windows): nothing else may use it
CLEARED_ALPHA = 0.01      # "fully transparent" on hover: not exactly 0, so the system keeps treating the windows as present
                          # (going to 0 and back may switch the game between display modes = a short stutter)
BG = plat.KEY_BG or BG_SOLID   # macOS: really transparent instead
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
    "yell": "#ff4040", "emote": "#ff8040", "raidwarning": "#ff4800", "bnet": "#00fff6",
}
# "Other" messages (line codes starting with "!"): the game's default chat colours, approximately. The addon does not send
# colours; a code that is not listed here is shown with the "other" colour.
OTHER_COLORS = {
    "!SY": "#ffff00", "!IG": "#ff0000", "!XP": "#6f6fff", "!HN": "#f0b300", "!RP": "#8080ff", "!SK": "#5555ff",
    "!LT": "#00aa00", "!CY": "#00aa00", "!MN": "#ffff00", "!CI": "#8080ff", "!AC": "#ffff00", "!GA": "#40ff40",
    "!BH": "#ff4040", "!BA": "#4090ff", "!BN": "#ffa040",
    "!MS": "#ffff9e", "!MY": "#ff4040", "!ME": "#ff8040", "!MW": "#ffb5f0", "!MP": "#aaaaff",
    "!BE": "#ffdd00", "!BW": "#ffdd00",
}
TAG_COLORS.update({code: color for code, color in OTHER_COLORS.items()})
# "Other" lines that are somebody speaking (NPC / boss): these are translated; loot, money, experience ... are not
SPEECH_CODES = ("!MS", "!MY", "!ME", "!MW", "!MP", "!BE", "!BW")


def channel_tag(ch: str) -> str:
    if ch == "Y":
        return "yell"
    if ch == "E":
        return "emote"
    if ch == "RW":
        return "raidwarning"
    if ch == "B":
        return "bnet"
    if ch.startswith("!"):
        return ch if ch in OTHER_COLORS else "other"
    if ch == "S":
        return "say"
    if ch == "P":
        return "party"
    if ch in ("R", "I"):
        return "raid"
    if ch == "G":
        return "guild"
    if ch == "O":
        return "officer"
    if ch == "W":
        return "whisper"
    if ch == "CM":
        return "community"
    if ch.startswith("C"):
        return "channel"
    return "other"


# ----------------------------------------------------------------------
# small Win32 helpers
# ----------------------------------------------------------------------




















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


class App(WindowMixin):
    def __init__(self):
        self.cfg = config.load()
        i18n.init(self.cfg.get("language", i18n.AUTO))      # before any text is created
        glossary.ensure_default(self.cfg.get("glossary_file"))
        self.q = queue.Queue()
        translator.usage_notify = self._usage_notice
        self.opt = None
        self.tokens = itertools.count(1)
        self.marks = {}            # token -> text mark name (where the translation goes)
        self.last_error = None
        self.chrome_on = False
        self.dragging = False
        self.two_window = False
        self.tick_n = 0

        self.root = tk.Tk()
        self.root.title("ChatMatrix Reader")           # macOS finds its window by this title
        plat.borderless(self.root, keyboard=True)
        self._connected = False
        self._shift_grace = 0
        self._interactive = False      # click-through temporarily lifted by holding Shift
        self._game_hwnd = None         # cached game window (for "only above the game window")
        self._follow_failed = False
        self._game_next_search = 0.0
        self._game_warned = 0.0
        self._follow_logged = 0.0
        self._placed_for = None        # game window we last stacked above
        self._follow_top = False       # currently kept topmost because the game has the focus
        self._btn_prev = False         # a mouse button was down at the previous check
        self._press_outside = False    # ... and the press began outside this window (camera turning in the game, a drag ...)
        self._ghost_pass = False       # the window lets mouse input through only while such a press lasts
        self._hover_cleared = False    # fully transparent because the mouse is over the window (option "hover_clear")
        self._blur_on = False          # the background window is currently blurred (experiment)
        self._blur_paused = False      # blur switched off while the window is being moved / resized (it makes that very slow)
        self._fg_last = None           # window that had the focus at the previous check
        self._prev_fg = None           # window that had focus before we became interactive
        self.latest = None             # newest release tag found by the update check (e.g. "v1.3.0")
        self.shad = None               # text-shadow window (created when the option is first on)
        self.stext = None
        self._shadow_on = False
        self._shadow_job = None
        self._shadow_last = None
        self._shad_pad = 0             # bottom margin of the shadow text, so it is as tall as the real text (send box open)
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
        plat.setup_front(self.root)

        self.hotkey = Hotkey(self.q)
        self.hotkey.start()
        self.hotkey.ready.wait(1.0)
        self.tray = Tray(self.q, tr("ChatMatrix Reader  (클릭: 옵션)"))
        self.tray.start()
        self.tray.ready.wait(2.0)
        log.info("트레이 아이콘: %s", "표시됨" if self.tray.ok else "만들지 못함")
        if self.cfg["click_through"] and not self.hotkey.ok:
            self.cfg["click_through"] = False     # never lock the user out of the options

        self.custom_fonts = fonts.load_all()
        self.font = tkfont.Font(family=self._font_family(), size=int(self.cfg["font_size"]))
        self._build_main()
        self._build_back()
        self.root.update_idletasks()
        self.apply_window_settings()

        self.worker = CaptureWorker(self.q, lambda: self.cfg)
        self.worker.start()
        self.translations = translator.TranslationService(
            self.q, lambda: self.cfg, workers=max(1, min(8, int(self.cfg.get("max_parallel", 2)))))

        plat.setup_app(self)
        plat.request_permissions(self)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.bind("<Configure>", self._on_configure)
        self.root.bind("<FocusIn>", lambda e: self._stack_back())
        self.root.after(50, self.poll)
        self.root.after(80, self._hover_tick)
        self.root.after(500, self._follow_game)
        self.root.after(300, self._send_tick)
        self.root.after(400, self._fix_taskbar)
        try:
            import ssl
            ssl_ver = ssl.OPENSSL_VERSION
        except Exception:
            ssl_ver = "?"
        log.info("시작 | v%s | python %s | %s | 번역=%s | 목표=%s | 로그 파일: %s", version.__version__,
                 sys.version.split()[0], ssl_ver, self.cfg.get("translator"), self.cfg.get("target_lang"), logsetup.PATH)

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
        self.text.bind("<<Modified>>", self._on_text_modified)
        for name, color in TAG_COLORS.items():
            self.text.tag_configure(name, foreground=color)
        for q, color in chattext.QUALITY_COLORS.items():          # created after the channel tags -> they win
            self.text.tag_configure(f"q{q}", foreground=color)
        for letter, color in chattext.CLASS_COLORS.items():
            self.text.tag_configure(f"cls_{letter}", foreground=color)
        self.text.tag_configure("link", foreground="#6ea8fe", underline=True)          # clickable link (release page)
        self.text.tag_bind("link", "<Button-1>", lambda e: self.open_releases())
        self.text.tag_bind("link", "<Enter>", lambda e: self.text.configure(cursor="hand2"))
        self.text.tag_bind("link", "<Leave>", lambda e: self.text.configure(cursor="xterm"))

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
        self.text.configure(yscrollcommand=self._on_yscroll)
        self.text.bind("<Configure>", self._on_text_resized, add="+")
        self.sb.bind("<MouseWheel>", self._wheel)
        self.grip = tk.Label(self.body, text="◢", bg=BG, fg="#5a5f69", font=("Segoe UI Symbol", 9),
                             cursor=plat.RESIZE_CURSOR)
        self.grip.bind("<ButtonPress-1>", self._resize_start)
        self.grip.bind("<B1-Motion>", self._resize_move)
        self.grip.bind("<ButtonRelease-1>", self._resize_end)

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
        for seq in plat.RIGHT_CLICKS:
            self.root.bind(seq, lambda e: self.open_options())

        self.add_system(tr("제목줄/스크롤은 마우스를 올리면 나타납니다 | 우클릭 또는 ⚙: 옵션 | Ctrl+Alt+O: 옵션 | 클릭 통과 중에는 Shift를 누른 채로 조작").replace("Ctrl+Alt+O", plat.OPTIONS_KEY))
        if self.cfg.get("check_updates", True):
            self.check_update(self._on_start_update)
        if self.cfg.get("translate_test_start", True) and self.cfg.get("translator", "none") != "none":
            self._translate_test()

    def _build_back(self):
        """Background-only window used when background and text opacity differ."""
        self.back = tk.Toplevel(self.root)
        self.back.title("ChatMatrix Reader (background)")
        plat.borderless(self.back, keyboard=True)
        self.back.configure(bg=BG_SOLID)
        self.back.withdraw()
        self.back.update_idletasks()
        _set_exstyle(self.back, add=WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW)
        # clicks on the transparent parts of the front window land here: forward what matters
        self.back.bind("<ButtonPress-1>", self._back_press)
        self.back.bind("<B1-Motion>", self._back_motion)
        self.back.bind("<ButtonRelease-1>", self._auto_copy)
        self.back.bind("<MouseWheel>", self._wheel)
        for seq in plat.RIGHT_CLICKS:
            self.back.bind(seq, lambda e: self.open_options())

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



    def _hover_tick(self):
        try:
            ct = bool(self.cfg["click_through"])
            inside = self._cursor_inside()
            # A mouse button held down since before the pointer reached this window (turning the camera in the game: the
            # pointer is hidden but still moves) must not be taken over by this window: let the input through until release.
            btn = self._key_down(0x01) or self._key_down(0x02)
            if btn and not self._btn_prev:
                self._press_outside = not inside
            self._btn_prev = btn
            ghost = (not ct) and btn and self._press_outside
            if ghost != self._ghost_pass:
                self._ghost_pass = ghost
                self._set_passthrough(ghost or ct)
            if ct:
                # Shift + mouse over the window = behave like a normal window; a started drag/selection is finished first
                keep = self._interactive and (self.dragging or self._key_down(0x01))      # 0x01 = left button
                interactive = (self._key_down(0x10) and inside) or keep                   # 0x10 = Shift
                if self._interactive and not interactive and self._shift_grace > 0:      # macOS: key state may flicker
                    self._shift_grace -= 1
                    interactive = True
                elif interactive:
                    self._shift_grace = plat.SHIFT_GRACE
                if interactive != self._interactive:
                    self._interactive = interactive
                    self._set_passthrough(not interactive)
                    if interactive:
                        self._enter_interactive()
                    else:
                        self.text.tag_remove("sel", "1.0", "end")       # a half-made selection is not kept
                        self._leave_interactive()
                want = self.dragging or interactive
                self._set_hover_clear(bool(self.cfg.get("hover_clear")) and inside and not interactive and not self.dragging
                                      and not self._send_open and not self._send_pending)
            else:
                want = self.dragging or (inside and not ghost)
                self._set_hover_clear(False)
            self.set_chrome(bool(want))
            self._set_blur_paused(bool(self.dragging))              # also ends the pause when a drag ended by other paths
            self.tick_n += 1
            if self.two_window and self.tick_n % 10 == 0:
                self._stack_back()
        finally:
            self.root.after(50, self._hover_tick)


    def _set_blur_paused(self, paused):
        """A blurred window follows the pointer very slowly while it is moved or resized: show the plain translucent
        background during the drag and bring the blur back when the button is released."""
        if paused == self._blur_paused or not self._blur_on:
            return
        self._blur_paused = paused
        try:
            bg = max(0.03, min(1.0, float(self.cfg.get("bg_opacity", 1.0))))
            if paused:
                plat.set_blur(self.back, False)
                self.back.configure(bg=BG_SOLID)
                self.back.attributes("-alpha", max(0.3, bg))     # not nearly invisible: it only lasts for the drag
            else:
                self.back.attributes("-alpha", 1.0)
                self.back.configure(bg="#000000")
                plat.set_blur(self.back, True, BG_SOLID, bg, int(self.cfg.get("blur_state", 3)))
        except tk.TclError:
            pass

    def _set_hover_clear(self, on):
        """The mouse is over the (click-through) window and Shift is not held: make everything fully transparent so the
        game chat behind it can be read; back to normal as soon as the mouse leaves or Shift is pressed."""
        if on == self._hover_cleared:
            return
        self._hover_cleared = on
        try:
            if on:
                self.root.attributes("-alpha", CLEARED_ALPHA)
                if self.two_window:
                    self.back.attributes("-alpha", CLEARED_ALPHA)   # only the alpha changes: hiding / re-creating the blurred
                    if self.shad is not None:                    # window makes the game stutter for a moment
                        self.shad.attributes("-alpha", CLEARED_ALPHA)
            else:
                bg = max(0.03, min(1.0, float(self.cfg.get("bg_opacity", 1.0))))
                tx = max(0.2, min(1.0, float(self.cfg.get("text_opacity", 1.0))))
                self.root.attributes("-alpha", tx)
                if self.two_window:
                    self.back.attributes("-alpha", 1.0 if (self._blur_on and not self._blur_paused) else bg)     # blurred: its tint carries the opacity
                    if self._blur_on:                                                # the system may have dropped the blur strength
                        plat.set_blur(self.back, True, BG_SOLID, bg, int(self.cfg.get("blur_state", 3)))
                    if self.shad is not None and self._shadow_active():
                        self.shad.attributes("-alpha", tx)
        except tk.TclError:
            pass

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
                self._restore_foreground(prev)
        except Exception:
            pass


    # ------------------------------------------------------------------ send box
    # Shift+Enter (the game opens its chat box as usual) -> an input line appears at the bottom of this window ->
    # type in your own language, Enter -> the translation is put on the clipboard -> focus goes back to the game,
    # where the chat box is still open: Ctrl+V, Enter. Nothing is ever sent to the game by this program
    # (except Ctrl+V, and only when the option "auto paste" is on).
    # ---- update check (a notice only: nothing is downloaded or installed)
    def open_releases(self):
        import webbrowser
        try:
            webbrowser.open(version.RELEASES_URL)             # fixed address, never one taken from the server
        except Exception:
            log.exception("브라우저를 열지 못했습니다")

    def check_update(self, callback):
        """Ask GitHub for the newest release in a background thread; callback(tag or None, error or None) runs in the UI."""
        def work():
            try:
                tag, err = updatecheck.fetch_latest(), None
            except Exception as e:                       # offline, rate limit, odd answer ...: never a problem for the program
                tag, err = None, str(e) or e.__class__.__name__
                log.info("새 버전 확인 실패: %s", err)
            self.q.put(("call", lambda: callback(tag, err)))

        threading.Thread(target=work, daemon=True).start()

    def _translate_test(self):
        """Send a tiny request with the current translation method and say in the chat window whether it answered."""
        cfg = dict(self.cfg)
        mode = cfg.get("translator")
        if mode == "google":
            who = "Google" + (" (API Key)" if (cfg.get("google_api_key") or "").strip() else "")
        else:
            who = cfg.get("api_model") or cfg.get("api_url") or "AI"

        def work():
            t0 = time.perf_counter()
            try:
                translator.translate(cfg, "hi")
                ms = int((time.perf_counter() - t0) * 1000)
                msg, tag = "✔ " + tr("번역 서버 연결 양호: {who} ({ms}ms)", who=who, ms=ms), "system"
            except Exception as e:
                msg = "✖ " + tr("번역 서버에 연결하지 못했습니다: {who}", who=who) + " - " + (str(e) or e.__class__.__name__)[:160]
                tag = "error"
            self.q.put(("call", lambda: self.add_system(msg, tag)))

        threading.Thread(target=work, daemon=True).start()

    def _usage_notice(self, total):
        """Called from a translation thread each time the month's Google API character count passes a multiple of 100,000."""
        over = total > usage.FREE_LIMIT
        msg = tr("Google 번역 API 사용량이 이번 달 약 {used}자입니다 (무료 {limit}자 기준, 추정값)",
                 used=f"{total:,}", limit=f"{usage.FREE_LIMIT:,}")
        if over:
            msg += " - " + tr("무료 구간을 넘었을 수 있습니다")
        log.info("사용량 알림: %d자", total)
        self.q.put(("call", lambda: self.add_system("ℹ " + msg, "error" if over else "system")))

    def _on_start_update(self, tag, err):
        if tag:
            self.latest = tag
            log.info("최신 릴리스: %s (현재 v%s)", tag, version.__version__)
        if tag and updatecheck.is_newer(tag, version.__version__):
            self._insert([("⬆ " + tr("새 버전 {latest}이 있습니다 (현재 v{cur})", latest=tag, cur=version.__version__) + ": ", None),
                          (version.RELEASES_URL, "link"), ("\n", None)], "system")

    def _game_entered(self):
        """The focus has come back to the game. If the matrix is not being read (it was covered / the game was away),
        search for it again by itself, as the refresh button would. The game redraws a moment later, so look twice."""
        for ms in (400, 1500):
            self.root.after(ms, self._research_if_lost)

    def _research_if_lost(self):
        if not self._connected:
            log.info("게임으로 돌아옴: 매트릭스를 읽고 있지 않아 다시 찾습니다")
            self.worker.research()

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
                if winutil.send_ctrl_v() is False:
                    self.add_system("⚠ " + tr("자동 붙여넣기를 하지 않았습니다: 키 입력 권한이 없습니다 (시스템 설정 → 손쉬운 사용에서 Python 허용 후 다시 시작)"), "error")
        finally:
            self._send_pending = False

    # ---- moving / resizing
    def _drag_start(self, e):
        self.dragging = True
        self._set_blur_paused(True)
        self._dx = e.x_root - self.root.winfo_x()
        self._dy = e.y_root - self.root.winfo_y()

    def _drag_move(self, e):
        self.root.geometry(f"+{e.x_root - self._dx}+{e.y_root - self._dy}")

    def _drag_end(self, _e):
        self.dragging = False

    def _resize_start(self, e):
        self.dragging = True
        self._set_blur_paused(True)
        self._rs = (e.x_root, e.y_root, self.root.winfo_width(), self.root.winfo_height())
        if plat.POLL_RESIZE:
            self._resize_poll()

    def _resize_end(self, e):
        if plat.POLL_RESIZE:
            return                                         # the timer decides (macOS sends this when the pointer leaves)
        self.dragging = False

    def _resize_poll(self):
        """macOS: once the pointer is outside the window, motion events stop coming. Read the pointer by timer instead."""
        if not self.dragging:
            return
        if not self._key_down(0x01):                       # left button released (possibly outside the window)
            self._rs_up = getattr(self, "_rs_up", 0) + 1
            if self._rs_up >= 3:
                self._rs_up = 0
                self.dragging = False
                return
        else:
            self._rs_up = 0
        x, y = self.root.winfo_pointerxy()
        x0, y0, w0, h0 = self._rs
        self.root.geometry(f"{max(260, w0 + x - x0)}x{max(120, h0 + y - y0)}")
        self.root.after(15, self._resize_poll)

    def _resize_move(self, e):
        # by how far the pointer moved since the press (an absolute position would jump by the window frame's offset)
        x0, y0, w0, h0 = self._rs
        self.root.geometry(f"{max(260, w0 + e.x_root - x0)}x{max(120, h0 + e.y_root - y0)}")

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
            if self._shadow_active():
                dx = max(-5, min(5, int(self.cfg.get("shadow_dx", 1))))
                dy = max(-5, min(5, int(self.cfg.get("shadow_dy", 1))))
                self.shad.geometry(f"{r.winfo_width()}x{r.winfo_height()}+{r.winfo_x() + dx}+{r.winfo_y() + dy}")

    # ---- taskbar: both windows must stay invisible to the taskbar / Alt+Tab


    def _fix_taskbar(self):
        if self._owner is None:
            self._owner = self._make_owner()
        for win in (self.root, self.back, self.shad):
            if win is None:
                continue
            try:
                shown = bool(win.winfo_ismapped()) and plat.RESHOW_FOR_TASKBAR
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


    # ------------------------------------------------------------------ "only above the game window"









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

    def _at_bottom(self):
        """Is the last line on screen? (The fraction from yview() can be off while Tk is still measuring lines, which
        made the window stop following new lines.)"""
        try:
            self.text.update_idletasks()                          # finish pending line measuring first
            if self.text.bbox("end-1c") is not None:
                return True
        except Exception:
            pass
        return self.text.yview()[1] >= 0.999

    def _insert(self, s, tag, index="end"):
        """`s` is a string, or a list of (text, extra_tag_or_None) pieces drawn in `tag` (+ the extra tag)."""
        at_bottom = self._at_bottom()
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
        if self.cfg.get("skip_regex_hide") and line.text != "[restricted]" \
                and translator.matches_skip_regex(chattext.plain(line.text), self.cfg):
            return                                                # the user's pattern matches: leave the line out
        ts = (time.strftime("%H:%M:%S") + " ") if self.cfg.get("show_time", True) else ""
        restricted = line.text == "[restricted]"
        tag = "restricted" if restricted else channel_tag(line.channel)
        sender, body = line.sender, line.text
        if not restricted:
            body = chattext.resolve_josa(body)                    # the Korean client leaves  |1이;가;  in event texts
            if line.channel.startswith("!") and "%s" in body and sender:
                body, sender = body.replace("%s", sender), ""     # NPC emotes: "%s waves." -> the name goes into the text
        if sender:                                                # [name]: message  (the name in the class colour)
            ctag = f"cls_{line.cls}" if (self.cfg.get("class_colors", True) and line.cls in chattext.CLASS_COLORS) else None
            parts = [(f"{ts}({line.channel}) [", None), (sender, ctag), ("]: ", None)]
        else:
            parts = [(f"{ts}({line.channel}) ", None)]
        parts += [(p, f"q{q}" if q in chattext.QUALITY_COLORS else None) for p, q in chattext.segments(body)]
        parts.append(("\n", None))
        self._insert(parts, tag)

        text = chattext.plain(body)                               # item-link markers removed
        if line.channel.startswith("!") and line.channel not in SPEECH_CODES:
            return                                                # loot, money, experience, system ...: nothing to translate
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
    def _font_family(self):
        fam = self.cfg.get("font_family") or ""
        return fam if fam and fam in self.custom_fonts else fonts.DEFAULT_FAMILY

    def apply_window_settings(self):
        self.font.configure(family=self._font_family(), size=int(self.cfg["font_size"]))
        self.text.configure(**self._spacing())
        top = bool(self.cfg["topmost"]) and not self.cfg.get("topmost_wow_only")
        self.root.attributes("-topmost", top)
        self.back.attributes("-topmost", top)
        if self.shad is not None:
            self.shad.attributes("-topmost", top)
        self._placed_for = None          # let the "only above the game" loop re-apply its state
        self.apply_opacity()
        self.set_click_through(bool(self.cfg["click_through"]))

    def apply_opacity(self):
        bg = max(0.03, min(1.0, float(self.cfg.get("bg_opacity", 1.0))))
        tx = max(0.2, min(1.0, float(self.cfg.get("text_opacity", 1.0))))
        self._shadow_on = bool(self.cfg.get("shadow_on"))
        self._blur_paused = False
        self._hover_cleared = False                      # (re)applying brings the window back; the next tick clears it again
        self.two_window = (plat.FORCE_TWO_WINDOW or abs(bg - tx) >= 0.005 or self._shadow_on
                           or bool(self.cfg.get("blur_experiment")))          # the shadow needs the see-through text window
        if not self.two_window:
            if self.shad is not None:
                self.shad.withdraw()
            plat.set_keycolor(self.root, "")
            self.root.attributes("-alpha", tx)
            self.back.withdraw()
            if self._blur_on:
                plat.set_blur(self.back, False)
                self.back.configure(bg=BG_SOLID)
                self._blur_on = False
            return
        self.back.attributes("-alpha", bg)
        plat.set_keycolor(self.root, BG)                    # background pixels of the text window disappear
        self.root.attributes("-alpha", tx)
        self.root.update_idletasks()
        self._sync_back()
        self._hide_from_taskbar(self.back)
        self.back.deiconify()
        self._hide_from_taskbar(self.back)
        if self.cfg.get("blur_experiment"):             # blur behind the background window; its tint = "background" opacity
            self._blur_on = bool(plat.set_blur(self.back, True, BG_SOLID, bg, int(self.cfg.get("blur_state", 3))))
            if self._blur_on:
                self.back.attributes("-alpha", 1.0)
                self.back.configure(bg="#000000")        # the system treats pure black drawn by the window as "show the blur here"
        elif self._blur_on:
            plat.set_blur(self.back, False)
            self.back.configure(bg=BG_SOLID)
            self._blur_on = False
        self._apply_shadow(tx)
        self._stack_back()

    # ---- text shadow: a third, click-through window between the text window and the background window.
    # It holds the same text in one colour, shifted by (dx, dy); the text window's background is transparent,
    # so the copy shows through next to every glyph. Only exists while the option is on.
    def _shadow_active(self):
        return bool(self._shadow_on and self.shad is not None)

    def _below_hwnds(self):
        out = []
        if self.two_window:
            if self._shadow_active():
                out.append(_hwnd(self.shad))
            out.append(_hwnd(self.back))
        return out

    def _spacing(self):
        gap = max(0, min(40, int(self.cfg.get("line_spacing", 4))))
        return dict(spacing1=gap // 2, spacing3=gap - gap // 2, spacing2=gap // 2)   # between lines / wrapped rows

    def _build_shadow(self):
        self.shad = tk.Toplevel(self.root)
        self.shad.title("ChatMatrix Reader (shadow)")
        plat.borderless(self.shad, keyboard=True)
        self.shad.configure(bg=BG)
        plat.setup_front(self.shad)
        self.shad.withdraw()
        self.shad.update_idletasks()
        box = tk.Frame(self.shad, bg=BG, highlightthickness=1, highlightbackground=BG, highlightcolor=BG)
        box.pack(fill="both", expand=True)             # same frame / padding as the real text -> identical wrapping
        self.stext = tk.Text(box, wrap="word", bg=BG, fg="#000000", relief="flat", font=self.font, bd=0,
                             highlightthickness=0, padx=8, pady=6, insertwidth=0, cursor="arrow", takefocus=0,
                             selectbackground=BG, selectforeground="#000000", inactiveselectbackground=BG,
                             **self._spacing())
        self._shad_pad = 0
        self.stext.pack(fill="both", expand=True, padx=(0, SB_W + 2))
        self.stext.tag_configure("all", foreground="#000000")
        self._shadow_last = None
        log.info("그림자 창 생성")

    def _apply_shadow(self, tx):
        """Called from apply_opacity() in two-window mode."""
        if not self._shadow_on:
            if self.shad is not None:
                self.shad.withdraw()
            return
        if self.shad is None:
            self._build_shadow()
        color = self.cfg.get("shadow_color") or "#000000"
        try:
            self.stext.configure(fg=color, selectforeground=color)
            self.stext.tag_configure("all", foreground=color)
        except tk.TclError:
            self.stext.configure(fg="#000000")
            self.stext.tag_configure("all", foreground="#000000")
        self.stext.configure(**self._spacing())
        plat.set_keycolor(self.shad, BG)
        self.shad.attributes("-alpha", tx)
        top = bool(self.cfg["topmost"]) and not self.cfg.get("topmost_wow_only")
        self.shad.attributes("-topmost", top)
        _set_exstyle(self.shad, add=WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT)  # clicks fall through
        self._sync_back()
        self._hide_from_taskbar(self.shad)
        self.shad.deiconify()
        self._hide_from_taskbar(self.shad)
        self._shadow_last = None
        self._shadow_refresh()

    def _on_text_modified(self, _e=None):
        if not self.text.edit_modified():
            return
        self.text.edit_modified(False)
        if self._shadow_active() and self._shadow_job is None:
            self._shadow_job = self.root.after(40, self._shadow_refresh)

    def _shadow_refresh(self):
        self._shadow_job = None
        if not self._shadow_active():
            return
        try:
            content = self.text.get("1.0", "end-1c")
            if content != self._shadow_last:
                self.stext.delete("1.0", "end")
                self.stext.insert("1.0", content, "all")
                self._shadow_last = content
            self._sync_shadow()
        except tk.TclError:
            pass

    def _on_text_resized(self, _e=None):
        if self._shadow_active():
            self.root.after_idle(self._match_shadow_height)

    def _match_shadow_height(self):
        """The real text gets shorter while the send box is open; the shadow text must get shorter by the same amount,
        otherwise the two scroll to different positions at the bottom and the shadow no longer lines up."""
        if not self._shadow_active():
            return
        try:
            self.shad.update_idletasks()
            d = self.stext.winfo_height() - self.text.winfo_height()
            if d:
                self._shad_pad = max(0, self._shad_pad + d)
                self.stext.pack_configure(pady=(0, self._shad_pad))
                self.shad.update_idletasks()
            self._sync_shadow()
        except tk.TclError:
            pass

    def _sync_shadow(self):
        """Give the shadow text exactly the scroll position of the real text (to the pixel)."""
        if not self._shadow_active():
            return
        try:
            idx = self.text.index("@0,0")                     # the first line (part of it) shown by the real text
            self.stext.yview(idx)                              # same line on top (by index: a fraction can be off by a
                                                               # whole line while Tk is still measuring a new line)
            a, b = self.text.dlineinfo(idx), self.stext.dlineinfo(idx)
            if a and b and a[1] != b[1]:                       # then the pixel offset of a partly scrolled line
                self.stext.yview_scroll(b[1] - a[1], "pixels")
        except tk.TclError:
            pass

    def _on_yscroll(self, first, last):
        self.sb.set(first, last)
        if self._shadow_active():
            self._sync_shadow()


    def set_click_through(self, on):
        self._interactive = False
        self._set_passthrough(bool(on))

    def open_options(self):
        dump = getattr(self, "_state_dump", None)
        if dump:                                   # if the window had vanished, this shows why (before saving repairs it)
            try:
                log.info("옵션 열림 | 창 상태: %s", dump())
            except Exception:
                log.exception("창 상태 기록 실패")
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
