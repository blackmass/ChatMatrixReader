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
import joiner
import outgoing
from plat import winutil
import i18n
import logsetup
import migrate
import translator
import updatecheck
import usage
import version
import voice
import voicemeter
from decoder import Line
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
    "say": "#ffffff", "party": "#aaaaff", "raid": "#ff8000", "guild": "#40ff40",
    "officer": "#40bf40", "whisper": "#ff80ff", "channel": "#ffc0c0",
    "community": "#80d0d0", "other": "#aaaaaa", "restricted": "#777777", "system": DIM,
    "trans": "#7fd6b0", "error": "#d67f7f",
    "yell": "#ff4040", "emote": "#ff8040", "raidwarning": "#ff4800", "bnet": "#00fff6",
    "partyleader": "#75c7ff", "raidleader": "#ff480a",
}
# "Other" messages (line codes starting with "!"): the game's default chat colours, approximately. The addon does not send
# colours; a code that is not listed here is shown with the "other" colour.
OTHER_COLORS = {
    "!SY": "#ffff00", "!IG": "#ff0000", "!XP": "#6f6fff", "!HN": "#f0b300", "!RP": "#8080ff", "!SK": "#5555ff",
    "!LT": "#00aa00", "!CY": "#00aa00", "!MN": "#ffff00", "!CI": "#8080ff", "!AC": "#ffff00", "!GA": "#40ff40",
    "!OP": "#8080ff", "!PI": "#8080ff", "!TS": "#ffffff",           # opening (lockpicking, herbs ...), pet info, trade skills
    "!BH": "#ff4040", "!BA": "#4090ff", "!BN": "#ffa040",
    "!MS": "#ffff9e", "!MY": "#ff4040", "!ME": "#ff8040", "!MW": "#ffb5f0", "!MP": "#aaaaff",
    "!BE": "#ffdd00", "!BW": "#ffdd00", "!UN": "#b8b8b8", "!AD": "#ffffff", "!CL": "#bf8080",
    "!PG": "#ff5050",                                  # pings: stand out like a yell
    "!BI": "#66ccff",                                  # Battle.net friend online / offline (light blue like the game)
    "!CN": "#ffc0c0",                                  # channel notices ("Changed Channel: [...]"): the channel chat colour
    "!VC": "#9fe8ff",                                  # voice chat (recognised speech, see voice.py): light cyan
    "!TI": "#ffff00",                                  # raid-target marks set on somebody ("X marks Y with {skull}"): the yellow system colour
    "!TM": "#ffff00",                                 # "appearance added to your collection": a yellow system line (the item name keeps its quality colour)
}
TAG_COLORS.update({code: color for code, color in OTHER_COLORS.items()})
# "Other" lines that are somebody speaking (NPC / boss): these are translated; loot, money, experience ... are not
SPEECH_CODES = ("!MS", "!MY", "!ME", "!MW", "!MP", "!BE", "!BW")
TRANSLATED_CODES = SPEECH_CODES + ("!VC",)
# the symbol in front of a ping (the addon replaces the game's icon by it), coloured by kind
PING_COLORS = {"\u25c8": "#4da3ff", "\u2691": "#4ddc6b", "\u26a0": "#ff4545", "\u2694": "#ff9a2e", "\u25bc": "#4da3ff"}
SHOWN_CODE = {"WT": "W→", "BT": "B→"}        # whispers you sent: the name in the line is the receiver


def channel_tag(ch: str) -> str:
    if ch == "Y":
        return "yell"
    if ch == "E":
        return "emote"
    if ch == "RW":
        return "raidwarning"
    if ch in ("B", "BT"):
        return "bnet"
    if ch.startswith("!"):
        return ch if ch in OTHER_COLORS else "other"
    if ch == "S":
        return "say"
    if ch == "P":
        return "party"
    if ch == "PL":
        return "partyleader"
    if ch in ("R", "I"):
        return "raid"
    if ch in ("RL", "IL"):
        return "raidleader"
    if ch == "G":
        return "guild"
    if ch == "O":
        return "officer"
    if ch in ("W", "WT"):
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
        self.joiner = joiner.Joiner()    # pieces of a long message are put together before they are shown
        self.marks = {}            # token -> text mark name (where the translation goes)
        self.swapinfo = {}         # token -> what the "translation above the original" mode needs to fill / undo the top line
        self.link_names = {}       # token -> link names hidden behind [L1] [L2] while the line is translated
        self.last_error = None
        self.chrome_on = False
        self._past = False             # scrolled up: the newest line is not on screen (the frame and a notice are shown)
        self.dragging = False
        self.two_window = False
        self.tick_n = 0

        self.root = tk.Tk()
        self.root.title("ChatMatrix Reader")           # macOS finds its window by this title
        plat.borderless(self.root, keyboard=True)
        self._connected = False
        self._shift_grace = 0
        self._interactive = False      # click-through temporarily lifted by holding Shift
        self._suspend_ct = False       # click-through / hover-clear lifted because there is no game window (not a saved option)
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
        self.font_trans = tkfont.Font(family=self._font_family(), size=self._trans_size())
        self._build_main()
        self._build_back()
        self.root.update_idletasks()
        self.apply_window_settings()

        self._game_rect_cache = None                    # the game window on screen, refreshed once a second (main thread)
        self.worker = CaptureWorker(self.q, lambda: self.cfg, lambda: self._game_rect_cache)
        self.worker.start()
        self.voice = voice.VoiceManager(self.q, lambda: self.cfg)
        self._cap_status = ""          # the capture's last status text (shown again when a live voice text goes away)
        self._part_job = None
        self.translations = translator.TranslationService(
            self.q, lambda: self.cfg, workers=max(1, min(8, int(self.cfg.get("max_parallel", 2)))))

        plat.setup_app(self)
        plat.request_permissions(self)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.bind("<Configure>", self._on_configure)
        self.root.bind("<FocusIn>", lambda e: self._stack_back())
        self.root.after(50, self.poll)
        if self.cfg.get("voice_enabled"):
            self.root.after(1500, self.voice.start)
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
        self._configure_layout_tags(self.text)
        self._type_colors = {}                                    # channel code -> the colour its lines have now (see _type_tag)
        for q, color in chattext.QUALITY_COLORS.items():          # per-line base colour (lines that are not a chat type: !AD, !UN): above the channel tags, below the link colours
            self.text.tag_configure(f"bc{q}", foreground=color)
        for q, color in chattext.QUALITY_COLORS.items():          # created after the channel tags -> they win
            self.text.tag_configure(f"q{q}", foreground=color)
        self.text.tag_configure("protmark", foreground=chattext.QUALITY_COLORS[51])      # the ⚠ of a protected message: red
        self.text.tag_configure("guild", foreground=chattext.QUALITY_COLORS[2])      # <Guild Name>: item-green
        for letter, color in chattext.CLASS_COLORS.items():
            self.text.tag_configure(f"cls_{letter}", foreground=color)
        for glyph, color in PING_COLORS.items():
            self.text.tag_configure(f"pg{ord(glyph)}", foreground=color)
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
        self.btn_voice = tk.Label(self.title, text="🔊", bg=TITLE_BG, fg=DIM, font=btn_font, width=3, cursor="hand2")
        self.btn_voice.pack(side="right", fill="y")                 # between the refresh and the options button (packed from the right)
        self.btn_refresh = tk.Label(self.title, text="⟳", bg=TITLE_BG, fg=DIM, font=btn_font, width=3, cursor="hand2")
        self.btn_refresh.pack(side="right", fill="y")
        self.lbl_title = tk.Label(self.title, text="ChatMatrix", bg=TITLE_BG, fg="#cfd2d8",
                                  font=("Malgun Gothic", 9, "bold"), padx=8)
        self.lbl_title.pack(side="left", fill="y")
        self.lbl_status = tk.Label(self.title, textvariable=self.status, bg=TITLE_BG, fg=DIM,
                                   font=("Malgun Gothic", 8), anchor="w")
        self.lbl_status.pack(side="left", fill="both", expand=True)

        for w, hot in ((self.btn_close, "#e5484d"), (self.btn_opt, "#6b83b3"), (self.btn_refresh, "#6bb38a")):   # (the voice button has its own, see below)
            w.bind("<Enter>", lambda e, w=w, hot=hot: w.configure(fg=hot))
            w.bind("<Leave>", lambda e, w=w: w.configure(fg=DIM))
        self.btn_close.bind("<Button-1>", lambda e: self.on_close())
        self.btn_opt.bind("<Button-1>", lambda e: self.open_options())
        self.btn_refresh.bind("<Button-1>", lambda e: self._refresh_matrix())
        self.btn_voice.bind("<Button-1>", lambda e: self._voice_toggle())
        self.btn_voice.bind("<Enter>", lambda e: (self.btn_voice.configure(fg="#6bb38a"), self._voice_button_hint(True)))
        self.btn_voice.bind("<Leave>", lambda e: (self._voice_button_color(), self._voice_button_hint(False)))
        for w in (self.title, self.lbl_title, self.lbl_status):
            w.configure(cursor="fleur")
            w.bind("<ButtonPress-1>", self._drag_start)
            w.bind("<B1-Motion>", self._drag_move)
            w.bind("<ButtonRelease-1>", self._drag_end)

        # ---- overlay: scrollbar and resize grip
        self.sb = MiniScrollbar(self.body, lambda *a: self._scroll(self.text.yview, *a))
        self.text.configure(yscrollcommand=self._on_yscroll)
        self.text.bind("<Configure>", self._on_text_resized, add="+")
        self.sb.bind("<MouseWheel>", self._wheel)
        self.grip = tk.Label(self.body, text="◢", bg=BG, fg="#5a5f69", font=("Segoe UI Symbol", 9),
                             cursor=plat.RESIZE_CURSOR)
        self.grip.bind("<ButtonPress-1>", self._resize_start)
        self.grip.bind("<B1-Motion>", self._resize_move)
        self.grip.bind("<ButtonRelease-1>", self._resize_end)
        # the voice recognition indicator: created last, so it lies above the text, the title bar and the scrollbar
        self.vmodel = voicemeter.Model()
        self.vmeter = voicemeter.VoiceMeter(self.body, self._voice_clicked, self._voice_tip)
        self._vmeter_key = None
        self._vphase = 0
        self.root.after(150, self._vmeter_tick)

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

        self.add_system(tr("제목줄/스크롤은 마우스를 올리면 나타납니다 | 우클릭 또는 ⚙: 옵션 | Ctrl+Alt+O: 옵션 | 클릭 통과 중에는 {key}를 누른 채로 조작", key=self.interact_label()).replace("Ctrl+Alt+O", plat.OPTIONS_KEY))
        if self.cfg.get("check_updates", True):
            self.check_update(self._on_start_update)
        if self.cfg.get("translate_test_start", True) and self.cfg.get("translator", "none") != "none":
            self._translate_test()
        self._warm_last = self._warm_key()
        self._warm_pending = (None, 0)
        self._gloss_last = self._gloss_sig()
        self._gloss_pending = None
        self._conn_last = self._conn_key()
        self._conn_pending = None
        self.root.after(2000, self._warm_tick)
        self._lost_since = None                                  # when the matrix went missing while the game is running
        self.root.after(1000, self._lost_tick)

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
        self._place_vmeter()



    def _check_past(self):
        """Is the view scrolled up so that the newest line is hidden? Then the frame stays visible (as if the window were
        not click-through) with a notice in the title bar, so the old text is never mistaken for the current chat."""
        try:
            past = self.text.yview()[1] < 0.999 and self.text.bbox("end-1c") is None
        except tk.TclError:
            past = False
        if past != self._past:
            self._past = past
            self._refresh_title()
        return past

    def _refresh_title(self):
        if self._past:
            self.lbl_title.configure(text=tr("▲ 지난 대화 보는 중"), fg="#f0b84a")
        else:
            self.lbl_title.configure(text="ChatMatrix", fg="#cfd2d8")

    def _hover_tick(self):
        try:
            ct = bool(self.cfg["click_through"]) and not self._suspend_ct
            inside = self._cursor_inside()
            past = self._check_past()
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
                interactive = (self._interact_down() and inside) or keep
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
                want = self.dragging or interactive or past or self._suspend_ct      # no game: the frame stays visible
                self._set_hover_clear(bool(self.cfg.get("hover_clear")) and inside and not interactive and not self.dragging
                                      and not self._send_open and not self._send_pending)
            else:
                want = self.dragging or (inside and not ghost) or past or self._suspend_ct
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

    INTERACT_VK = {"Shift": 0x10, "Ctrl": 0x11, "Alt": 0x12}

    def interact_keys(self):
        """The keys that lift click-through (all of them must be held): Shift / Ctrl / Alt. macOS: Shift only."""
        keys = [k for k in ("Ctrl", "Alt", "Shift") if k in (self.cfg.get("interact_keys") or ["Shift"])]
        return keys if keys and sys.platform == "win32" else ["Shift"]

    def interact_label(self):
        return "+".join(self.interact_keys())

    def _interact_down(self):
        return all(self._key_down(self.INTERACT_VK[k]) for k in self.interact_keys())

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

    def _warm_key(self):
        """What the AI server has to read again when it changes: the prompt, the glossary file, the model/server.
        None = nothing to warm up (Google or another translator that does not take the prompt)."""
        cfg = self.cfg
        mode = cfg.get("translator", "none")
        if mode == "openai":
            extra = (cfg.get("api_url"), cfg.get("api_model"))
        elif mode == "custom" and "{system}" in (cfg.get("custom_body") or ""):
            extra = (cfg.get("custom_url"), cfg.get("custom_body"))
        else:
            return None
        return (mode, cfg.get("prompt"), (cfg.get("extra_prompt") or "").strip(), glossary.cache_key(cfg), extra)

    def _conn_key(self):
        """The settings that decide which server answers (changed in the options while the program runs)."""
        c = self.cfg
        mode = c.get("translator", "none")
        if mode == "openai":
            return (mode, c.get("api_url"), c.get("api_model"), c.get("api_key"))
        if mode == "google":
            return (mode, c.get("google_api_key"))
        if mode == "custom":
            return (mode, c.get("custom_url"), c.get("custom_key"), c.get("custom_headers"), c.get("custom_body"))
        return (mode,)

    def _conn_check(self):
        """The translation method (or its server / key) was changed while running: check the connection again, as
        at start, when that option is on. Returns True when it sent the request (it also warms the AI server up)."""
        key = self._conn_key()
        if key == self._conn_last:
            self._conn_pending = None
            return False
        if self._conn_pending != key:                        # wait one tick: the options may still be being saved
            self._conn_pending = key
            return False
        self._conn_last, self._conn_pending = key, None
        if key[0] == "none" or not self.cfg.get("translate_test_start", True):
            return False
        log.info("번역 방식/서버 설정이 바뀜 -> 연결을 다시 확인합니다")
        self._translate_test()
        return True

    def _gloss_sig(self):
        return glossary._signature(glossary.resolve(self.cfg.get("glossary_file")))

    def _gloss_check(self):
        """The glossary file was saved: say so in the window (every translator reads it again by itself)."""
        sig = self._gloss_sig()
        if sig == self._gloss_last or self.cfg.get("translator", "none") == "none":
            self._gloss_pending = None
            self._gloss_last = sig if self.cfg.get("translator", "none") == "none" else self._gloss_last
            return
        if self._gloss_pending != sig:                       # wait one more tick: the file may still be being written
            self._gloss_pending = sig
            return
        self._gloss_last, self._gloss_pending = sig, None
        n = len(glossary.entries(self.cfg.get("glossary_file")))
        log.info("단어장 파일이 바뀜: %d개 항목", n)
        self.add_system("ℹ " + tr("단어장을 다시 읽었습니다: {n}개 항목", n=n), "system")

    LOST_AFTER = 5.0           # seconds without a matrix before the hint shows (first start: at once)

    def _lost_tick(self):
        """The game runs but the matrix is not being read: say what to do. Shown at once if no position was ever found (first
        start), else after a few seconds (a loading screen or a reload ends by itself). It is removed again as soon as the
        matrix is read."""
        try:
            shown = bool(self.text.tag_ranges("lostnote"))
            g = self._find_game()
            self._game_rect_cache = self._game_rect(g) if g else None
            if self._connected:
                self._lost_since = None
                if shown:
                    r = self.text.tag_ranges("lostnote")
                    self.text.delete(r[0], r[-1])
            elif not shown:
                if g is None:
                    self._lost_since = None
                else:
                    now = time.monotonic()
                    if self._lost_since is None:
                        self._lost_since = now
                    first = not self.cfg.get("last_pos")
                    if first or now - self._lost_since >= self.LOST_AFTER:
                        msg = "⚠ " + tr("매트릭스를 찾지 못했습니다. 게임에서 애드온이 켜져 있고 매트릭스가 화면에 보이는지 확인하세요. "
                                       "로딩 중이거나 애드온을 리로드한 경우라면 매트릭스가 다시 보일 때 바로 감지하니 그냥 두셔도 됩니다. "
                                       "처음 실행했거나 매트릭스 위치를 옮겼다면, 이 창 위쪽의 ⟳ 새로고침 아이콘을 한 번 눌러 주세요. 바로 다시 찾습니다.")
                        if first:
                            msg += " " + tr("왼쪽 아래가 아니어도 한 번 찾으면 위치를 기억합니다.")
                        self._insert([(msg + "\n", "lostnote")], "system")
        except Exception:
            log.exception("매트릭스 안내 점검 실패")
        finally:
            self.root.after(1000, self._lost_tick)

    def _warm_tick(self):
        """After the prompt or the glossary changed, send the tiny test request once (if the start test is on): the AI
        server keeps what it read of an unchanged prompt, so the first real line after the change is not the slow one."""
        try:
            self._gloss_check()
            key = self._warm_key()
            if self._conn_check():                               # that request also carried the prompt: nothing to warm
                self._warm_last, self._warm_pending = key, (None, 0)
            elif key is None or not self.cfg.get("translate_test_start", True):
                self._warm_last, self._warm_pending = key, (None, 0)
            elif key != self._warm_last:                         # (also: switched from another translator to the AI)
                pk, n = self._warm_pending
                if pk == key:                                    # unchanged for a whole tick: the file is saved completely
                    self._warm_last, self._warm_pending = key, (None, 0)
                    log.info("프롬프트/단어장이 바뀜 -> 번역 서버에 미리 한 번 보내 둡니다")
                    self._translate_test(quiet=True)
                else:
                    self._warm_pending = (key, 0)
            else:
                self._warm_pending = (None, 0)
        except Exception:
            log.exception("미리 보내기 점검 실패")
        finally:
            self.root.after(2000, self._warm_tick)

    def _translate_test(self, quiet=False):
        """Send a tiny request with the current translation method and say in the chat window whether it answered.
        quiet: the warm-up after a prompt / glossary change (a short notice instead of the connection report)."""
        cfg = dict(self.cfg)
        mode = cfg.get("translator")
        if mode == "google":
            who = "Google" + (" (API Key)" if (cfg.get("google_api_key") or "").strip() else "")
        elif mode == "custom":
            who = cfg.get("custom_preset") or cfg.get("custom_url") or "HTTP"
        else:
            who = cfg.get("api_model") or cfg.get("api_url") or "AI"

        def work():
            t0 = time.perf_counter()
            try:
                translator.translate(cfg, "hi")
                ms = int((time.perf_counter() - t0) * 1000)
                if quiet:
                    log.info("미리 보내기 완료: %s (%dms)", who, ms)
                    msg, tag = "ℹ " + tr("바뀐 프롬프트/단어장을 번역 서버에 미리 보내 두었습니다 ({ms}ms)", ms=ms), "system"
                    self.q.put(("call", lambda: self.add_system(msg, tag)))
                    return
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
        if cfg.get("send_show_log", False):
            self._insert("↗ " + res.text + "\n", "trans")
        if res.note:
            self.add_system(res.note)
        self._send_close(refocus=True, paste=bool(cfg.get("send_autopaste")))
        self.root.after(60, self._scroll_to_end_again)

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
        self._scroll(self.text.yview_scroll, -3 if e.delta > 0 else 3, "units")

    def _scroll(self, fn, *args):
        """Scroll the real text AND the shadow in the same moment. Waiting for yscrollcommand is one redraw too late: Tk calls it
        after the real text has been drawn, so the shadow would be drawn one frame behind. Moving both now lets Tk draw
        them in the same idle pass."""
        fn(*args)
        if self._shadow_active():
            self._sync_shadow()

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
            self.root.after(1500, self._refresh_title)
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
        self.link_names.clear()

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

    def _insert(self, s, tag, index="end", group=True, indent=False):
        """`s` is a string, or a list of (text, extra_tag_or_None) pieces drawn in `tag` (+ the extra tag).
        group=True: the line starts a new group (gap above); a translation or an error of a line is part of its group."""
        at_bottom = self._at_bottom()
        base = (tag, "gstart") if group else (tag,)
        start = self.text.index("end-1c" if index == "end" else index)
        if isinstance(s, str):
            self.text.insert(index, s, base)
        else:
            args = []
            for piece, extra in s:
                args += [piece, base + ((extra,) if extra else ())]
            self.text.insert(index, *args)                      # one call: the pieces stay in order at a mark too
        if indent:                                              # the translation line is pushed in by a margin, not by spaces
            self.text.tag_add("ind", start, f"{start}+1c")      # (a space before a long word would let Tk drop the word to the next row)
        n = int(self.text.index("end-1c").split(".")[0])
        keep = int(self.cfg["max_lines"])
        if n > keep:
            self.text.delete("1.0", f"{n - keep}.0")
        if at_bottom:
            self._scroll_to_end()

    def _scroll_to_end(self):
        """Follow the newest line. Tk measures the height of a wrapped line later than it inserts it, so one see("end")
        scrolled only by the first display line of a line that wraps into two or more: measure, scroll, and look again
        a moment later (the window may also have changed size meanwhile, e.g. the send box closing)."""
        try:
            self.text.update_idletasks()
            self.text.see("end")
            self.root.after(30, self._scroll_to_end_again)
        except tk.TclError:
            pass

    def _scroll_to_end_again(self):
        try:
            if self.text.bbox("end-1c") is None:                  # still not on screen
                self.text.update_idletasks()
                self.text.see("end")
        except tk.TclError:
            pass

    # ------------------------------------------------------------------ data flow
    def on_new_line(self, line):
        """A chat line that has not been seen before: show it, and ask for a translation."""
        if chattext.is_command(line.channel):                     # an instruction for the reader, not a message
            self._command(line)
            return
        if self.cfg.get("skip_regex_hide") and line.text != "[restricted]" \
                and translator.matches_skip_regex(chattext.check_text(line.text), self.cfg):
            return                                                # the user's pattern matches: leave the line out
        ts = (time.strftime("%H:%M:%S") + " ") if self.cfg.get("show_time", True) else ""
        restricted = line.text == "[restricted]"
        if restricted:
            self._show_restricted(ts)
            return
        if line.channel == "!RS":                                 # the addon: the chat restriction is over
            self._restr_n = 0
            self._insert(f"{ts}{tr('✓ 채팅 제한이 해제되었습니다')}\n", "restricted")
            return
        self._restr_n = 0                                         # a normal line ends a run of restricted ones
        if line.channel in ("!AD", "!UN", "!CN"):                 # the colour belongs to this line (an addon wrote it; a channel notice has the colour of the channel it is about)
            tag = f"bc{line.base}" if line.base in chattext.QUALITY_COLORS else channel_tag(line.channel)
        else:                                                     # the colour belongs to the chat type: all its lines change together
            tag = self._type_tag(line.channel, line.base)
        sender, body = line.sender, line.text
        if not sender and line.channel.startswith("C") and line.channel != "CM" and line.base not in chattext.QUALITY_COLORS:
            tag = "!SY"                                           # nobody speaks (server announcement in a channel): yellow like system text
        protected = False
        if not restricted:
            body, protected = chattext.hide_protected(body)       # |Kx2|k: text the game does not give to addons
            if protected:                                         # the mark is red, the rest has the colour of the chat type
                body = tr("⚠ 길드관리자 메시지는 보호되어 있어 읽을 수 없습니다. 게임에서 직접 확인하세요.") if line.channel == "O" \
                    else tr("⚠ 보호된 메시지 (게임이 내용을 알려주지 않아 읽을 수 없음)")
            body = chattext.resolve_josa(body)                    # the Korean client leaves  |1이;가;  in event texts
            body = chattext.mark_guilds(body)                     # <Guild Name> in the text: green, and not translated
            if line.channel.startswith("!") and "%s" in body and sender:
                body, sender = body.replace("%s", sender), ""     # NPC emotes: "%s waves." -> the name goes into the text
        if sender:                                                # [name]: message  (the name in the class colour)
            ctag = f"cls_{line.cls}" if (self.cfg.get("class_colors", True) and line.cls in chattext.CLASS_COLORS) else None
            parts = [(f"{ts}{self._code_prefix(line.channel)}[", None), (sender, ctag), ("]: ", None)]
        else:
            parts = [(f"{ts}{self._code_prefix(line.channel)}", None)]
        # The original names of links (addon option) belong to chat lines that get a translation line below them, where the names
        # in the game's language show up. A loot / system line has no such line: it shows the names in the game's language.
        pieces = [(p, f"q{q}" if q in chattext.QUALITY_COLORS else None)
                  for p, q in chattext.segments(body, not line.channel.startswith("!"))]
        if protected:
            pieces = [(body[:1], "protmark"), (body[1:], None)]
        if any(e == "q10" for _, e in pieces) and not line.channel.startswith("!"):
            log.info("노란 링크(10) 표시: %s", [(p[:30], e) for p, e in pieces])
        if line.channel == "!PG" and pieces and pieces[0][0][:1] in PING_COLORS and pieces[0][1] is None:
            first, extra = pieces[0]                              # the ping symbol gets its own colour
            pieces[0:1] = [(first[0], f"pg{ord(first[0])}"), (first[1:], extra)]
        pieces = self._guild(pieces)
        text = chattext.plain(body)                               # item-link markers removed
        translatable = not protected and not (line.channel.startswith("!") and line.channel not in TRANSLATED_CODES) \
            and not chattext.is_unintelligible(body) \
            and translator.should_translate(text, self.cfg, chattext.check_text(body))
        route = translator.route_for(self.cfg, "!NPC" if line.channel in SPEECH_CODES else line.channel)
        if line.channel == "!VC" and not self.cfg.get("voice_translate", True):
            route = translator.ROUTE_OFF
        if route == translator.ROUTE_OFF:                         # option "channel translation": this channel is not translated
            translatable, route = False, None
        if self.cfg.get("swap_trans") and translatable:
            self._show_swapped(parts, pieces, tag, body, route)
            return
        both = (not translatable and not protected and not line.channel.startswith("!") and chattext.has_original(body))
        if both and self.cfg.get("swap_trans"):                  # "translation above": the names in the game's language on top, the original below
            local = self._guild([(p, f"q{q}" if q in chattext.QUALITY_COLORS else None) for p, q in chattext.segments(body, False)])
            self._insert(parts + local + [("\n", None)], tag)
            self._insert(self._guild([(chattext.plain(body, True) + "\n", None)]), "trans", group=False, indent=True)
            return
        parts += pieces
        parts.append(("\n", None))
        self._insert(parts, tag)

        if not translatable:
            if both:
                # nothing to translate (e.g. just an item link): the line below still gives the names in the game's language
                self._insert(self._guild([(chattext.plain(body), None)]) + [("\n", None)], "trans", group=False, indent=True)
            return                                                # loot, money, experience, system ... or nothing to translate
        text, names = chattext.mask_links(body)                   # links become [L1] [L2] for the translator
        token = next(self.tokens)
        if names:
            self.link_names[token] = names
        mark = f"tr{token}"
        self.text.mark_set(mark, "end-1c")
        self.text.mark_gravity(mark, "left")          # later lines are inserted after the mark
        self.marks[token] = mark
        if not self.translations.submit(token, text, route):
            self.link_names.pop(token, None)
            self._drop_mark(token)
            self.status.set(tr("번역 대기열이 가득 차서 일부 줄을 번역하지 못했습니다"))

    # ---- "translation above, original below": the top line is reserved with a "…" and filled when the translation arrives
    def _mark_here(self, name):
        self.text.mark_set(name, "end-1c")
        self.text.mark_gravity(name, "left")                      # text inserted at the mark goes after it

    def _show_swapped(self, head, pieces, tag, body, route=None):
        masked, names = chattext.mask_links(body)
        token = next(self.tokens)
        self._insert(head, tag)                                   # the name part of the top line ...
        self._mark_here(f"trb{token}")                            # ... then the translation goes here, instead of the "…"
        self._insert([("…", None), ("\n", None)], tag)
        self._mark_here(f"trl{token}")                            # start of the lower line (the original)
        self._insert(self._guild([(chattext.plain(body, True) + "\n", None)]), "trans", group=False, indent=True)
        mark = f"tr{token}"
        self._mark_here(mark)                                     # end of the group: errors are inserted here
        self.marks[token] = mark
        self.swapinfo[token] = {"tag": tag, "head": head, "orig": pieces,
                                "names": names, "quals": chattext.link_qualities(body)}
        if names:
            self.link_names[token] = names
        if not self.translations.submit(token, masked, route):
            self.link_names.pop(token, None)
            self._swap_fallback(token)
            self.swapinfo.pop(token, None)
            self._drop_mark(token)
            self.status.set(tr("번역 대기열이 가득 차서 일부 줄을 번역하지 못했습니다"))

    @staticmethod
    def _guild(pieces):
        """The parts of a line without a colour of their own: a <Guild Name> in them gets the guild colour."""
        out = []
        for p, extra in pieces:
            if extra is None and "<" in p:
                out += [(s, "guild" if g else None) for s, g in chattext.split_guild(p)]
            else:
                out.append((p, extra))
        return out

    def _swap_fill(self, token, result):
        """The translation arrived: it replaces the "…" of the top line. False if that line is gone."""
        info = self.swapinfo[token]
        trb = f"trb{token}"
        if self.text.get(trb, f"{trb}+1c") != "…":
            return False
        seq = (chattext.split_translation(result, info["names"], info["quals"]) if info["names"]
               else chattext.color_brackets(result, info["quals"]))          # no placeholders: a line of links only
        pieces = self._guild([(p, f"q{q}" if q in chattext.QUALITY_COLORS else None) for p, q in seq])
        self.text.delete(trb, f"{trb}+1c")
        self._insert(pieces, info["tag"], index=trb, group=False)
        return True

    def _swap_fallback(self, token):
        """No translation: the top line shows the original after all, and the lower copy goes away."""
        info = self.swapinfo.get(token)
        if not info:
            return
        trb, trl = f"trb{token}", f"trl{token}"
        try:
            if self.text.get(trb, f"{trb}+1c") == "…":
                self.text.delete(trb, f"{trb}+1c")
                self._insert(info["orig"], info["tag"], index=trb, group=False)
                if "ind" in self.text.tag_names(trl):     # the original is shown above now: drop the lower copy
                    self.text.delete(trl, f"{trl} lineend+1c")
        except tk.TclError:
            pass

    _restr_n = 0

    def type_color(self, code):
        """The colour lines of this channel code have now: the one the game sent (kept until the program ends), else the game's default."""
        code = "!MS" if code == "!NPC" else code               # NPC / boss speech: one colour row for all of it
        return self._type_colors.get(code) or TAG_COLORS.get(channel_tag(code), TAG_COLORS["other"])

    def _type_tag(self, code, base):
        """The text tag of a chat type (the line's channel code): every line of the type carries it, so a change of the
        type's colour in the game (the base colour that comes with a line) recolours the earlier lines of that type too,
        like the game does. `base` = palette code of the colour the user chose, -1 = the game's default colour."""
        name = "t_" + code
        default = TAG_COLORS.get(channel_tag(code), TAG_COLORS["other"])
        color = chattext.QUALITY_COLORS.get(base, default) if base >= 0 else default
        if self._type_colors.get(code) != color:
            first = code not in self._type_colors
            self._type_colors[code] = color
            self.text.tag_configure(name, foreground=color)
            if first:
                try:
                    self.text.tag_lower(name, "q0")               # below the link / class colours, above the old channel tags
                except tk.TclError:
                    pass
        return name

    # instructions from the addon ("@" lines, see PROTOCOL.md "Command lines"): code -> handler(self, line); none exist yet
    COMMANDS = {}
    _unknown_commands = set()

    def _command(self, line):
        handler = self.COMMANDS.get(line.channel[1:])
        if handler:
            try:
                handler(self, line)
            except Exception:
                log.exception("명령 처리 오류: %s", line.channel)
        elif line.channel not in self._unknown_commands:
            self._unknown_commands.add(line.channel)
            log.info("알 수 없는 명령 줄을 무시합니다: %s (새 버전의 애드온일 수 있음)", line.channel)

    def _code_prefix(self, ch):
        """What stands in front of a line: nothing, like the game's chat, except "(1)" for numbered channels and an arrow
        for a whisper you sent. The option "show channel codes in detail" brings back  (S) (W→) (C1) (!LT)."""
        if ch == "!VC":
            return tr("(음성)") + " "
        if self.cfg.get("channel_detail", False):
            return f"({SHOWN_CODE.get(ch, ch)}) "
        if ch in ("WT", "BT"):
            return "→ "
        if ch.startswith("C") and ch[1:].isdigit():
            return f"({ch[1:]}) "
        return ""

    def _show_restricted(self, ts):
        """The client did not let the addon read these messages (during some fights). A run of them is ONE notice with
        a counter, instead of a line "[?]: [restricted]" for every message."""
        self._restr_n += 1
        text = tr("⚠ 채팅이 제한되어 읽을 수 없음") if self._restr_n == 1 else \
            tr("⚠ 채팅이 제한되어 읽을 수 없음 ({n}줄)", n=self._restr_n)
        line = f"{ts}{text}\n"
        try:
            if self._restr_n > 1 and "restr" in self.text.mark_names() and "restricted" in self.text.tag_names("restr"):
                self.text.delete("restr", "restr lineend+1c")      # replace the notice of this run
                self._insert(line, "restricted", index="restr")
            else:
                self.text.mark_set("restr", "end-1c")
                self.text.mark_gravity("restr", "left")
                self._insert(line, "restricted")
        except tk.TclError:
            pass

    def _drop_mark(self, token):
        mark = self.marks.pop(token, None)
        for m in ((mark,) if mark else ()) + (f"trb{token}", f"trl{token}"):
            try:
                self.text.mark_unset(m)
            except tk.TclError:
                pass

    def on_translation(self, token, result, err):
        names = self.link_names.pop(token, None)
        mark = self.marks.get(token)
        if mark is None:
            return
        if result and not err and names:                         # a link the translator dropped is added at the end
            result, lost = chattext.ensure_links(result, names)
            if lost:
                log.warning("번역에서 링크 자리표시자가 빠짐: %s -> 끝에 붙임", ", ".join("[L%d]" % i for i in lost))
        if token in self.swapinfo:                               # "translation above" mode
            filled = False
            if result and not err:
                try:
                    filled = self._swap_fill(token, result)
                except Exception:
                    log.exception("번역을 위 줄에 넣지 못함")
            if filled:
                self.last_error = None
                self.swapinfo.pop(token, None)
                self._drop_mark(token)
                return
            self._swap_fallback(token)                           # failed: the original in the top line, then the usual way
            self.swapinfo.pop(token, None)
        if result and names:
            result = chattext.unmask_links(result, names)
        try:
            if err:
                self.status.set(tr("번역 오류: {err}", err=err))
                if err != self.last_error:                  # don't flood the window with the same error
                    self.last_error = err
                    self._insert("⚠ " + tr("번역 오류: {err}", err=err) + "\n", "error", index=mark, group=False, indent=True)
            elif result:
                self.last_error = None
                self._insert(self._guild([(result, None)]) + [("\n", None)], "trans", index=mark, group=False, indent=True)
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

    _poll_errors = 0

    def poll(self):
        """Takes what the background threads queued (status, lines, translations ...). One item that raises must never
        stop this loop: before, a single error here ended it for good - the window kept saying "connected" while no
        line was shown any more, until the program was restarted."""
        try:
            while True:
                try:
                    kind, payload = self.q.get_nowait()
                except queue.Empty:
                    break
                try:
                    if kind == "status":
                        self._cap_status = payload
                        self.status.set(payload)
                        self._log_status(payload)
                    elif kind == "pos":
                        if self.cfg.get("last_pos") != list(payload):
                            self.cfg["last_pos"] = list(payload)
                            config.save(self.cfg)
                    elif kind == "lines":
                        for piece in payload:
                            for line in self.joiner.feed(piece, time.monotonic()):
                                self._show_line(line)
                    elif kind == "voice":
                        self.on_voice(payload)
                    elif kind == "trans":
                        self.on_translation(*payload)
                    elif kind == "call":
                        payload()
                    elif kind == "options":
                        self.open_options()
                    elif kind == "quit":
                        self.on_close()
                except Exception:
                    self._poll_failed(str(kind), "")
            for line in self.joiner.flush_due(time.monotonic()):     # a long message whose last piece never came
                self._show_line(line)
        finally:
            self.root.after(50, self.poll)

    # ---- voice recognition (the extension process, see voice.py)
    def _clear_partial(self):
        if self._part_job is not None:
            try:
                self.root.after_cancel(self._part_job)
            except Exception:
                pass
            self._part_job = None
            self.status.set(self._cap_status)

    def on_voice(self, m):
        """Messages of the voice process. What goes on is shown by the indicator (voicemeter.py) and written to the log: the window
        itself only gets the spoken lines and a real error (something the user has to act on)."""
        kind = m.get("type")
        self.vmodel.on_event(m, time.monotonic())
        if kind == "text":
            self._clear_partial()
            text = (m.get("text") or "").strip()
            if text:
                self._show_line(Line("!VC", 0, "", text))
        elif kind == "partial":                                   # live mode: what is being said right now, in the title line
            text = (m.get("text") or "").strip()
            if text:
                self.status.set(tr("음성: {text}", text=text[-70:]))
                if self._part_job is not None:
                    self.root.after_cancel(self._part_job)
                self._part_job = self.root.after(4000, self._clear_partial)
        elif kind == "status":
            st, msg = m.get("state"), m.get("msg", "")
            log.info("음성 인식 상태: %s %s", st, msg)
            if st == "error":
                if msg == "not installed":
                    msg = tr("음성 인식 확장이 설치되어 있지 않습니다 (extensions/stt/README.md 참고)")
                self.add_system("⚠ " + tr("음성 인식 오류: {msg}", msg=voice.explain_error(msg)))
        elif kind == "warn":
            log.info("음성 인식 경고: %s", m.get("msg", ""))
        elif kind == "exit":
            self._clear_partial()
            self.add_system("⚠ " + tr("음성 인식이 종료되었습니다 (코드 {code}). 자세한 내용: {path}", code=m.get("code"), path=voice.LOG))

    # ---- the on / off button of the voice recognition (title bar). It switches only for now: the option "use voice recognition"
    #      (start with the program) is not touched.
    def _voice_toggle(self):
        if self.voice.running() or self.vmodel.state in ("loading", "idle", "active"):
            self.voice.stop(wait=1.0)
        else:
            self.voice.start()
        self._voice_button_color()
        self._voice_button_hint(True)

    def _voice_button_color(self):
        self.btn_voice.configure(fg="#4cc38a" if self.vmodel.state != "off" else DIM)

    def _voice_button_hint(self, on):
        """The title line says what a click does (the title bar has no tooltips of its own)."""
        if on:
            self.status.set(tr("음성 인식 끄기") if self.vmodel.state != "off" else tr("음성 인식 켜기"))
        else:
            self.status.set(self._cap_status)

    # ---- the indicator in the top right corner
    def _place_vmeter(self):
        """4 px from the right and top edge; while the frame (title bar, scrollbar) is shown it moves below the title bar and left
        of the scrollbar so that it covers neither."""
        m = getattr(self, "vmeter", None)
        if m is None:
            return
        on = self.vmodel.state != "off"
        key = (on, self.chrome_on)
        if key == self._vmeter_key:
            return
        self._vmeter_key = key
        if not on:
            m.place_forget()
            return
        m.place(relx=1.0, x=-(4 + (SB_W if self.chrome_on else 0)), y=4 + (TITLE_H if self.chrome_on else 0), anchor="ne")
        m.lift()

    def _vmeter_tick(self):
        try:
            state, bars, _code, _vals = self.vmodel.tick(time.monotonic())
            self._vphase += 1
            self._place_vmeter()
            if state != "off":
                self.vmeter.render(state, bars, self._vphase)
            if self.chrome_on:
                self._voice_button_color()
        except Exception:
            log.exception("음성 표시기 오류")
        finally:
            self.root.after(150, self._vmeter_tick)

    def _voice_tip(self):
        state, _bars, code, v = self.vmodel.snapshot(time.monotonic())
        name = voice.target_name(self.cfg)
        if state == "loading":
            return tr("음성 인식: 준비 중입니다 (모델을 불러오는 중)")
        if state == "active":
            return tr("음성 인식: {name} 소리를 듣는 중", name=name)
        if state == "idle":
            if v.get("ago") is None:
                return tr("음성 인식: {name}에 연결됨 - 지금은 소리가 없습니다", name=name)
            return tr("음성 인식: {name}에 연결됨 - 지금은 소리가 없습니다 (마지막 소리 {sec}초 전)", name=name, sec=v["ago"])
        if state == "error":
            if code == "not_installed":
                return tr("음성 인식 확장이 설치되어 있지 않습니다 (extensions/stt/README.md 참고)")
            if code == "exit":
                text = tr("음성 인식이 종료되었습니다 (코드 {code}). 자세한 내용: {path}", code=v.get("code"), path=voice.LOG)
            elif code == "stale":
                text = tr("음성 인식 프로그램이 응답하지 않습니다.")
            else:
                text = tr("음성 인식 오류: {msg}", msg=voice.explain_error(v.get("msg", "")))
            return text + "\n" + tr("클릭하면 다시 시작합니다.")
        return ""

    def _voice_clicked(self):
        state, _bars, code, _v = self.vmodel.snapshot(time.monotonic())
        if state == "error" and code != "not_installed":
            self.voice.restart()
        else:
            self.open_options(select_voice=True)

    def _show_line(self, line):
        try:
            self.on_new_line(line)
        except Exception:
            self._poll_failed("줄 표시", repr(getattr(line, "text", ""))[:80])

    def _poll_failed(self, what, detail):
        self._poll_errors += 1
        if self._poll_errors <= 20 or self._poll_errors % 100 == 0:      # a repeating error must not flood the log
            log.exception("화면 갱신 중 오류 (%s, 누적 %d회) %s", what, self._poll_errors, detail)

    # ------------------------------------------------------------------ window settings
    def _font_family(self):
        fam = self.cfg.get("font_family") or ""
        return fam if fam and fam in self.custom_fonts else fonts.DEFAULT_FAMILY

    def apply_window_settings(self):
        self.font.configure(family=self._font_family(), size=int(self.cfg["font_size"]))
        self.font_trans.configure(family=self._font_family(), size=self._trans_size())
        self.text.configure(**self._spacing())
        self._configure_layout_tags(self.text)
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
        gap = max(0, min(40, int(self.cfg.get("line_spacing", 0))))
        return dict(spacing1=gap // 2, spacing3=gap - gap // 2, spacing2=gap // 2)   # between lines / wrapped rows

    def _trans_size(self):
        """Font size of the translation: its own option, or the same as the original (0 / empty)."""
        try:
            n = int(self.cfg.get("trans_font_size") or 0)
        except (TypeError, ValueError):
            n = 0
        return n if 8 <= n <= 32 else int(self.cfg["font_size"])

    def _trans_color(self):
        c = (self.cfg.get("trans_color") or "").strip()
        return c if re.fullmatch(r"#[0-9a-fA-F]{6}", c) else TAG_COLORS["trans"]

    def _configure_layout_tags(self, widget, colors=True):
        """Tags that change the layout: "trans" (translation: size, and colour in the real window) and "gstart" (the first
        line of a group = an original line with its translation: extra space above, the group gap)."""
        gap = max(0, min(40, int(self.cfg.get("line_spacing", 0))))
        group = max(0, min(60, int(self.cfg.get("group_spacing", 4))))
        widget.tag_configure("gstart", spacing1=gap // 2 + group)
        widget.tag_configure("ind", lmargin1=self.font_trans.measure("    "))      # the width the four spaces had
        if colors:
            widget.tag_configure("trans", foreground=self._trans_color(), font=self.font_trans)
        else:
            widget.tag_configure("trans", font=self.font_trans)

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
        self._configure_layout_tags(self.stext, colors=False)
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
        self._configure_layout_tags(self.stext, colors=False)
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
            segs, active = [], set()                          # the text with the layout tags (translation size, group gap)
            for key, val, _idx in self.text.dump("1.0", "end-1c", text=True, tag=True):
                if key == "tagon" and val in ("trans", "gstart", "ind"):
                    active.add(val)
                elif key == "tagoff":
                    active.discard(val)
                elif key == "text":
                    segs.append((val, ("all",) + tuple(sorted(active))))
            if segs != self._shadow_last:
                self.stext.delete("1.0", "end")
                for val, tags in segs:
                    self.stext.insert("end", val, tags)
                self._shadow_last = segs
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
        self._set_passthrough(bool(on) and not self._suspend_ct)

    def open_options(self, select_voice=False):
        dump = getattr(self, "_state_dump", None)
        if dump:                                   # if the window had vanished, this shows why (before saving repairs it)
            try:
                log.info("옵션 열림 | 창 상태: %s", dump())
            except Exception:
                log.exception("창 상태 기록 실패")
        if self.opt is not None and self.opt.alive():
            self.opt.lift()
        else:
            self.opt = OptionsWindow(self)
        if select_voice:
            self.opt.select_voice()

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
            self.voice.stop(wait=1.5)
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

    def run(self, migrated=()):
        if migrated:                       # version 1.6.0: old program files were moved out of the main folder (see migrate.py)
            self.root.after(1200, lambda: self.add_system(
                "ℹ " + tr("프로그램 파일이 app 폴더로 정리되었습니다. 이전 버전 파일 {n}개를 {folder} 폴더로 옮겼습니다.", n=len(migrated), folder=migrate.BACKUP)
                + "\n" + tr("번역창이 문제없이 실행된다면 {folder} 폴더는 삭제해도 됩니다.", folder=migrate.BACKUP)))
        self.root.mainloop()








def main():
    try:
        i18n.init(config.load().get("language", i18n.AUTO))
    except Exception:
        pass
    if not _single_instance():
        _msgbox(tr("ChatMatrix Reader가 이미 실행 중입니다."), 0x40)
        return
    moved = migrate.run()  # version 1.6.0: old program files in the main folder go to old_version_backup (and the window says so)
    try:
        App().run(moved)
    except Exception:
        log.exception("치명적 오류")
        last = traceback.format_exc().strip().splitlines()[-1]
        _msgbox(tr("오류가 발생해서 종료합니다.\n\n{last}\n\n자세한 내용: {path}", last=last, path=logsetup.PATH))
        logging.shutdown()
        os._exit(1)


if __name__ == "__main__":
    main()
