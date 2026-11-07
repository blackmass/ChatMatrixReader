"""Background thread that finds the ChatMatrix on screen and reports newly seen chat lines.

Screen grabbing uses mss (classic GDI BitBlt), NOT the Windows Graphics Capture API,
so no yellow capture border is drawn around anything.
"""
import logging
import threading
import time
from collections import deque

from i18n import tr

import numpy as np
import mss

import decoder
import proto2


log = logging.getLogger("cmr.capture")


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

    # Screen grabs of a running game are not free (every full-screen BitBlt has to be read back from the GPU), so the
    # search first looks only at the bottom-left corner of each monitor - where the addon puts the matrix by default -
    # and scans whole monitors only rarely.
    CORNER_W, CORNER_H = 900, 260

    def _search(self, sct, full):
        for mon in sct.monitors[1:]:
            if full:
                area, dx, dy = mon, 0, 0
            else:
                w, h = min(mon["width"], self.CORNER_W), min(mon["height"], self.CORNER_H)
                area = {"left": mon["left"], "top": mon["top"] + mon["height"] - h, "width": w, "height": h}
                dx, dy = 0, mon["height"] - h
            arr = self._grab_array(sct, area)
            pos = decoder.find_matrix(arr)                      # protocol v1 first: exact colours, cheap
            if pos:
                return mon["left"] + dx + pos[0], mon["top"] + dy + pos[1], "v1", 0
            hit = proto2.find_and_decode(arr)                   # then v2 (colour-change tolerant)
            if hit:
                x, y, frame = hit
                return mon["left"] + dx + x, mon["top"] + dy + y, "v2", frame.rows
        return None

    def _probe(self, sct, pos):
        """Which protocol is at a manually given position? -> (mode, rows)"""
        try:
            arr = self._grab_array(sct, {"left": pos[0], "top": pos[1], "width": decoder.WIDTH, "height": decoder.HEIGHT})
            if decoder.decode_region(arr)[0] is not None:
                return "v1", 0
            arr = self._grab_array(sct, {"left": pos[0], "top": pos[1], "width": proto2.WIDTH, "height": 24 * proto2.CELL})
            frame, _ = proto2.decode(arr, 0, 0)
            if frame is not None:
                return "v2", frame.rows
        except Exception as e:
            log.info("수동 좌표 프로토콜 확인 실패: %r", e)
        return "v1", 0

    # ------------------------------------------------------------------
    def run(self):
        try:
            with mss.mss() as sct:      # must be created inside this thread
                self._loop(sct)
        except Exception as e:           # report instead of dying silently
            self._status(tr("캡처 오류: {e}", e=repr(e)))

    def _loop(self, sct):
        pos = None
        mode, rows = "v1", 0               # protocol of the matrix at `pos` (v2 matrices are `rows` cell rows tall)
        fails = 0
        last_warn = 0.0
        last_search = 0.0
        last_full = 0.0                   # last whole-monitor scan
        perf_n, perf_t, perf_log = 0, 0.0, time.time()
        while not self._stop_evt.is_set():
            cfg = self.get_cfg()
            period = 1.0 / max(1, int(cfg.get("poll_hz", 30)))
            t0 = time.perf_counter()

            if self._research.is_set():
                self._research.clear()
                pos = None
                self._last_seq = None
                last_full = 0.0           # the user asked: scan everything right away
                last_search = 0.0

            if pos is None:
                manual = cfg.get("manual_pos")
                if manual:
                    pos = (int(manual[0]), int(manual[1]))
                    mode, rows = self._probe(sct, pos)
                elif time.time() - last_search >= 1.0:
                    last_search = time.time()
                    full = time.time() - last_full >= 30.0
                    if full:
                        last_full = time.time()
                    self._status(tr("매트릭스 찾는 중... (게임을 창 모드로 띄우고 /cm 위치 확인)"))
                    hit = self._search(sct, full)
                    if hit:
                        pos, mode, rows = (hit[0], hit[1]), hit[2], hit[3]
                        fails = 0
                        log.info("매트릭스 발견 @ %d,%d | 프로토콜 %s%s", pos[0], pos[1], mode,
                                 (" (%d줄)" % rows) if mode == "v2" else "")
                        self._status(tr("연결됨 @ {x},{y}", x=pos[0], y=pos[1]))
                if pos is None:
                    self._sleep_rest(t0, 0.2)
                    continue

            area = {"left": pos[0], "top": pos[1], "width": decoder.WIDTH,
                    "height": decoder.HEIGHT if mode == "v1" else rows * proto2.CELL}
            try:
                tg = time.perf_counter()
                arr = self._grab_array(sct, area)
                perf_n += 1
                perf_t += time.perf_counter() - tg
                if mode == "v1":
                    frame, reason = decoder.decode_region(arr)
                else:
                    frame, reason = proto2.decode(arr, 0, 0)
                if frame is None and reason == "ramp merged" and time.time() - last_warn >= 30:
                    last_warn = time.time()
                    log.warning("v2 매트릭스: 단계가 화면에서 서로 구분되지 않습니다 - 애드온에서 '색 단계'를 더 낮추세요")
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
                    self._status(tr("연결됨 @ {x},{y}", x=pos[0], y=pos[1]) + f" | seq {frame.seq}"
                                 + (f" | v2·{frame.levels}" if mode == "v2" else ""))

            if perf_n and time.time() - perf_log >= 60:        # one line a minute: how expensive is the grabbing?
                log.info("캡처 | 최근 %d회 평균 %.2f ms (최대 초당 %d회)", perf_n, perf_t / perf_n * 1000, int(1 / period))
                perf_n, perf_t, perf_log = 0, 0.0, time.time()
            self._sleep_rest(t0, period)

    def _sleep_rest(self, t0, period):
        rest = period - (time.perf_counter() - t0)
        if rest > 0:
            self._stop_evt.wait(rest)
