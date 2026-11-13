"""What the STT process says to the reader: one JSON object per line on stdout (UTF-8). Human-readable logs go to stderr / the log file.

    {"type": "status", "state": "loading" | "ready" | "listening" | "stopped" | "done" | "error", "msg": "..."}
    {"type": "text",   "text": "...", "audio_s": 3.2, "infer_s": 0.41, "delay_s": 1.5, "lang": "en"}
    {"type": "partial", "text": "...", "audio_s": 1.8, "infer_s": 0.2}   live mode (--partial-ms): the sentence so far, replaced by the next one
                                                                          partial / by the final "text" of that sentence
    {"type": "check",  "ok": true, "msg": "...", "secs": 0.4}        answer of --check (engine loaded / server answered)
    {"type": "warn",   "msg": "...", "code": "no_audio|behind|live_not_streaming|failed", ...}   (code + its values: the reader writes its own text)  something the user may want to know (no sound, falling behind ...)
    {"type": "level",  "db": -41.2, "speech": false}      about once a second (only with --meter)

The reader may write {"cmd": "stop"} to stdin; end of stdin (the reader died) also stops the process.
"""
import json
import sys
import threading
import time


class Out:
    """Writes the messages: as JSON lines (--json, for the reader) or as readable lines for a person at a terminal."""

    def __init__(self, as_json):
        self.as_json = as_json
        self._lock = threading.Lock()
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    def emit(self, kind, **kw):
        with self._lock:
            try:
                if self.as_json:
                    sys.stdout.write(json.dumps({"type": kind, **kw}, ensure_ascii=False) + "\n")
                else:
                    sys.stdout.write(self._pretty(kind, kw) + "\n")
                sys.stdout.flush()
            except (BrokenPipeError, ValueError, OSError):
                pass                                          # the reader is gone: the stdin watcher stops the process

    @staticmethod
    def _pretty(kind, kw):
        t = time.strftime("%H:%M:%S")
        if kind == "text":
            return (f"[{t}] ({kw.get('audio_s', 0):.1f}s sound, {kw.get('infer_s', 0) * 1000:.0f} ms to recognise, "
                    f"{kw.get('delay_s', 0):.1f}s after the speaker stopped)  {kw['text']}")
        if kind == "partial":
            return f"[{t}] ... {kw['text']}"
        if kind == "check":
            return f"[{t}] {'OK' if kw.get('ok') else 'FAILED'}: {kw.get('msg', '')}"
        if kind == "status":
            return f"[{t}] -- {kw.get('state')}: {kw.get('msg', '')}"
        if kind == "warn":
            return f"[{t}] !! {kw.get('msg')}"
        if kind == "level":
            bar = "#" * max(0, min(40, int((kw.get('db', -90) + 70) / 70 * 40)))
            return f"[{t}] level {kw.get('db', -90):6.1f} dB {'SPEECH' if kw.get('speech') else '      '} {bar}  {kw.get('info', '')}"
        return f"[{t}] {kind} {kw}"
