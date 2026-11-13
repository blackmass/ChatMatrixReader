"""--probe: listen to the target for a few seconds and report what the capture really delivers (no recognition).

Answers: how fast does sound arrive (a wrong sample rate?), is it interleaved stereo or something else, is it smooth like real
audio, and writes the raw capture as a WAV so you can listen to exactly what comes out of the capture library.
"""
import struct
import time

import numpy as np


def ac1(x):
    x = np.asarray(x, np.float64)
    if len(x) < 10 or np.std(x) < 1e-9:
        return 0.0
    return float(np.corrcoef(x[:-1], x[1:])[0, 1])


def rms_db(x):
    return 20 * np.log10(max(float(np.sqrt(np.mean(np.square(np.asarray(x, np.float64))))), 1e-9))


def write_wav(path, samples, rate, channels, is_float):
    data = samples.astype("<f4" if is_float else "<i2").tobytes()
    bits = 32 if is_float else 16
    fmt = struct.pack("<HHIIHH", 3 if is_float else 1, channels, rate, rate * channels * bits // 8, channels * bits // 8, bits)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<I", 16) + fmt + b"data" + struct.pack("<I", len(data)) + data)


def probe(source, seconds, path, emit):
    chunks = []

    def on(pcm):
        if pcm:
            chunks.append((time.monotonic(), pcm))

    source.start(on)
    time.sleep(seconds)
    source.stop()
    if not chunks:
        emit("no chunk arrived at all - is the program playing sound? (the capture hears only that program)")
        return 1
    ch, rate, fl = source.channels, source.sample_rate, source.is_float
    width = 4 if fl else 2
    sizes = sorted({len(c) for _, c in chunks})
    total = sum(len(c) for _, c in chunks)
    el = chunks[-1][0] - chunks[0][0]
    emit(f"format claimed: {rate} Hz, {ch} channels, {'float32' if fl else 'int16'}; {len(chunks)} chunks, sizes {sizes[:5]} bytes")
    if el > 0.5:
        got = (total - len(chunks[0][1])) / width / ch / el
        emit(f"sound arrived at {got:.0f} frames/s (claimed {rate}) -> {'OK' if abs(got - rate) / rate < 0.05 else 'MISMATCH: wrong rate or gaps'}")
    dt = "<f4" if fl else "<i2"
    raw = [np.frombuffer(c[:len(c) // width * width], dtype=dt).astype(np.float32) / (1.0 if fl else 32768.0) for _, c in chunks]
    a = np.concatenate(raw)
    inter = a[:len(a) // ch * ch].reshape(-1, ch)
    emit(f"as interleaved {ch}-channel audio: left {rms_db(inter[:, 0]):.1f} dB, smoothness {ac1(inter[:, 0]):.3f}"
         + (f", right {rms_db(inter[:, 1]):.1f} dB, smoothness {ac1(inter[:, 1]):.3f}" if ch > 1 else ""))
    if ch > 1:
        planar = np.concatenate([r[:len(r) // ch] for r in raw])
        emit(f"as planar (all left, then all right, per chunk): left smoothness {ac1(planar):.3f}")
        si, sp = ac1(inter[:, 0]), ac1(planar)
        if abs(si - sp) < 0.02:
            emit("-> cannot tell the layout from this sound (smoothness alike): play something loud and rich, speech or music; and listen to probe.wav")
        else:
            emit(f"-> real audio is smooth (close to 1.0): this capture looks {'interleaved (normal)' if si > sp else 'PLANAR (all left, then all right): the reader must be told'}")
    write_wav(path, a, rate, ch, fl)
    emit(f"raw capture saved to {path} ({len(a) / ch / rate:.1f} s) - listen to it: this is what the capture library delivers")
    return 0


def proctap_info(emit):
    """What the installed proc-tap offers (constructor, config fields, and every hint about include / exclude / process tree)."""
    import dataclasses
    import importlib.metadata as md
    import inspect
    import os
    import re
    import proctap
    try:
        ver = md.version("proc-tap")
    except Exception:
        ver = "?"
    emit(f"proc-tap {ver}  at {os.path.dirname(proctap.__file__)}")
    emit("exports: " + ", ".join(n for n in dir(proctap) if not n.startswith("_")))
    for name in ("ProcessAudioCapture", "ProcTap"):
        cls = getattr(proctap, name, None)
        if cls is None:
            continue
        try:
            emit(f"{name}{inspect.signature(cls)}")
        except Exception as e:
            emit(f"{name}: signature unreadable ({e})")
        emit("  methods: " + ", ".join(n for n in dir(cls) if not n.startswith("_")))
        emit("  doc: " + " ".join((inspect.getdoc(cls) or "").split())[:400])
    cfg = getattr(proctap, "StreamConfig", None)
    if cfg is not None:
        try:
            emit("StreamConfig fields: " + str([(f.name, f.default) for f in dataclasses.fields(cfg)]))
        except Exception:
            emit(f"StreamConfig{inspect.signature(cfg)}")
    pat = re.compile(r"exclude|include|tree|loopback_mode|LOOPBACK", re.I)
    shown = 0
    base = os.path.dirname(proctap.__file__)
    for root, _, files in os.walk(base):
        for f in files:
            path = os.path.join(root, f)
            rel = os.path.relpath(path, base)
            try:
                if f.endswith(".py"):
                    for i, line in enumerate(open(path, encoding="utf-8", errors="replace"), 1):
                        if pat.search(line) and shown < 60:
                            shown += 1
                            emit(f"  {rel}:{i}: {line.strip()[:150]}")
                elif f.endswith((".pyd", ".dll", ".so")):
                    data = open(path, "rb").read()
                    hits = sorted({m.decode("ascii", "replace") for m in re.findall(rb"[A-Z_a-z]*(?:EXCLUDE|INCLUDE|TREE|LOOPBACK_MODE)[A-Z_a-z]*", data)})
                    emit(f"  {rel}: strings {hits[:20]}")
            except Exception as e:
                emit(f"  {rel}: unreadable ({e})")
    if not shown:
        emit("  (no include / exclude lines in the Python files)")
    try:                                                      # the native part and the Windows backend that calls it
        from proctap import _native
        emit("_native: " + ", ".join(n for n in dir(_native) if not n.startswith("__")))
        pl = getattr(_native, "ProcessLoopback", None)
        if pl is not None:
            emit("  ProcessLoopback doc: " + " ".join((inspect.getdoc(pl) or "(none)").split())[:600])
            emit("  ProcessLoopback attributes: " + ", ".join(n for n in dir(pl) if not n.startswith("__")))
            try:
                emit("  signature: " + str(inspect.signature(pl)))
            except Exception as e:
                emit(f"  signature unreadable ({e})")
    except Exception as e:
        emit(f"_native not readable: {e!r}")
    try:
        win = os.path.join(base, "backends", "windows.py")
        lines = open(win, encoding="utf-8", errors="replace").read().splitlines()
        emit("--- backends/windows.py (lines 25-140, blank lines left out) ---")
        for i, line in enumerate(lines[24:140], 25):
            if line.strip():
                emit(f"{i:>4}: {line[:140]}")
    except Exception as e:
        emit(f"windows.py not readable: {e!r}")
    return 0


def native_check(pid, emit):
    """Ask the compiled part of proc-tap directly: did Windows really give a capture of THIS process, or of everything?"""
    import platform
    import sys
    try:
        v = sys.getwindowsversion()
        emit(f"Windows {platform.release()}, build {v.build} (Microsoft documents the process capture API for build 20348 or later; "
             f"Windows 11 starts at 22000)")
    except Exception:
        emit(f"OS: {platform.platform()} (not Windows?)")
    try:
        from proctap._native import ProcessLoopback
    except Exception as e:
        emit(f"native part cannot be loaded: {e!r}")
        return 1
    n = ProcessLoopback(pid)
    for name in ("get_format", "is_process_specific", "get_last_error"):
        try:
            emit(f"before start: {name}() = {getattr(n, name)()!r}")
        except Exception as e:
            emit(f"before start: {name}() failed: {e!r}")
    try:
        n.start()
        time.sleep(1.0)
        for name in ("is_process_specific", "get_last_error"):
            try:
                emit(f"after start:  {name}() = {getattr(n, name)()!r}")
            except Exception as e:
                emit(f"after start:  {name}() failed: {e!r}")
        n.stop()
    except Exception as e:
        emit(f"start failed: {e!r}")
    emit("-> is_process_specific() False (or an error code) means Windows did NOT give a capture of this process alone: the sound is everything on the output device.")
    return 0
