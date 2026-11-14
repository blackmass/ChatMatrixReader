"""Background thread that finds the ChatMatrix on screen and reports newly seen chat lines.

Screen grabbing uses mss (classic GDI BitBlt), NOT the Windows Graphics Capture API,
so no yellow capture border is drawn around anything. On macOS capture_mac.MacGrabber grabs at the real pixel resolution.
"""
import logging
import math
import sys
import threading
import time
from collections import deque

from i18n import tr

import numpy as np

try:
    import mss
except ImportError:                      # macOS installs do not need it
    mss = None

import decoder
import proto2
import proto3
import scaled


log = logging.getLogger("cmr.capture")


def open_grabber():
    """The screen grabber for this system (used as a context manager inside the capture thread)."""
    if sys.platform == "darwin":
        import capture_mac
        return capture_mac.MacGrabber()
    return (getattr(mss, "MSS", None) or mss.mss)()


class CaptureWorker(threading.Thread):
    """Puts tuples into out_queue:
         ("status", text)
         ("lines", [decoder.Line, ...])     # only lines not seen before
    """

    def __init__(self, out_queue, get_cfg, get_game_rect=None):
        super().__init__(daemon=True)
        self.out = out_queue
        self.get_cfg = get_cfg           # callable returning the current config dict
        self.get_game_rect = get_game_rect or (lambda: None)     # (left, top, width, height) of the game window on screen, or None
        self._full_n = 0
        self._stop_evt = threading.Event()
        self._research = threading.Event()
        self._seen = deque(maxlen=2000)       # keys of lines already passed on: (id, channel, sender, text)
        self._seen_set = set()
        self._n_seq = 0                       # frames with a new sequence number / new lines passed on (for the log)
        self._n_new = 0
        self._last_seq = None
        self._n_gap = 0                       # matrix pictures that were never seen (sequence number jumps)
        self._gap_log = 0.0
        self._seq_time = time.time()      # when the sequence number last changed

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
    # whole-window search is done only now and then ("full_scan_sec"); in between only the last known position is read.

    def _regions(self, sct):
        """[(area, left, top)] to look at. The game window when it is known (the matrix can only be inside it: on a
        computer with four monitors that is a quarter of the work); else every monitor. A search of the whole window that
        found nothing is, now and then, followed by the monitors, so a wrong window rectangle can never blind it for good."""
        rect = self.get_game_rect()
        if rect and rect[2] >= 200 and rect[3] >= 100:
            self._full_n += 1
            if self._full_n % 4:
                l, t, w, h = rect
                return [({"left": l, "top": t, "width": w, "height": h}, l, t)]
        return [(mon, mon["left"], mon["top"]) for mon in sct.monitors[1:]]

    def _search(self, sct):
        for area, ox, oy in self._regions(sct):
            try:
                arr = self._grab_array(sct, area)
            except Exception:
                continue                                        # (e.g. a window partly outside the screen)
            pos = decoder.find_matrix_ex(arr)                   # protocol v1 first: exact colours, cheap
            if pos:
                return ox + pos[0], oy + pos[1], "v1", 0, None, pos[2]
            hit = proto2.find_and_decode(arr)                   # then v2 (colour-change tolerant)
            if hit:
                x, y, frame = hit
                return ox + x, oy + y, "v2", frame.rows, None, frame.cols
            hit = proto3.find_and_decode(arr)                   # then v3 (the thin line along a screen edge; the window is grabbed anyway)
            if hit:
                x, y, vertical, extent, frame = hit
                return ox + x, oy + y, "v3", 0, {"vertical": vertical, "extent": extent}, frame.cells
            hit = scaled.find(arr)                              # v2 with cells of another size / mixed colours (macOS)
            if hit:
                x, y, pitch, frame = hit
                gx, gy = ox + x, oy + y
                left, top = int(math.floor(gx)) - 3, int(math.floor(gy)) - 3
                geom = {"pitch": pitch, "ox": gx - left, "oy": gy - top, "rows": frame.rows, "cols": frame.cols,
                        "w": int(math.ceil(frame.cols * pitch + gx - left + 4)), "h": int(math.ceil(frame.rows * pitch + gy - top + 4))}
                return left, top, "v2s", frame.rows, geom, frame.cols
        return None

    @staticmethod
    def _clip(sct, left, top, width, height):
        """The rectangle cut to the monitor it starts on (a grab that reaches past the screen is not needed and may fail)."""
        for mon in list(getattr(sct, "monitors", []))[1:]:
            if mon["left"] <= left < mon["left"] + mon["width"] and mon["top"] <= top < mon["top"] + mon["height"]:
                width = min(width, mon["left"] + mon["width"] - left)
                height = min(height, mon["top"] + mon["height"] - top)
                break
        return {"left": left, "top": top, "width": max(1, width), "height": max(1, height)}

    def _search_v3(self, sct):
        """Only the thin bands along the four edges of the game window (or of every monitor): cheap, so it can be done every few
        seconds while nothing is found (a line that hides when there is nothing to say shows up only now and then)."""
        for area, ox, oy in self._regions(sct):
            w, h, b = area["width"], area["height"], proto3.BAND
            for vertical, band in ((False, {"left": area["left"], "top": area["top"], "width": w, "height": min(b, h // 2)}),
                                   (False, {"left": area["left"], "top": area["top"] + h - min(b, h // 2), "width": w, "height": min(b, h // 2)}),
                                   (True, {"left": area["left"], "top": area["top"], "width": min(b, w // 2), "height": h}),
                                   (True, {"left": area["left"] + w - min(b, w // 2), "top": area["top"], "width": min(b, w // 2), "height": h})):
                try:
                    arr = self._grab_array(sct, band)
                except Exception:
                    continue
                hit = proto3.find_in_band(arr, vertical)
                if hit:
                    x, y, extent, frame = hit
                    return band["left"] + x, band["top"] + y, "v3", 0, {"vertical": vertical, "extent": extent}, frame.cells
        return None

    def _probe_last(self, sct, pos):
        """Is the matrix still (or again) where it was found last time? -> (mode, rows, cols, geom) or None. One small grab: cheap enough
        to do every second while the matrix is missing (game loading, addon reloaded, this program just started)."""
        try:
            arr = self._grab_array(sct, {"left": pos[0], "top": pos[1], "width": decoder.WIDTH, "height": decoder.size_for(16)[1]})   # the tallest v1 shape
            for cols in decoder.COL_CHOICES:
                if decoder.decode_region(arr, cols)[0] is not None:
                    return "v1", 0, cols, None
            arr = self._grab_array(sct, {"left": pos[0], "top": pos[1], "width": proto2.WIDTH,
                                         "height": proto2.rows_for(2, cols=min(proto2.COL_CHOICES)) * proto2.CELL})   # the tallest matrix (2 levels, narrow)
            frame, _ = proto2.decode(arr, 0, 0)
            if frame is not None:
                return "v2", frame.rows, frame.cols, None
            for vertical in (False, True):                       # v3: a thin line, along x or along y
                n = proto3.GRAB_MAX
                area = self._clip(sct, pos[0], pos[1], proto3.CELL if vertical else n, n if vertical else proto3.CELL)
                arr = self._grab_array(sct, area)
                extent = area["height"] if vertical else area["width"]
                frame, _ = proto3.decode(proto3.oriented(arr, 0, 0, vertical, extent), vertical)
                if frame is not None:
                    return "v3", 0, frame.cells, {"vertical": vertical, "extent": extent}
        except Exception:
            pass
        return None

    # ------------------------------------------------------------------
    def run(self):
        try:
            with open_grabber() as sct:      # must be created inside this thread
                self._loop(sct)
        except PermissionError:
            log.error("화면 기록 권한이 없습니다")
            self._status(tr("화면 기록 권한이 필요합니다. 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 녹음에서 허용한 뒤 프로그램을 다시 실행하세요."))
        except Exception as e:           # report instead of dying silently
            self._status(tr("캡처 오류: {e}", e=repr(e)))

    def _loop(self, sct):
        pos = None
        mode, rows, cols = "v1", 0, 32     # protocol of the matrix at `pos` (v2 matrices are `rows` cell rows tall), cells per row
        geom = None                        # mode "v2s": cell size and sub-pixel position of a scaled matrix
        fails = 0
        last_ok = time.time()             # when a frame was last read
        last_warn = 0.0
        last_search = 0.0
        last_full = 0.0                   # last whole-monitor scan
        last_v3 = 0.0                     # last look at the thin edge bands only
        v3_wait = False                   # a v3 line is hidden because the addon has nothing to say (not a lost matrix)
        remembered = None                 # where the matrix was last found (kept in the settings: "last_pos")
        try:
            lp = self.get_cfg().get("last_pos")
            if lp:
                remembered = (int(lp[0]), int(lp[1]))
        except (TypeError, ValueError, IndexError):
            remembered = None
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
                if time.time() - last_search >= 1.0:
                    last_search = time.time()
                    try:
                        every = max(5.0, min(600.0, float(cfg.get("full_scan_sec", 30))))
                    except (TypeError, ValueError):
                        every = 30.0
                    full = time.time() - last_full >= every
                    if full:
                        last_full = time.time()
                    self._status(tr("매트릭스 찾는 중... (게임을 창 모드로 띄우고 /cm 위치 확인)"))
                    hit, how = None, ""
                    if remembered:                                  # every second: is it back where it was?
                        pm = self._probe_last(sct, remembered)
                        if pm:
                            hit, how = (remembered[0], remembered[1], pm[0], pm[1], pm[3], pm[2]), " (마지막 위치)"
                    if not hit and full:                            # (between the whole-window searches: only the last position)
                        hit = self._search(sct)
                    elif not hit and time.time() - last_v3 >= 1.0:  # a v3 line may be hidden: the thin edge bands are cheap to look at
                        last_v3 = time.time()
                        hit = self._search_v3(sct)
                    if hit:
                        pos, mode, rows, geom, cols = (hit[0], hit[1]), hit[2], hit[3], hit[4], hit[5]
                        fails = 0
                        last_ok = time.time()
                        if mode == "v3":
                            shape = " (한 줄 %d칸, %s)" % (cols, "세로" if geom["vertical"] else "가로")
                        else:
                            shape = ((" (%d줄)" % rows) if mode != "v1" else "") + ((" 폭 %dpx" % (cols * 4)) if cols != 32 else "") \
                                    + ((" 셀 %.2fpx" % geom["pitch"]) if geom else "")
                        log.info("매트릭스 발견 @ %d,%d | 프로토콜 %s%s%s", pos[0], pos[1], mode, shape, how)
                        v3_wait = False
                        self._status(tr("연결됨 @ {x},{y}", x=pos[0], y=pos[1]))
                        if mode != "v2s" and remembered != pos:      # the next start looks here first
                            remembered = pos
                            self.out.put(("pos", pos))
                if pos is None:
                    self._sleep_rest(t0, 0.2)
                    continue

            if mode == "v2s":
                area = {"left": pos[0], "top": pos[1], "width": geom["w"], "height": geom["h"]}
            elif mode == "v3":
                area = {"left": pos[0], "top": pos[1], "width": proto3.CELL if geom["vertical"] else geom["extent"],
                        "height": geom["extent"] if geom["vertical"] else proto3.CELL}
            else:
                area = {"left": pos[0], "top": pos[1], "width": cols * 4,
                        "height": decoder.size_for(cols)[1] if mode == "v1" else rows * proto2.CELL}
            try:
                tg = time.perf_counter()
                arr = self._grab_array(sct, area)
                perf_n += 1
                perf_t += time.perf_counter() - tg
                if mode == "v1":
                    frame, reason = decoder.decode_region(arr, cols)
                elif mode == "v2s":
                    frame, reason = scaled.decode(arr, geom["ox"], geom["oy"], geom["pitch"], geom["rows"], geom["cols"])
                elif mode == "v3":
                    frame, reason = proto3.decode(proto3.oriented(arr, 0, 0, geom["vertical"], geom["extent"]), geom["vertical"])
                else:
                    frame, reason = proto2.decode(arr, 0, 0, cols)
                if frame is None and reason == "ramp merged" and time.time() - last_warn >= 30:
                    last_warn = time.time()
                    log.warning("v2 매트릭스: 단계가 화면에서 서로 구분되지 않습니다 - 애드온에서 '색 단계'를 더 낮추세요")
            except Exception as e:
                frame, reason = None, f"grab error {e!r}"

            if frame is None and mode == "v3":
                # the line is hidden while the addon has nothing to say: that is not a lost matrix. Now and then (the long full-scan
                # period) everything is searched again, in case the addon was set to another place / protocol.
                if not v3_wait:
                    v3_wait = True
                    self._status(tr("연결됨 @ {x},{y}", x=pos[0], y=pos[1]) + " | v3 " + tr("(대기 중: 새 대화가 오면 나타남)"))
                try:
                    every = max(5.0, min(600.0, float(cfg.get("full_scan_sec", 30))))
                except (TypeError, ValueError):
                    every = 30.0
                if time.time() - last_ok >= every and time.time() - last_full >= every:
                    last_full = time.time()
                    hit = self._search(sct)
                    if hit and (hit[0], hit[1], hit[2]) != (pos[0], pos[1], mode):
                        pos, mode, rows, geom, cols = (hit[0], hit[1]), hit[2], hit[3], hit[4], hit[5]
                        v3_wait = False
                        last_ok = time.time()
                        log.info("매트릭스 위치/프로토콜이 바뀜 @ %d,%d | 프로토콜 %s", pos[0], pos[1], mode)
                        if mode != "v2s" and remembered != pos:
                            remembered = pos
                            self.out.put(("pos", pos))
            elif frame is None:
                fails += 1
                # a few bad frames are normal (redraw while reading); many in a row = lost. Judged by time as well as by the
                # count: grabbing a game that draws slowly (loading, character selection) can take 100 ms or more per frame,
                # and 90 of those are 10+ seconds.
                if fails >= 10 and time.time() - last_ok >= 2.5:
                    log.info("매트릭스를 잃어버림: 연속 %d프레임 실패, 마지막 성공 %.1f초 전 (%s)", fails, time.time() - last_ok, reason)
                    self._status(tr("매트릭스를 잃어버림 ({reason}) - 다시 찾는 중", reason=reason))
                    pos = None
                    fails = 0
            else:
                fails = 0
                last_ok = time.time()
                v3_wait = False
                if frame.seq != self._last_seq:
                    if self._last_seq is not None and frame.seq < self._last_seq:
                        # addon was reloaded (seq and line ids restart) -> forget old ids
                        self._seen.clear()
                        self._seen_set.clear()
                    now_t = time.time()
                    if self._last_seq is not None and frame.seq > self._last_seq + 1:
                        gap = frame.seq - self._last_seq - 1          # matrix pictures that were drawn but never seen
                        self._n_gap += gap
                        if now_t - self._seq_time <= 5 and now_t - self._gap_log >= 1:
                            self._gap_log = now_t
                            log.info("매트릭스 그림 %d장을 놓침 (순번 %d -> %d, %.2f초 사이)", gap, self._last_seq, frame.seq,
                                     now_t - self._seq_time)
                    if self._last_seq is not None and frame.seq > self._last_seq + 1 and now_t - self._seq_time > 5:
                        log.info("순번 %d -> %d: %.0f초 동안 그대로이다가 %d 건너뜀 (게임이 화면을 느리게 그리고 있었을 수 있음)",
                                 self._last_seq, frame.seq, now_t - self._seq_time, frame.seq - self._last_seq)
                    self._seq_time = now_t
                    self._last_seq = frame.seq
                    self._n_seq += 1
                    new = []
                    for line in frame.lines:
                        key = (line.id, line.channel, line.sender, line.text)
                        if key not in self._seen_set:             # the id alone repeats after an addon reload / id wrap
                            self._remember(key)
                            new.append(line)
                    if new:
                        self._n_new += len(new)
                        self.out.put(("lines", new))
                    self._status(tr("연결됨 @ {x},{y}", x=pos[0], y=pos[1]) + f" | seq {frame.seq}"
                                 + (f" | {'v3' if mode == 'v3' else 'v2'}·{frame.levels}" if mode != "v1" else ""))

            if perf_n and time.time() - perf_log >= 60:        # one line a minute: how expensive is the grabbing?
                log.info("캡처 | 최근 %d회 평균 %.2f ms (최대 초당 %d회) | 순번 변경 %d회, 놓친 그림 %d장, 새 줄 %d개 전달 (순번 %s)", perf_n,
                         perf_t / perf_n * 1000, int(1 / period), self._n_seq, self._n_gap, self._n_new, self._last_seq)
                perf_n, perf_t, perf_log = 0, 0.0, time.time()
                self._n_seq = self._n_new = self._n_gap = 0
            self._sleep_rest(t0, period)

    def _sleep_rest(self, t0, period):
        rest = period - (time.perf_counter() - t0)
        if rest > 0:
            self._stop_evt.wait(rest)
