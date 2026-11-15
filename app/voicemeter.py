"""The small signal indicator of the voice recognition (top right corner of the window).

    Model   what the indicator shows, from the events of the voice process (no window needed, so it is tested on its own)
    (the little widget that draws a Model snapshot comes with the Qt window code)

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
