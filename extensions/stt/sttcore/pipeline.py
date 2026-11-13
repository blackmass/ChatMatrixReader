"""sound source -> 16 kHz mono -> sentences -> engine -> filter -> text messages.

Threads: the source's own thread (only queues the bytes), the audio thread (convert + cut into sentences) and this thread
(runs the engine, one sentence at a time). The engine is the slow part: when it falls behind, the OLDEST waiting sentences are
dropped (a warning says so) - the speaker's newest words matter more than a queue that keeps growing.
"""
import logging
import queue
import wave
import os
import threading
import time
from collections import deque

import numpy as np

from . import filters
from .audio import Resampler, db, pcm_to_mono
from .segmenter import Segmenter

log = logging.getLogger("stt.pipeline")

DEFAULT_PROMPT = ("World of Warcraft raid. Tank, healer, DPS, boss, pull, stack, spread, interrupt, cooldowns, adds, phase, "
                  "wipe, mana, buff, debuff, loot, ready check.")


class Pipeline:
    def __init__(self, source, engine, out, cfg, stop):
        self.source, self.engine, self.out, self.cfg, self.stop = source, engine, out, cfg, stop
        self.raw = queue.Queue(maxsize=0 if source.lossless else 800)
        self.cond = threading.Condition()
        self.segq = deque()
        self.audio_done = False
        self.dropped_raw = 0
        self.last_pcm = time.monotonic()
        self.no_audio_warned = False
        self.seg = Segmenter(**cfg.get("seg", {}))
        self.end_s = self.seg.end_n * 0.03
        self.partial_s = float(cfg.get("partial_ms", 0)) / 1000.0     # > 0: "live" mode - text of the sentence while it is spoken
        self.partial_snap = None                                       # (sound, generation): the newest sentence-so-far to recognise
        self.gen = 0                                                   # counts finished sentences: a partial of an older one is stale
        self.t_partial = 0.0
        self.last_partial = ""

    # ------------------------------------------------------------------ source side
    def _on_data(self, pcm):
        try:
            self.raw.put_nowait(pcm) if not self.source.lossless else self.raw.put(pcm)
        except queue.Full:
            self.dropped_raw += 1
            if self.dropped_raw in (1, 100, 1000):
                log.warning("audio queue full: dropped %d chunks (the reader is too slow)", self.dropped_raw)

    def _maybe_partial(self, now):
        if self.partial_s <= 0 or not self.seg.speaking or now - self.t_partial < self.partial_s:
            return
        snap = self.seg.snapshot()
        if snap is None or len(snap) < 9600:                  # < 0.6 s: nothing to read yet
            return
        self.t_partial = now
        with self.cond:
            self.partial_snap = (snap, self.gen)
            self.cond.notify()

    def _push(self, seg):
        with self.cond:
            self.gen += 1
            self.partial_snap = None                           # the finished sentence replaces whatever was shown while it was spoken
            self.segq.append((seg, time.monotonic()))
            limit = int(self.cfg.get("max_backlog", 3)) if not self.source.lossless else 10 ** 9      # a file is never skipped
            lost = 0
            while len(self.segq) > limit:
                self.segq.popleft()
                lost += 1
            self.cond.notify()
        if lost:
            self.out.emit("warn", code="behind", lost=lost, msg=f"recognition is behind: {lost} older sentence(s) skipped")
            log.warning("backlog > %d: dropped %d sentence(s)", limit, lost)

    def _audio_loop(self):
        dump = None
        if self.cfg.get("dump"):                             # what the engine gets to hear, as a 16 kHz mono WAV (to listen to it)
            try:
                dump = wave.open(self.cfg["dump"], "wb")
                dump.setnchannels(1); dump.setsampwidth(2); dump.setframerate(16000)
                log.info("dumping the 16 kHz sound to %s", self.cfg["dump"])
            except Exception:
                log.exception("cannot write the dump file")
        rs = None                                            # made at the first chunk: a live source knows its format only after start()
        meter = bool(self.cfg.get("meter"))
        meter_s = float(self.cfg.get("meter_s", 1.0))
        t_meter, peak = time.monotonic(), 0.0

        def show_meter(now, level):
            nonlocal t_meter, peak
            info = self.source.debug_state() if hasattr(self.source, "debug_state") else ""
            self.out.emit("level", db=round(db(level), 1), speech=self.seg.speaking, info=info)
            t_meter, peak = now, 0.0

        try:
            while not self.stop.is_set():
                try:
                    pcm = self.raw.get(timeout=0.2)
                except queue.Empty:
                    now = time.monotonic()
                    if meter and now - t_meter >= meter_s:       # also while no sound arrives at all (a loopback sends nothing when nothing plays)
                        show_meter(now, peak)
                    self._watchdog()
                    self._maybe_partial(now)
                    if not self.source.lossless and self.seg.speaking:
                        # a loopback sends nothing while nothing plays: without this the end of a sentence would only be noticed
                        # when the next sound starts. Silence is fed (0.2 s per idle wait) only while a sentence is open.
                        for s in self.seg.feed(np.zeros(3200, np.float32)):
                            self._push(s)
                    continue
                if pcm is None:                              # the source has ended (a file)
                    for s in self.seg.flush():
                        self._push(s)
                    break
                now = time.monotonic()
                if self.no_audio_warned:
                    log.info("sound is coming in again")
                    self.no_audio_warned = False
                self.last_pcm = now
                if rs is None:
                    rs = Resampler(self.source.sample_rate)
                y = rs.process(pcm_to_mono(pcm, self.source.channels, self.source.is_float))
                if not len(y):
                    continue
                if dump is not None:
                    dump.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())
                for s in self.seg.feed(y):
                    log.debug("segment %.1f s", len(s) / 16000)
                    self._push(s)
                self._maybe_partial(now)
                peak = max(peak, self.seg.last_rms)
                if meter and now - t_meter >= meter_s:
                    show_meter(now, peak)
        except Exception:
            log.exception("audio thread failed")
            self.out.emit("status", state="error", msg="audio processing failed (see the log)")
            self.stop.set()
        finally:
            if dump is not None:
                dump.close()
            with self.cond:
                self.audio_done = True
                self.cond.notify()

    def _watchdog(self):
        if self.source.lossless or self.no_audio_warned:
            return
        limit = float(self.cfg.get("no_audio_s", 8))
        if time.monotonic() - self.last_pcm > limit:
            self.no_audio_warned = True
            msg = (f"no sound from the program for {limit:.0f} s - is it running, and is something being played / said? "
                   "(the capture only hears what that program plays)")
            log.warning(msg)
            self.out.emit("warn", code="no_audio", seconds=int(limit), msg=msg)

    # ------------------------------------------------------------------ engine side
    def _do_partial(self, snap, gen, lang, prompt):
        """Live mode: the text of the sentence so far. A sentence that is finished in the meantime wins (gen changed)."""
        try:
            t1 = time.perf_counter()
            results = self.engine.transcribe(snap, lang, prompt)
            infer = time.perf_counter() - t1
        except Exception:
            log.exception("partial recognition failed")
            return
        audio_s = len(snap) / 16000
        text = " ".join(r.text.strip() for r in results if filters.keep(r.text, audio_s, r.avg_logprob, r.no_speech_prob)[0])
        if not text or text == self.last_partial or gen != self.gen:
            return
        self.last_partial = text
        self.out.emit("partial", text=text, audio_s=round(audio_s, 2), infer_s=round(infer, 3))

    def _gpu_loop(self):
        """Once a second: how the graphics card is doing (NVIDIA only; no NVIDIA driver = nothing is sent). The reader shows it."""
        try:
            from . import nvml
            n = nvml.Nvml.open()
            if n is None:
                return
            pids = {os.getpid()}
            try:
                import psutil
                pids |= {c.pid for c in psutil.Process().children(recursive=True)}
            except Exception:
                pass
            try:
                while not self.stop.wait(1.0):
                    c = n.card(0)
                    self.out.emit("gpu", used=c["used"], total=c["total"], util=c["util"], temp=c["temp"], proc=n.process_mem(pids))
            finally:
                n.close()
        except Exception:
            log.exception("gpu statistics stopped")

    def run(self):
        out = self.out
        out.emit("status", state="loading", msg="loading the recognition engine (the first time this can take a while) ...")
        t0 = time.perf_counter()
        try:
            desc = self.engine.load()
        except Exception as e:
            log.exception("engine load failed")
            out.emit("status", state="error", msg=str(e))
            return 2
        out.emit("status", state="ready", msg=f"{desc} - loaded in {time.perf_counter() - t0:.1f} s", engine=self.engine.info(), pid=os.getpid())
        th = threading.Thread(target=self._audio_loop, name="audio", daemon=True)
        try:
            self.source.start(self._on_data)
        except Exception as e:
            log.exception("capture start failed")
            out.emit("status", state="error", msg=str(e))
            self.engine.close()
            return 3
        self.last_pcm = time.monotonic()                     # (the model took its time: the "no sound" clock starts now)
        th.start()
        if (self.engine.info() or {}).get("device") == "cuda":
            threading.Thread(target=self._gpu_loop, name="gpu-stats", daemon=True).start()
        out.emit("status", state="listening", msg=self.cfg.get("listening_msg", "listening"))
        errors = 0
        if self.partial_s > 0 and not self.engine.streaming:
            msg = (f"live mode with the '{self.engine.name}' engine: it is not a streaming model, so every update recognises the whole "
                   "sentence again (more load on the graphics card, words at the end may keep changing). Not recommended.")
            log.warning(msg)
            out.emit("warn", code="live_not_streaming", msg=msg)
        lang = self.cfg.get("lang")
        prompt = self.cfg.get("prompt", DEFAULT_PROMPT)
        try:
            while True:
                part = None
                with self.cond:
                    while not self.segq and not self.audio_done and not self.stop.is_set() and not self.partial_snap:
                        self.cond.wait(0.2)
                    if self.stop.is_set():
                        break
                    if not self.segq:
                        if self.partial_snap:
                            part, self.partial_snap = self.partial_snap, None
                        elif self.audio_done:
                            break
                        else:
                            continue
                    else:
                        seg, t_in = self.segq.popleft()
                if part is not None:
                    self._do_partial(*part, lang, prompt)
                    continue
                waited = time.monotonic() - t_in
                audio_s = len(seg) / 16000
                t1 = time.perf_counter()
                try:
                    results = self.engine.transcribe(seg, lang, prompt)
                    errors = 0
                except Exception as e:
                    errors += 1
                    log.exception("recognition failed")
                    out.emit("warn", code="failed", error=str(e), msg=f"recognition failed: {e}")
                    if errors >= 5:
                        out.emit("status", state="error", msg=f"recognition failed 5 times in a row - stopped ({e})")
                        self.stop.set()
                        break
                    continue
                infer = time.perf_counter() - t1
                kept = []
                for r in results:
                    ok, why = filters.keep(r.text, audio_s, r.avg_logprob, r.no_speech_prob)
                    if ok:
                        kept.append(r.text.strip())
                    else:
                        log.info("dropped (%s): %r", why, r.text)
                log.info("segment %.1f s -> %d ms, waited %.2f s, %d result(s), %d kept", audio_s, infer * 1000, waited, len(results), len(kept))
                self.last_partial = ""
                if kept:
                    out.emit("text", text=" ".join(kept), audio_s=round(audio_s, 2), infer_s=round(infer, 3),
                             delay_s=round(self.end_s + waited + infer, 2), lang=(results[0].language if results else None))
        finally:
            self.stop.set()
            th.join(2)
            try:
                self.source.stop()
            except Exception:
                log.exception("source stop failed")
            self.engine.close()
        done = self.audio_done and not self.segq and errors < 5
        out.emit("status", state="done" if done and self.source.lossless else "stopped",
                 msg="the file is finished" if done and self.source.lossless else "stopped")
        return 0
