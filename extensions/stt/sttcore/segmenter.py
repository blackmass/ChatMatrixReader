"""Cuts a stream of 16 kHz mono audio into sentences (speech segments) with a simple energy detector.

No model and no extra package: a frame is "speech" when its RMS is well above the noise floor that is measured on the quiet
frames in between (so a quiet and a loud voice chat both work). A segment ends after `end_ms` of quiet; a very long
one is cut at its quietest point near the end so the engine never gets more than `max_s` seconds. The engine (faster-whisper)
has its own VAD as a second filter, this one only decides where to cut.
"""
from collections import deque

import numpy as np


class Segmenter:
    def __init__(self, sr=16000, frame_ms=30, start_ms=90, end_ms=700, min_ms=350, max_s=12.0,
                 preroll_ms=300, tail_ms=200, min_rms=0.006, ratio=3.0):
        self.sr = sr
        self.fl = int(sr * frame_ms / 1000)
        n = lambda ms: max(1, int(round(ms / frame_ms)))
        self.start_n, self.end_n, self.min_n = n(start_ms), n(end_ms), n(min_ms)
        self.max_n, self.pre_n, self.tail_n = n(max_s * 1000), n(preroll_ms), n(tail_ms)
        self.min_rms, self.ratio = min_rms, ratio
        self.buf = np.zeros(0, np.float32)
        self.pre = deque(maxlen=self.pre_n + self.start_n)
        self.floor_hist = deque(maxlen=150)
        self.frames, self.rmsl = [], []
        self.speaking = False
        self.voiced = 0
        self.silent = 0
        self.lead = 0                                  # frames at the start that are only the pre-roll (not counted as speech)
        self.last_rms = 0.0

    # ------------------------------------------------------------------ noise floor
    def floor(self):
        if len(self.floor_hist) < 10:
            return 0.0
        return min(float(np.percentile(self.floor_hist, 20)), 0.05)

    def thresholds(self):
        f = self.floor() * self.ratio
        return max(self.min_rms, f), max(self.min_rms * 0.6, f * 0.6)       # (start, keep going)

    # ------------------------------------------------------------------ feeding
    def feed(self, x):
        """x: float32 mono samples. Returns the finished segments (arrays) - usually none."""
        if len(self.buf):
            x = np.concatenate([self.buf, x])
        out = []
        nfr = len(x) // self.fl
        for i in range(nfr):
            fr = x[i * self.fl:(i + 1) * self.fl]
            self._frame(fr, out)
        self.buf = x[nfr * self.fl:]
        return out

    def _frame(self, fr, out):
        rms = float(np.sqrt(np.mean(fr * fr)))
        self.last_rms = rms
        on, off = self.thresholds()
        if not self.speaking:
            self.pre.append((fr, rms))
            if rms >= on:
                self.voiced += 1
            else:
                self.voiced = 0
                self.floor_hist.append(rms)
            if self.voiced >= self.start_n:
                self.speaking = True
                self.frames = [f for f, _ in self.pre]
                self.rmsl = [r for _, r in self.pre]
                self.lead = len(self.frames) - self.voiced
                self.pre.clear()
                self.silent = 0
            return
        self.frames.append(fr)
        self.rmsl.append(rms)
        if rms < off:
            self.silent += 1
            self.floor_hist.append(rms)
        else:
            self.silent = 0
        if self.silent >= self.end_n:
            self._finish(out)
        elif len(self.frames) >= self.max_n:
            self._cut(out)

    def _reset(self):
        self.speaking = False
        self.frames, self.rmsl = [], []
        self.voiced = self.silent = self.lead = 0
        self.pre.clear()

    def _finish(self, out):
        speech = len(self.frames) - self.lead - self.silent
        if speech >= self.min_n:
            keep = min(len(self.frames), self.lead + speech + self.tail_n)
            out.append(np.concatenate(self.frames[:keep]))
        self._reset()

    def _cut(self, out):
        """Too long: cut at the quietest frame in the last third and go on with the rest."""
        n = len(self.frames)
        lo = n * 2 // 3
        idx = lo + int(np.argmin(self.rmsl[lo:]))
        out.append(np.concatenate(self.frames[:idx + 1]))
        self.frames, self.rmsl = self.frames[idx + 1:], self.rmsl[idx + 1:]
        self.silent = 0
        self.lead = 0

    def snapshot(self):
        """The sound of the sentence that is being spoken right now (for partial results), or None."""
        if not self.speaking or not self.frames:
            return None
        return np.concatenate(self.frames)

    def flush(self):
        """The source ended: whatever is being collected is a segment too."""
        out = []
        if self.speaking:
            self._finish(out)
        self._reset()
        return out
