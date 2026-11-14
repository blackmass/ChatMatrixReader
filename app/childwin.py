"""Extra (child) translation windows: the first prototype.

The main window stays as it is. Each child window is built like it (see app.py _build_main / apply_opacity): no system frame, a
title bar with a close button (and the voice button in window 2), scrollbar and resize grip that show while the mouse is over
the window, and the two-layer look (a text window with the background colour keyed out over a background window with its own
opacity). It shows the lines of the channels ticked for it, with their translation. The settings of all child windows are a list in
config["child_windows"]; window 2 (voice recognition) always exists and cannot be deleted, it is only switched on or off.

Not here yet (the main window only): click-through, shadow, tooltips, fade-out, the send box, "translation above", hiding from the taskbar.
"""
import re
import sys

SPEECH_CODES = ("!MS", "!MY", "!ME", "!MW", "!MP", "!BE", "!BW")
ETC = "!ETC"                                   # everything that has no row of its own (loot, system, other codes ...)
KNOWN = ("S", "Y", "E", "P", "PL", "R", "RL", "RW", "I", "IL", "G", "O", "W", "B", "WT", "BT", "CM",
         *[f"C{n}" for n in range(1, 11)], "!NPC", "!VC")
UI = {}                                        # colours / sizes / the scrollbar class, filled in by app.py (they live there)
VOICE_ID = 2                                   # the window that cannot be deleted
MODES = ("always", "voice", "never")         # when the window is open: always | only while the voice recognition runs (window 2) | never (opened by hand)
KEYS = {"id": 0, "name": "", "open_mode": "never", "channels": [], "geometry": "", "font_family": "", "font_size": 0,
        "bg_opacity": 1.0, "text_opacity": 1.0, "topmost": True, "topmost_wow_only": False, "click_through": False, "hover_clear": False}


def chan_key(code: str) -> str:
    """The row of the channel lists a line belongs to."""
    if code in SPEECH_CODES:
        return "!NPC"
    return code if code in KNOWN else ETC


def new_conf(wid: int, channels=()):
    d = dict(KEYS)
    d.update(id=int(wid), channels=list(channels))
    return d


def normalize(items):
    """The saved list -> a clean list: dicts with every key, unique ids, window 2 present (first)."""
    out, seen = [], set()
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        try:
            wid = int(it.get("id"))
        except (TypeError, ValueError):
            continue
        if wid < 2 or wid in seen:
            continue
        seen.add(wid)
        d = new_conf(wid)
        d.update({k: it[k] for k in KEYS if k in it and k != "id"})
        if "open_mode" not in it and it.get("enabled"):          # (the first prototype had a "use" check box)
            d["open_mode"] = "always"
        if d["open_mode"] not in MODES or (d["open_mode"] == "voice" and wid != VOICE_ID):
            d["open_mode"] = "never"
        d["channels"] = [c for c in d["channels"] if isinstance(c, str)] if isinstance(d["channels"], list) else []
        if "opacity" in it and "bg_opacity" not in it and "text_opacity" not in it:      # (the first prototype had one opacity)
            d["bg_opacity"] = d["text_opacity"] = it["opacity"]
        try:
            d["bg_opacity"] = min(1.0, max(0.03, float(d["bg_opacity"])))
            d["text_opacity"] = min(1.0, max(0.2, float(d["text_opacity"])))
            d["font_size"] = int(d["font_size"])
        except (TypeError, ValueError):
            d["bg_opacity"] = d["text_opacity"] = 1.0
            d["font_size"] = 0
        for k in ("topmost", "topmost_wow_only", "click_through", "hover_clear"):
            d[k] = bool(d[k])
        if d["topmost_wow_only"]:
            d["topmost"] = False                                 # the two modes exclude each other (like the main window's options)
        d["name"] = d["name"] if isinstance(d["name"], str) else ""
        out.append(d)
    if VOICE_ID not in seen:
        out.append(new_conf(VOICE_ID, ["!VC"]))
    out.sort(key=lambda d: d["id"])
    return out


def next_id(items) -> int:
    return max([VOICE_ID] + [d["id"] for d in items]) + 1


def accepts(conf, code: str) -> bool:
    return chan_key(code) in set(conf.get("channels") or ())


def parent_shows(cfg, code: str) -> bool:
    """The main window: every channel unless unticked (a new kind of line is on by default)."""
    return chan_key(code) not in set(cfg.get("win1_off") or ())


def valid_geometry(g) -> bool:
    return bool(re.fullmatch(r"\d+x\d+([+-]-?\d+[+-]-?\d+)?", g or ""))


class ChildWindow:
    """One child window: built like the main window (frameless text window over a background window), fed by the App."""

    MIN_W, MIN_H = 200, 100

    def __init__(self, app, conf):
        import tkinter as tk
        import tkinter.font as tkfont
        import plat
        U = UI
        self.tk, self.app, self.conf, self.plat, self.U = tk, app, conf, plat, U
        self.marks = {}
        self._geo_job = None
        self._tick_job = None
        self._dead = False
        self.two_window = False
        self.chrome_on = False
        self.dragging = False
        self._n = 0
        self._interactive = False
        self._hover_cleared = False
        wid = conf["id"]
        # the text window (front) and the background window (back), like the main window's root / back
        self.root = tk.Toplevel(app.root)
        self.root.title(f"ChatMatrix Reader ({wid})")
        plat.borderless(self.root, keyboard=True)
        plat.setup_front(self.root)
        self.root.geometry(conf["geometry"] if valid_geometry(conf.get("geometry")) else "420x260")
        self.back = tk.Toplevel(app.root)
        self.back.title(f"ChatMatrix Reader ({wid}, background)")
        plat.borderless(self.back, keyboard=True)
        self.back.configure(bg=U["BG_SOLID"])
        self.back.withdraw()
        self.back.update_idletasks()
        plat._set_exstyle(self.back, add=plat.WS_EX_NOACTIVATE | plat.WS_EX_TOOLWINDOW)
        self.font = tkfont.Font(family=app._font_family(), size=int(app.cfg["font_size"]))
        self.font_trans = tkfont.Font(family=app._font_family(), size=int(app.cfg["font_size"]))
        if getattr(app, "_owner", 1) is None:                    # the invisible owner window of the main window: owned windows have no taskbar button
            app._owner = app._make_owner()
        self._build()
        self.apply()
        self.root.after(150, self._fix_taskbar)

    # ---- building (see App._build_main)
    def _build(self):
        tk, U, app = self.tk, self.U, self.app
        BG, SB_W = U["BG"], U["SB_W"]
        self.body = tk.Frame(self.root, bg=BG, highlightthickness=1, highlightbackground=BG, highlightcolor=BG)
        self.body.pack(fill="both", expand=True)
        self.text = tk.Text(self.body, wrap="word", bg=BG, fg="#e6e6e6", relief="flat", font=self.font, bd=0, highlightthickness=0,
                            padx=8, pady=6, selectbackground="#3a5a8c", inactiveselectbackground="#3a5a8c",
                            insertwidth=0, cursor="xterm", spacing1=2, spacing3=2)
        self.text.pack(fill="both", expand=True, padx=(0, SB_W + 2))
        # title bar (only while hovering): name on the left, close on the right; the voice window also has the speaker
        self.title = tk.Frame(self.body, bg=U["TITLE_BG"], height=U["TITLE_H"])
        self.title.pack_propagate(False)
        btn_font = ("Segoe UI Symbol", 10)
        self.btn_close = tk.Label(self.title, text="✕", bg=U["TITLE_BG"], fg=U["DIM"], font=btn_font, width=3, cursor="hand2")
        self.btn_close.pack(side="right", fill="y")
        self.btn_close.bind("<Enter>", lambda e: self.btn_close.configure(fg="#e5484d"))
        self.btn_close.bind("<Leave>", lambda e: self.btn_close.configure(fg=U["DIM"]))
        self.btn_close.bind("<Button-1>", lambda e: self.on_close())
        self.btn_voice = None
        if self.conf["id"] == VOICE_ID:
            self.btn_voice = tk.Label(self.title, text="🔊", bg=U["TITLE_BG"], fg=U["DIM"], font=btn_font, width=3, cursor="hand2")
            self.btn_voice.pack(side="right", fill="y")
            self.btn_voice.bind("<Button-1>", lambda e: app._voice_toggle())
            self.btn_voice.bind("<Enter>", lambda e: self.btn_voice.configure(fg="#6bb38a"))
            self.btn_voice.bind("<Leave>", lambda e: self._voice_color())
        self.lbl_title = tk.Label(self.title, text="", bg=U["TITLE_BG"], fg="#cfd2d8", font=("Malgun Gothic", 9, "bold"), padx=8)
        self.lbl_title.pack(side="left", fill="y")
        for w in (self.title, self.lbl_title):
            w.configure(cursor="fleur")
            w.bind("<ButtonPress-1>", self._drag_start)
            w.bind("<B1-Motion>", self._drag_move)
            w.bind("<ButtonRelease-1>", self._drag_end)
        # scrollbar and resize grip
        self.sb = U["Scrollbar"](self.body, lambda *a: self.text.yview(*a))
        self.text.configure(yscrollcommand=self.sb.set)
        self.sb.bind("<MouseWheel>", self._wheel)
        self.grip = tk.Label(self.body, text="◢", bg=BG, fg="#5a5f69", font=("Segoe UI Symbol", 9), cursor=self.plat.RESIZE_CURSOR)
        self.grip.bind("<ButtonPress-1>", self._resize_start)
        self.grip.bind("<B1-Motion>", self._resize_move)
        self.grip.bind("<ButtonRelease-1>", self._resize_end)
        # read only but selectable / copyable
        nav = {"Up", "Down", "Left", "Right", "Prior", "Next", "Home", "End"}

        def on_key(e):
            if (e.state & 0x4 and e.keysym.lower() == "c") or e.keysym in nav:
                return None
            return "break"
        self.text.bind("<Key>", on_key)
        self.text.bind("<Button-1>", lambda e: self.text.focus_set())
        self.text.bind("<MouseWheel>", self._wheel)
        self.back.bind("<MouseWheel>", self._wheel)
        for seq in self.plat.RIGHT_CLICKS:                       # the main window's menu (options, open / close the windows)
            self.root.bind(seq, app._context_menu)
            self.back.bind(seq, app._context_menu)
        self.root.bind("<Configure>", self._on_configure)
        self._tick_job = self.root.after(50, self._tick)

    def _voice_color(self):
        if self.btn_voice is not None:
            on = getattr(self.app, "vmodel", None) is not None and self.app.vmodel.state != "off"
            self.btn_voice.configure(fg="#4cc38a" if on else self.U["DIM"])

    def title_text(self):
        from i18n import tr
        c = self.conf
        return c.get("name") or (tr("음성 인식") if c["id"] == VOICE_ID else tr("창 {n}", n=c["id"]))

    # ---- settings (also called again after the options are saved)
    def apply(self):
        app, c, plat = self.app, self.conf, self.plat
        size = c.get("font_size") or int(app.cfg["font_size"])
        fam = c.get("font_family")
        fam = fam if fam and fam in app.custom_fonts else app._font_family()
        self.font.configure(family=fam, size=size)
        self.font_trans.configure(family=fam, size=size)
        self.text.configure(**app._spacing())
        self.text.tag_configure("gstart", spacing1=app._spacing()["spacing1"] + max(0, min(60, int(app.cfg.get("group_spacing", 4)))))
        self.text.tag_configure("ind", lmargin1=self.font_trans.measure("    "))
        self.text.tag_configure("trans", foreground=app._trans_color(), font=self.font_trans)
        self.lbl_title.configure(text=self.title_text())
        top = bool(c.get("topmost", True)) and not c.get("topmost_wow_only")
        self.root.attributes("-topmost", top)
        self.back.attributes("-topmost", top)
        self._hover_cleared = False                              # (re)applying brings the window back; the next tick clears it again
        self.apply_opacity()
        self._interactive = False
        self._set_passthrough(bool(c.get("click_through")))

    def apply_opacity(self):
        """Background and text opacity apart, like App.apply_opacity: two windows when they differ."""
        plat, c, U = self.plat, self.conf, self.U
        bg = max(0.03, min(1.0, float(c.get("bg_opacity", 1.0))))
        tx = max(0.2, min(1.0, float(c.get("text_opacity", 1.0))))
        self.two_window = plat.FORCE_TWO_WINDOW or abs(bg - tx) >= 0.005
        if not self.two_window:
            plat.set_keycolor(self.root, "")
            self.root.attributes("-alpha", tx)
            self.back.withdraw()
            return
        self.back.attributes("-alpha", bg)
        plat.set_keycolor(self.root, U["BG"])                    # background pixels of the text window disappear
        self.root.attributes("-alpha", tx)
        self.root.update_idletasks()
        self._sync_back()
        self.app._hide_from_taskbar(self.back)
        self.back.deiconify()
        self.app._hide_from_taskbar(self.back)
        self._stack()

    def _fix_taskbar(self):
        """Both windows stay out of the taskbar and Alt+Tab (see App._fix_taskbar): owned by the invisible window, tool window style;
        the taskbar only reads that again when a window is shown again."""
        if self._dead:
            return
        app = self.app
        for win in (self.root, self.back):
            try:
                shown = bool(win.winfo_ismapped()) and self.plat.RESHOW_FOR_TASKBAR
                if shown:
                    win.withdraw()
                app._hide_from_taskbar(win)
                if shown:
                    win.deiconify()
                    app._hide_from_taskbar(win)
            except Exception:
                pass
        self._stack()

    def _sync_back(self):
        if self.two_window:
            r = self.root
            self.back.geometry(f"{r.winfo_width()}x{r.winfo_height()}+{r.winfo_x()}+{r.winfo_y()}")

    def _below_hwnds(self):
        return [h for h in ([self.plat._hwnd(self.back)] if self.two_window else []) if h is not None]

    def _stack(self):
        """The background window directly below the text window (the system code of the main window does it)."""
        try:
            type(self.app)._stack_back(self)
        except Exception:
            pass

    # ---- window order (Windows): the same rules as the main window (plat/win.py _follow_game, _place_above_game, _watchdog)
    def _keep_order(self):
        """always on top: topmost, raised again when the game has covered it | only above the game: topmost while the game has the
        focus, else just above the game window (not over other programs) | neither: an ordinary window. Changes something only when
        the order is wrong."""
        if sys.platform != "win32":
            return
        import ctypes
        import os
        from ctypes import wintypes
        c, app = self.conf, self.app
        u = getattr(self, "_u", None)
        if u is None:
            u = self._u = ctypes.WinDLL("user32")              # (own function objects: the main window's code sets other argument types)
            u.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
            u.GetWindow.restype = wintypes.HWND
            u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
            u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
            u.GetForegroundWindow.restype = wintypes.HWND
            u.IsIconic.argtypes = [wintypes.HWND]
        me, back = self.plat._hwnd(self.root), self.plat._hwnd(self.back)
        if not me:
            return
        flags = 0x1 | 0x2 | 0x10                                 # NOSIZE | NOMOVE | NOACTIVATE
        is_top = lambda h: bool(u.GetWindowLongW(h, -20) & 0x8)   # WS_EX_TOPMOST
        def put(ia):                                             # the background window first, then the text window above it:
            if self.two_window and back:                         # at no moment is the text there without its background
                u.SetWindowPos(back, wintypes.HWND(ia), 0, 0, 0, 0, flags)
            u.SetWindowPos(me, wintypes.HWND(ia), 0, 0, 0, 0, flags)
        g = getattr(app, "_game_hwnd", None)                     # found by the main window's loop

        def below(a, b):                                         # is b somewhere below a?
            p, n = a, 0
            while p and p != b and n < 500:
                p, n = u.GetWindow(p, 2), n + 1                  # GW_HWNDNEXT
            return p == b

        if c.get("topmost_wow_only"):
            fg = u.GetForegroundWindow()
            if not g or u.IsIconic(g):
                if is_top(me):
                    put(-2)
                    self._stack()
                return
            if fg and app._pid_of(fg) == os.getpid():
                return                                           # one of our windows has the focus: leave everything as it is
            if fg == g:
                if not is_top(me):
                    put(-1)
                    self._stack()
                    self._log_fix("게임에 포커스: 맨 위로")
                return
            if not is_top(me) and below(me, g):                  # another program has the focus: above the game and not over that
                return                                           # program is enough (the main window's windows may lie in between:
                                                             # demanding "directly above" made the two sets of windows fight)
            p = u.GetWindow(g, 3)
            while p and p in (me, back):
                p = u.GetWindow(p, 3)
            ia = (p if p else -1) if is_top(g) else (p if (p and not is_top(p)) else -2)
            put(ia)
            self._stack()
            self._log_fix("게임 바로 위로 다시 배치")
        elif c.get("topmost", True):
            if not is_top(me) or (g and not below(me, g)):
                put(-1)                                          # the game raised itself over us: top again
                self._stack()
                self._log_fix("맨 위로 다시 올림")
        elif is_top(me):
            put(-2)
            self._stack()

    def _log_fix(self, why):
        import logging
        import time
        now = time.monotonic()
        if now - getattr(self, "_fix_logged", -99) > 20:
            self._fix_logged = now
            logging.getLogger("cmr.app").info("추가 창 %s 순서 복구: %s", self.conf["id"], why)

    # ---- click-through and "transparent while the mouse is over" (see App._set_passthrough, _set_hover_clear, _hover_tick)
    def _set_passthrough(self, on):
        type(self.app)._set_passthrough(self, on)                # (the system code of the main window: root and back)

    def _set_hover_clear(self, on):
        if on == self._hover_cleared:
            return
        self._hover_cleared = on
        c = self.conf
        bg = max(0.03, min(1.0, float(c.get("bg_opacity", 1.0))))
        tx = max(0.2, min(1.0, float(c.get("text_opacity", 1.0))))
        cl = self.U["CLEARED_ALPHA"]
        try:
            if on:
                self.root.attributes("-alpha", cl)
                if self.two_window:
                    self.back.attributes("-alpha", cl)
            else:
                self.root.attributes("-alpha", tx)
                if self.two_window:
                    self.back.attributes("-alpha", bg)
        except Exception:
            pass

    def _on_configure(self, e):
        if e.widget is not self.root:
            return
        self._sync_back()
        if self._geo_job:
            self.root.after_cancel(self._geo_job)
        self._geo_job = self.root.after(600, self._save_geo)

    def _save_geo(self):
        self._geo_job = None
        try:
            self.conf["geometry"] = self.root.geometry()
            import config
            config.save(self.app.cfg)
        except Exception:
            pass

    # ---- chrome that shows while the mouse is over the window (see App.set_chrome / _hover_tick)
    def set_chrome(self, on):
        if on == self.chrome_on:
            return
        self.chrome_on = on
        U = self.U
        if on:
            self.title.place(x=0, y=0, relwidth=1.0, height=U["TITLE_H"])
            self.sb.place(relx=1.0, rely=0, x=-1, y=U["TITLE_H"], anchor="ne", width=U["SB_W"],
                          relheight=1.0, height=-(U["TITLE_H"] + U["GRIP"]))
            self.grip.place(relx=1.0, rely=1.0, anchor="se")
            self.body.configure(highlightbackground=U["EDGE"])
        else:
            for w in (self.title, self.sb, self.grip):
                w.place_forget()
            self.body.configure(highlightbackground=U["BG"])

    def _inside(self):
        try:
            px, py = self.root.winfo_pointerxy()
            x0, y0 = self.root.winfo_rootx(), self.root.winfo_rooty()
            return x0 <= px < x0 + self.root.winfo_width() and y0 <= py < y0 + self.root.winfo_height()
        except Exception:
            return False

    def _hover(self):
        """Like the main window's _hover_tick: click-through lets the mouse pass while the interact key is not held."""
        app = self.app
        inside = self._inside()
        if self.conf.get("click_through"):
            keep = self._interactive and (self.dragging or app._key_down(0x01))      # 0x01 = left button
            interactive = (app._interact_down() and inside) or keep
            if interactive != self._interactive:
                self._interactive = interactive
                self._set_passthrough(not interactive)
                if interactive:
                    app._enter_interactive()
                else:
                    self.text.tag_remove("sel", "1.0", "end")
                    app._leave_interactive()
            want = self.dragging or interactive
            self._set_hover_clear(bool(self.conf.get("hover_clear")) and inside and not interactive and not self.dragging)
        else:
            want = self.dragging or inside
            self._set_hover_clear(False)
        self.set_chrome(bool(want))

    def _tick(self):
        if self._dead:
            return
        try:
            self._hover()
            self._n += 1
            if self._n % 6 == 0:
                self._voice_color()
            if self.two_window and self._n % 20 == 0:
                self._stack()
            if self._n % 2 == 0:                                 # every 0.1 s (the main window looks at the focus every 0.12 s)
                self._keep_order()
        except Exception:
            pass
        self._tick_job = self.root.after(50, self._tick)

    # ---- moving / resizing (see App._drag_start ...)
    def _drag_start(self, e):
        self.dragging = True
        self._dx = e.x_root - self.root.winfo_x()
        self._dy = e.y_root - self.root.winfo_y()

    def _drag_move(self, e):
        self.root.geometry(f"+{e.x_root - self._dx}+{e.y_root - self._dy}")

    def _drag_end(self, _e):
        self.dragging = False

    def _resize_start(self, e):
        self.dragging = True
        self._rs = (e.x_root, e.y_root, self.root.winfo_width(), self.root.winfo_height())
        if self.plat.POLL_RESIZE:
            self._resize_poll()

    def _resize_end(self, _e):
        if self.plat.POLL_RESIZE:
            return                                         # the timer decides (macOS sends this when the pointer leaves)
        self.dragging = False

    def _resize_poll(self):
        if not self.dragging or self._dead:
            return
        if not self.app._key_down(0x01):
            self._rs_up = getattr(self, "_rs_up", 0) + 1
            if self._rs_up >= 3:
                self._rs_up = 0
                self.dragging = False
                return
        else:
            self._rs_up = 0
        x, y = self.root.winfo_pointerxy()
        x0, y0, w0, h0 = self._rs
        self.root.geometry(f"{max(self.MIN_W, w0 + x - x0)}x{max(self.MIN_H, h0 + y - y0)}")
        self.root.after(15, self._resize_poll)

    def _resize_move(self, e):
        x0, y0, w0, h0 = self._rs
        self.root.geometry(f"{max(self.MIN_W, w0 + e.x_root - x0)}x{max(self.MIN_H, h0 + e.y_root - y0)}")

    def _wheel(self, e):
        self.text.yview_scroll(-3 if e.delta > 0 else 3, "units")
        return "break"

    def on_close(self):
        """X: closed for now only; the setting (when it opens) stays. It is opened again from the context menu of window 1."""
        self._save_geo()
        self.app.kid_override[self.conf["id"]] = False
        self.app.sync_children()

    def destroy(self):
        self._dead = True
        for job in (self._geo_job, self._tick_job):
            if job:
                try:
                    self.root.after_cancel(job)
                except Exception:
                    pass
        for w in (self.back, self.root):
            try:
                w.destroy()
            except Exception:
                pass

    # ---- the lines
    def _copy_tag(self, name):
        """A tag of the main window (a colour ...) in this window too; the main window owns the colours."""
        if not name or name in ("gstart", "ind", "trans", "faded", "ghost", "fpad"):
            return
        src = self.app.text
        for opt in ("foreground", "underline"):
            try:
                val = src.tag_cget(name, opt)
            except Exception:
                return
            if val not in ("", "0"):
                self.text.tag_configure(name, **{opt: val})

    def _tags(self, base, extra):
        tags = tuple(base)
        if extra:
            tags += tuple(extra) if isinstance(extra, tuple) else (extra,)
        for t in tags:
            self._copy_tag(t)
        return tags

    def _at_bottom(self):
        try:
            self.text.update_idletasks()
            if self.text.bbox("end-1c") is not None:
                return True
        except Exception:
            pass
        return self.text.yview()[1] >= 0.999

    def _scroll_to_end(self):
        self.text.see("end")
        self.root.after(30, lambda: self.text.see("end") if not self._dead else None)

    def insert(self, pieces, tag, index="end", group=True, indent=False):
        at_bottom = self._at_bottom()
        base = (tag, "gstart") if group else (tag,)
        start = self.text.index("end-1c" if index == "end" else index)
        args = []
        for piece, extra in (pieces if not isinstance(pieces, str) else [(pieces, None)]):
            args += [piece, self._tags(base, extra)]
        self.text.insert(index, *args)
        if indent:
            self.text.tag_add("ind", start, f"{start}+1c")
        keep = int(self.app.cfg.get("max_lines", 500))
        n = int(self.text.index("end-1c").split(".")[0])
        if n > keep:
            self.text.delete("1.0", f"{n - keep}.0")
        if at_bottom:
            self._scroll_to_end()

    def add_line(self, pieces, tag, token=None):
        self.insert(pieces, tag)
        if token is not None:                                    # the translation goes here
            mark = f"tr{token}"
            self.text.mark_set(mark, "end-1c")
            self.text.mark_gravity(mark, "left")
            self.marks[token] = mark

    def add_translation(self, token, pieces, err=None, tag="trans"):
        mark = self.marks.pop(token, None)
        if mark is None:
            return
        try:
            if err:
                self.insert("⚠ " + err + "\n", "error", index=mark, group=False, indent=True)
            elif pieces:
                self.insert(pieces + [("\n", None)], "trans", index=mark, group=False, indent=True)
        finally:
            try:
                self.text.mark_unset(mark)
            except Exception:
                pass

    def drop(self, token):
        mark = self.marks.pop(token, None)
        if mark:
            try:
                self.text.mark_unset(mark)
            except Exception:
                pass
