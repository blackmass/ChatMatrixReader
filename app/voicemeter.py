"""The small signal indicator of the voice recognition (top right corner of the window).

    Model   what the indicator shows, from the events of the voice process (no window needed, so it is tested on its own)
    VoiceMeter   the little canvas that draws a Model snapshot (needs tkinter)

States:  off (nothing shown) | loading (preparing, a light moves over the bars) | idle (connected, nobody is making sound right now:
one dim bar) | active (sound is coming in: the bars follow the level) | error (a red "!"; needs the user's attention).
"No sound" is NOT an error: a quiet group leader is an ordinary situation, so it looks different from a broken connection.
"""
BARS = 5
FLOOR_DB = -55.0           # below this: no sound
STEP_DB = 7.0              # one more bar per step
HOLD_S = 0.8               # a short pause in the sound does not make the bars flicker to "idle"
STALE_S = 4.0              # the process reports the level five times a second: silence for this long = it hangs


def bars_for(db):
    if db is None or db <= FLOOR_DB:
        return 0
    return max(1, min(BARS, int((db - FLOOR_DB) / STEP_DB) + 1))


class Model:
    def __init__(self):
        self.state = "off"
        self.err_code = ""             # not_installed | message | exit | stale
        self.err_text = ""
        self.err_exit = None
        self.last_sound = None         # when the last sound was heard (monotonic seconds)
        self.last_level = None         # when the process last reported anything
        self.target = 0
        self.shown = 0
        self.active_until = 0.0

    # ---------------------------------------------------------------- events of the voice process
    def _error(self, code, text="", exit_code=None):
        self.state, self.err_code, self.err_text, self.err_exit = "error", code, text, exit_code
        self.target = self.shown = 0

    def on_event(self, m, now):
        kind = m.get("type")
        if kind == "off":
            self.state, self.target, self.shown = "off", 0, 0
            self.err_code = self.err_text = ""
            self.last_sound = self.last_level = None
        elif kind == "status":
            st = m.get("state")
            if st in ("starting", "loading", "ready"):
                if self.state in ("off", "error") or st == "starting":
                    self.state, self.err_code, self.err_text = "loading", "", ""
                    self.last_sound = self.last_level = None
                    self.target = self.shown = 0
            elif st == "listening":
                self.state, self.last_level = "idle", now
                self.err_code = self.err_text = ""
            elif st == "error":
                msg = m.get("msg", "")
                self._error("not_installed" if msg == "not installed" else "message", msg)
        elif kind == "level":
            if self.state in ("idle", "active"):
                self.last_level = now
                self.target = bars_for(m.get("db"))
                if self.target > 0:
                    self.last_sound = now
                    self.active_until = now + HOLD_S
                    self.state = "active"
        elif kind in ("text", "partial"):
            if self.state in ("idle", "active"):
                self.last_sound = now
        elif kind == "exit":
            if self.state != "off":
                self._error("exit", "", m.get("code"))

    def tick(self, now):
        """Called every ~150 ms: lets the bars fall one step at a time, ends 'active', finds a process that has stopped answering."""
        if self.state in ("idle", "active") and self.last_level is not None and now - self.last_level > STALE_S:
            self._error("stale")
        if self.state == "active" and now > self.active_until:
            self.state, self.target = "idle", 0
        if self.shown < self.target:
            self.shown = self.target
        elif self.shown > self.target:
            self.shown -= 1
        return self.snapshot(now)

    def snapshot(self, now):
        """(state, bars, tip code, tip values): the tip code is turned into a sentence (translated) by the window."""
        if self.state == "error":
            return ("error", 0, self.err_code, {"msg": self.err_text, "code": self.err_exit})
        if self.state == "idle":
            ago = None if self.last_sound is None else int(now - self.last_sound)
            return ("idle", 0, "idle", {"ago": ago})
        if self.state == "active":
            return ("active", self.shown, "active", {})
        if self.state == "loading":
            return ("loading", 0, "loading", {})
        return ("off", 0, "off", {})


# ------------------------------------------------------------------------------------------------------------------------------
try:
    import tkinter as tk
except ImportError:                                  # no tkinter (the tests of Model)
    tk = None

if tk is not None:
    W, H = 31, 16
    BAR_W, GAP, X0 = 3, 2, 4
    HEIGHTS = (3, 5, 7, 9, 11)
    C_BG, C_EDGE = "#1c1e22", "#3a3d44"
    C_OFF, C_ON, C_DIM, C_LOAD, C_ERR = "#3a3d44", "#4cc38a", "#2f7a57", "#6b83b3", "#ff5a5f"

    class VoiceMeter(tk.Canvas):
        """Five rising bars. Clicking opens the options (voice tab); the pointer over it shows what it means."""

        def __init__(self, parent, on_click, tip_text):
            super().__init__(parent, width=W, height=H, bg=C_BG, highlightthickness=1, highlightbackground=C_EDGE, bd=0,
                             cursor="hand2")
            self.tip_text = tip_text                       # () -> the sentence for the current state
            self._last = None
            self._tip = None
            self.bind("<Button-1>", lambda e: on_click())
            self.bind("<Enter>", self._show_tip)
            self.bind("<Leave>", self._hide_tip)

        def render(self, state, bars, phase=0):
            key = (state, bars, phase if state == "loading" else 0)
            if key == self._last:
                return
            self._last = key
            self.delete("all")
            if state == "error":
                self.create_text(W // 2, H // 2, text="!", fill=C_ERR, font=("Segoe UI", 10, "bold"))
                return
            for i in range(BARS):
                h = HEIGHTS[i]
                x = X0 + i * (BAR_W + GAP)
                if state == "active":
                    color = C_ON if i < bars else C_OFF
                elif state == "idle":
                    color = C_DIM if i == 0 else C_OFF
                else:                                       # loading: one bar lit, moving
                    color = C_LOAD if i == (phase // 2) % BARS else C_OFF
                self.create_rectangle(x, H - 3 - h, x + BAR_W, H - 3, fill=color, width=0)

        def _show_tip(self, e=None):
            self._hide_tip()
            try:
                tip = tk.Toplevel(self)
                tip.wm_overrideredirect(True)
                tip.attributes("-topmost", True)
                tk.Label(tip, text=self.tip_text(), bg="#2b2d31", fg="#e6e6e6", font=("Malgun Gothic", 9), padx=8, pady=4,
                         justify="left", wraplength=320, bd=1, relief="solid").pack()
                tip.update_idletasks()
                x = self.winfo_rootx() + W - tip.winfo_width()
                tip.wm_geometry(f"+{max(0, x)}+{self.winfo_rooty() + H + 4}")
                self._tip = tip
            except tk.TclError:
                self._tip = None

        def _hide_tip(self, e=None):
            if self._tip is not None:
                try:
                    self._tip.destroy()
                except tk.TclError:
                    pass
                self._tip = None
