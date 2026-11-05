"""Background thread that finds the ChatMatrix on screen and reports newly seen chat lines.

Screen grabbing uses mss (classic GDI BitBlt), NOT the Windows Graphics Capture API,
so no yellow capture border is drawn around anything.
"""
import threading
import time
from collections import deque

from i18n import tr

import numpy as np
import mss

import decoder


class CaptureWorker(threading.Thread):
    """Puts tuples into out_queue:
         ("status", text)
         ("lines", [decoder.Line, ...])     # only lines not seen before
    """

    def __init__(self, out_queue, get_cfg):
        super().__init__(daemon=True)
        self.out = out_queue
        self.get_cfg = get_cfg           # callable returning the current config dict
        self._stop_evt = threading.Event()
        self._research = threading.Event()
        self._seen = deque(maxlen=2000)
        self._seen_set = set()
        self._last_seq = None

    def stop(self):
        self._stop_evt.set()

    def research(self):
        """Forget the matrix position and search again."""
        self._research.set()

    # ------------------------------------------------------------------
    def _status(self, text):
        self.out.put(("status", text))

    def _remember(self, line_id):
        if len(self._seen) == self._seen.maxlen:
            self._seen_set.discard(self._seen[0])
        self._seen.append(line_id)
        self._seen_set.add(line_id)

    def _grab_array(self, sct, area):
        shot = sct.grab(area)
        return np.frombuffer(shot.bgra, dtype=np.uint8).reshape(shot.height, shot.width, 4)

    def _search(self, sct):
        for mon in sct.monitors[1:]:
            arr = self._grab_array(sct, mon)
            pos = decoder.find_matrix(arr)
            if pos:
                return mon["left"] + pos[0], mon["top"] + pos[1]
        return None

    # ------------------------------------------------------------------
    def run(self):
        try:
            with mss.mss() as sct:      # must be created inside this thread
                self._loop(sct)
        except Exception as e:           # report instead of dying silently
            self._status(tr("캡처 오류: {e}", e=repr(e)))

    def _loop(self, sct):
        pos = None
        fails = 0
        last_search = 0.0
        while not self._stop_evt.is_set():
            cfg = self.get_cfg()
            period = 1.0 / max(1, int(cfg.get("poll_hz", 30)))
            t0 = time.perf_counter()

            if self._research.is_set():
                self._research.clear()
                pos = None
                self._last_seq = None

            if pos is None:
                manual = cfg.get("manual_pos")
                if manual:
                    pos = (int(manual[0]), int(manual[1]))
                elif time.time() - last_search >= 1.0:
                    last_search = time.time()
                    self._status(tr("매트릭스 찾는 중... (게임을 창 모드로 띄우고 /cm 위치 확인)"))
                    pos = self._search(sct)
                    if pos:
                        fails = 0
                        self._status(tr("연결됨 @ {x},{y}", x=pos[0], y=pos[1]))
                if pos is None:
                    self._sleep_rest(t0, 0.2)
                    continue

            area = {"left": pos[0], "top": pos[1], "width": decoder.WIDTH, "height": decoder.HEIGHT}
            try:
                arr = self._grab_array(sct, area)
                frame, reason = decoder.decode_region(arr)
            except Exception as e:
                frame, reason = None, f"grab error {e!r}"

            if frame is None:
                fails += 1
                # a few bad frames are normal (redraw while reading); many in a row = lost
                if fails >= 90:
                    self._status(tr("매트릭스를 잃어버림 ({reason}) - 다시 찾는 중", reason=reason))
                    pos = None
                    fails = 0
            else:
                fails = 0
                if frame.seq != self._last_seq:
                    if self._last_seq is not None and frame.seq < self._last_seq:
                        # addon was reloaded (seq and line ids restart) -> forget old ids
                        self._seen.clear()
                        self._seen_set.clear()
                    self._last_seq = frame.seq
                    new = []
                    for line in frame.lines:
                        if line.id not in self._seen_set:
                            self._remember(line.id)
                            new.append(line)
                    if new:
                        self.out.put(("lines", new))
                    self._status(tr("연결됨 @ {x},{y}", x=pos[0], y=pos[1]) + f" | seq {frame.seq}")

            self._sleep_rest(t0, period)

    def _sleep_rest(self, t0, period):
        rest = period - (time.perf_counter() - t0)
        if rest > 0:
            self._stop_evt.wait(rest)
