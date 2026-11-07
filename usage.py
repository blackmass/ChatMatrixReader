"""Rough count of the characters sent to the official Google Cloud Translation API, per calendar month.
An estimate only (other programs / other PCs using the same key are not counted; Google's month boundary may differ
by a few hours). Stored in usage.json next to the program."""
import json
import logging
import os
import threading
import time

log = logging.getLogger("cmr.usage")
PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "usage.json")
FREE_LIMIT = 500_000          # characters per month that Google lists as free (check the pricing page)
STEP = 100_000                # tell the user every time the total passes a multiple of this

_lock = threading.Lock()
_state = None                 # {"month": "YYYY-MM", "chars": int, "notified": int}


def _month():
    return time.strftime("%Y-%m")


def _load():
    global _state
    if _state is None:
        try:
            with open(PATH, encoding="utf-8") as f:
                d = json.load(f)
            _state = {"month": str(d.get("month", "")), "chars": int(d.get("chars", 0)),
                      "notified": int(d.get("notified", 0))}
        except (OSError, ValueError, TypeError):
            _state = {"month": _month(), "chars": 0, "notified": 0}
    if _state["month"] != _month():                        # new month: start again
        _state = {"month": _month(), "chars": 0, "notified": 0}
    return _state


def _save():
    try:
        tmp = PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_state, f)
        os.replace(tmp, PATH)
    except OSError as e:
        log.warning("사용량 저장 실패: %s", e)


def total() -> int:
    with _lock:
        return _load()["chars"]


def add(n: int):
    """Count `n` more characters. Returns the new total if it passed a multiple of STEP since the last notice, else None."""
    with _lock:
        st = _load()
        st["chars"] += max(0, int(n))
        level = st["chars"] // STEP
        hit = None
        if level > st["notified"]:
            st["notified"] = level
            hit = st["chars"]
        _save()
        return hit
