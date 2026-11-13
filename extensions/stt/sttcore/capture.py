"""Where the sound comes from. A source gives raw PCM (16-bit little-endian, interleaved) to a callback.

ProcessSource   the sound of ONE program (Windows process loopback, through the package proc-tap): Discord, WoW ...
WavSource       a WAV file, played at real-time speed or as fast as possible - to test without Windows / without a voice chat
"""
import datetime
import logging
import re
import threading
import time
import wave

log = logging.getLogger("stt.capture")

# what the short names in --target mean (the program and the helper processes that belong to it share the sound)
PRESETS = {
    "discord": re.compile(r"^discord(ptb|canary|development)?(\.exe)?$", re.I),
    "wow": re.compile(r"^wow[\w\-]*(\.exe)?$", re.I),
}
PRESETS["discord-all"] = PRESETS["discord"]          # the same program, but ALL its sound (voice chat and the videos / sounds inside Discord)


def list_processes():
    import psutil
    out = []
    for p in psutil.process_iter(["pid", "name", "ppid", "create_time"]):
        try:
            out.append((p.info["pid"], p.info["name"] or "", p.info["ppid"], p.info["create_time"] or 0))
        except Exception:
            pass
    return out


def find_target(target):
    """--target discord | wow | name.exe | pid:1234  ->  (pid, name). Raises LookupError with a helpful message."""
    t = target.strip()
    if t.lower().startswith("pid:"):
        pid = int(t[4:])
        for p, n, _, _ in list_processes():
            if p == pid:
                return pid, n
        raise LookupError(f"no process with pid {pid}")
    pat = PRESETS.get(t.lower()) or re.compile("^" + re.escape(t.removesuffix(".exe")) + r"(\.exe)?$", re.I)
    procs = [x for x in list_processes() if pat.match(x[1])]
    if not procs:
        raise LookupError(f"'{target}' is not running (start it first; --list shows the programs that make sound)")
    pids = {x[0] for x in procs}
    roots = [x for x in procs if x[2] not in pids]            # the process whose parent is not one of its own kind
    roots.sort(key=lambda x: (_is_helper(x[0]), x[3]))        # a real program before a helper (--type=...), then the oldest
    pick = (roots or procs)[0]
    log.info("target %s -> pid %d (%s); %d processes of that name, %d top-level", target, pick[0], pick[1], len(procs), len(roots))
    return pick[0], pick[1]


def _is_helper(pid):
    """Chromium based programs (Chrome, Discord ...) start helper processes with --type=renderer / utility ... : not the program itself."""
    try:
        import psutil
        return any(a.startswith("--type=") for a in psutil.Process(pid).cmdline())
    except Exception:
        return False


def describe(target):
    """Lines that show what --target would pick and why (for --list --target X)."""
    import psutil
    t = target.strip()
    pat = PRESETS.get(t.lower()) or re.compile("^" + re.escape(t.removesuffix(".exe")) + r"(\.exe)?$", re.I)
    procs = [x for x in list_processes() if pat.match(x[1])]
    pids = {x[0] for x in procs}
    lines = [f"{len(procs)} process(es) named like '{target}':"]
    try:
        picked = find_target(target)[0]
    except LookupError:
        picked = None
    names = {x[0]: x[1] for x in list_processes()}
    for pid, name, ppid, ct in sorted(procs, key=lambda x: x[3]):
        try:
            pr = psutil.Process(pid)
            exe = pr.exe()
            kind = next((a for a in pr.cmdline() if a.startswith("--type=")), "(main)")
            started = datetime.datetime.fromtimestamp(ct).strftime("%m-%d %H:%M:%S")
        except Exception as e:
            exe, kind, started = f"? ({type(e).__name__})", "?", "?"
        top = "TOP" if ppid not in pids else "   "
        lines.append(f"{'->' if pid == picked else '  '} {pid:>7} {top} parent {ppid} ({names.get(ppid, '?')})  {kind:<28} {started}  {exe}")
    if picked:
        try:
            kids = psutil.Process(picked).children(recursive=True)
            other = sorted({k.name() for k in kids if not pat.match(k.name())})
            lines.append(f"children of {picked} that are NOT '{target}': {other or 'none'}")
        except Exception as e:
            lines.append(f"(children: {e})")
    return lines


def _load_proctap():
    """-> the capture class of the installed proc-tap, or a RuntimeError that says exactly what is wrong."""
    import sys
    try:
        import proctap
    except Exception as e:
        raise RuntimeError(f"proc-tap cannot be imported ({e!r}). Install it in this environment: pip install proc-tap")
    try:
        import importlib.metadata as md
        ver = md.version("proc-tap")
    except Exception:
        ver = "?"
    last = None
    for name in ("ProcessAudioCapture", "ProcTap"):           # proc-tap 1.x: ProcessAudioCapture; 0.x: ProcTap
        try:
            cls = getattr(proctap, name)
            if cls is not None:
                log.info("proc-tap %s: using %s", ver, name)
                return cls
        except Exception as e:                                # not there / a lazy import inside the package failed
            last = e
            log.debug("proc-tap %s: %s not available: %r", ver, name, e)
    exports = [n for n in dir(proctap) if not n.startswith("_")]
    raise RuntimeError(f"proc-tap {ver} is installed but its Windows capture class cannot be loaded ({last!r}). "
                       f"Python {sys.version.split()[0]}; the package offers: {exports}. "
                       f"(See the log for the full error; a Python newer than 3.12 may lack a ready-made build.)")


class ProcessSource:
    lossless = False                     # a live source: when the reader is slow, old sound is dropped, never waited for

    def __init__(self, pid):
        self.pid = pid
        self.sample_rate, self.channels = 48000, 2          # what proc-tap documents for Windows; corrected from get_format() / the first chunk
        self.is_float = True                                 # float32 (current proc-tap); older versions: 16-bit - found out from the first chunk
        self.tap = None
        self._on_data = None
        self._seen = False
        self._fmt_known = False
        self.finished = threading.Event()

    def _cb(self, pcm, frames):
        if not self._seen and pcm:
            self._seen = True
            if self._fmt_known:                              # get_format() told us: that wins
                log.info("first chunk: %d bytes (frames reported: %s); format from proc-tap: %s", len(pcm), frames,
                         "float32" if self.is_float else "int16")
            elif frames and frames > 0:                      # else: bytes per sample decides (4 = float32, 2 = 16-bit integer)
                bps = len(pcm) / (frames * self.channels)
                self.is_float = abs(bps - 4) < 0.01
                log.info("first chunk: %d bytes, %d frames -> %.1f bytes per sample (%s)", len(pcm), frames, bps,
                         "float32" if self.is_float else "int16")
            else:
                log.warning("first chunk: %d bytes, frames=%s and no format from proc-tap: assuming float32", len(pcm), frames)
        self._on_data(pcm)

    @staticmethod
    def supported(pid):
        """-> (True, "") when this Windows can capture one program alone, else (False, why)."""
        try:
            from proctap._native import ProcessLoopback
        except Exception as e:
            return False, f"proc-tap native part not available ({e!r})"
        try:
            n = ProcessLoopback(pid)
            return (True, "") if n.is_process_specific() else (False, n.get_last_error() or "process capture refused")
        except Exception as e:
            return False, repr(e)

    def _check_process_capture(self):
        """Windows 10 before build 20438 cannot capture one process: proc-tap then silently gives EVERYTHING on the output device
        (is_process_specific() is False). That must never pass as 'the sound of Discord'."""
        try:
            from proctap._native import ProcessLoopback
        except Exception:
            return                                            # (another version of the library: no way to ask)
        try:
            n = ProcessLoopback(self.pid)
            specific, why = n.is_process_specific(), n.get_last_error()
        except Exception as e:
            log.warning("could not ask proc-tap whether the capture is process-specific: %r", e)
            return
        log.info("process capture of pid %d: process-specific=%s %s", self.pid, specific, why or "")
        if not specific:
            raise RuntimeError(f"this Windows cannot capture the sound of one program ({why or 'process capture refused'}). "
                               "Use --target system (everything that plays on the output device) or --target device:<name> "
                               "(see --list-devices); with the Windows sound settings, Discord can be sent to a device of its own.")

    def start(self, on_data):
        self._on_data = on_data
        self._check_process_capture()
        cls = _load_proctap()
        try:
            from proctap import StreamConfig
            self.tap = cls(self.pid, StreamConfig(), on_data=self._cb)
        except (ImportError, TypeError):                     # another version of the library: no StreamConfig
            self.tap = cls(self.pid, on_data=self._cb)
        try:
            fmt = self.tap.get_format()
            log.info("proc-tap format: %r", fmt)
            get = (lambda k: fmt.get(k)) if isinstance(fmt, dict) else (lambda k: getattr(fmt, k, None))
            sr = get("sample_rate") or get("rate")
            ch = get("channels")
            if sr:
                self.sample_rate = int(sr)
            if ch:
                self.channels = int(ch)
            sf = str(get("sample_format") or "").lower()
            bits = get("bits_per_sample") or get("bits")
            if sf:
                self.is_float, self._fmt_known = ("float" in sf), True
            elif bits:
                self.is_float, self._fmt_known = (int(bits) == 32), True
        except Exception as e:
            log.warning("could not read the sound format from proc-tap (%s): assuming %d Hz, %d channels", e, self.sample_rate, self.channels)
        log.info("capture: %d Hz, %d channels", self.sample_rate, self.channels)
        self.tap.start()

    def stop(self):
        if self.tap is not None:
            for name in ("stop", "close"):
                try:
                    getattr(self.tap, name)()
                except Exception as e:
                    log.debug("tap.%s: %s", name, e)
            self.tap = None


def _alnum(name):
    return re.sub(r"[\W_]+", "", name.lower().replace("[loopback]", ""))


def list_loopback_devices():
    """[(index, name, rate, channels, is_default)] of the output devices whose sound can be captured (WASAPI loopback)."""
    import pyaudiowpatch as pa
    p = pa.PyAudio()
    try:
        try:
            default = p.get_default_wasapi_loopback()["index"]
        except Exception:
            default = None
        return [(d["index"], d["name"], int(d["defaultSampleRate"]), int(d["maxInputChannels"]), d["index"] == default)
                for d in p.get_loopback_device_info_generator()]
    finally:
        p.terminate()


class DeviceSource:
    """Everything that plays on one output device (Windows WASAPI loopback, through PyAudioWPatch). Works on every Windows 10 / 11.
    --target system = the default output device; --target device:<part of the name or the number from --list-devices>."""
    lossless = False
    is_float = False                                          # 16-bit integers

    def __init__(self, spec):
        self.spec = spec
        self.sample_rate, self.channels = 48000, 2
        self.pa = self.stream = None
        self.finished = threading.Event()
        self.device_name = ""

    def start(self, on_data):
        try:
            import pyaudiowpatch as pa
        except ImportError as e:
            raise RuntimeError("PyAudioWPatch is missing (pip install PyAudioWPatch): %s" % e)
        self.pa = pa.PyAudio()
        try:
            if self.spec.lower() == "system":
                dev = self.pa.get_default_wasapi_loopback()
            else:
                key = self.spec.split(":", 1)[1].strip()
                devs = list(self.pa.get_loopback_device_info_generator())
                if key.isdigit():
                    found = [d for d in devs if d["index"] == int(key)]
                else:
                    k = _alnum(key)                              # names differ in spaces / brackets between Windows and PortAudio
                    found = [d for d in devs if k and (k in _alnum(d["name"]) or _alnum(d["name"].replace("[Loopback]", "")) in k)]
                if not found:
                    raise LookupError(f"no output device matches '{key}' (see --list-devices)")
                dev = found[0]
            self.device_name = dev["name"]
            self.sample_rate, self.channels = int(dev["defaultSampleRate"]), int(dev["maxInputChannels"])
            log.info("loopback device %d '%s': %d Hz, %d channels", dev["index"], dev["name"], self.sample_rate, self.channels)

            def cb(in_data, frame_count, time_info, status):
                on_data(in_data)
                return (None, pa.paContinue)

            self.stream = self.pa.open(format=pa.paInt16, channels=self.channels, rate=self.sample_rate, input=True,
                                       input_device_index=dev["index"], frames_per_buffer=int(self.sample_rate * 0.02), stream_callback=cb)
            self.stream.start_stream()
        except Exception:
            self.stop()
            raise

    def stop(self):
        try:
            if self.stream is not None:
                self.stream.stop_stream()
                self.stream.close()
        except Exception as e:
            log.debug("stream stop: %s", e)
        try:
            if self.pa is not None:
                self.pa.terminate()
        except Exception as e:
            log.debug("pa terminate: %s", e)
        self.stream = self.pa = None


# Programs whose sound comes from two kinds of processes of which only one is what we want. Measured on a real machine (Discord, Electron):
#   voice chat                   -> a "renderer" process, on the output device chosen in Discord's own settings
#   video / web audio in Discord -> the "utility / audio service" process, on the system default device
# Roles (the command line) stay the same when the program restarts; process ids do not.
EXCLUDE_AUDIO_SERVICE = {"discord"}


def needs_sessions(target):
    """Does this target need the audio sessions (the program's helper processes are told apart there)? 'discord' = the voice chat only:
    per-process capture cannot leave out the helper that plays videos, so it is not used for it (on any Windows build)."""
    return (target or "").strip().lower().removesuffix(".exe") in EXCLUDE_AUDIO_SERVICE


def group_sessions(rounds, name_of):
    """Several readings of the audio sessions (each a list of Session) -> one row per PROGRAM for a chooser:
    [{"name": "chrome.exe", "devices": [...], "active": bool, "peak": 0..1, "count": n}], playing programs first.
    Rows without a process (the system sounds) are left out. name_of(pid) -> the program's file name or ''."""
    rows = {}
    for sessions in rounds:
        for s in sessions:
            if not s.pid:
                continue
            name = name_of(s.pid)
            if not name:
                continue
            r = rows.setdefault(name.lower(), {"name": name, "devices": [], "active": False, "peak": 0.0, "pids": set()})
            if s.device and s.device not in r["devices"]:
                r["devices"].append(s.device)
            r["active"] = r["active"] or s.state == 1
            r["peak"] = max(r["peak"], float(s.peak or 0.0))
            r["pids"].add(s.pid)
    out = []
    for r in rows.values():
        r["count"] = len(r.pop("pids"))
        out.append(r)
    out.sort(key=lambda r: (not (r["peak"] > 0.002), not r["active"], r["name"].lower()))
    return out


def is_audio_service(pid):
    """A Chromium helper process that plays web audio:  --type=utility --utility-sub-type=audio.mojom.AudioService"""
    try:
        import psutil
        cmd = psutil.Process(pid).cmdline()
    except Exception:
        return False
    return "--type=utility" in cmd and any(a.startswith("--utility-sub-type=") and "audio" in a.lower() for a in cmd)


def make_matcher(target):
    """--target discord / wow / name.exe / pid:N  ->  match(pid) -> bool: does this process belong to the program?
    (the process itself, or one of its parents: Chromium based programs play their sound in a helper process.)"""
    t = target.strip()
    if t.lower().startswith("pid:"):
        root = int(t[4:])
        pat = None
    else:
        root = None
        pat = PRESETS.get(t.lower()) or re.compile("^" + re.escape(t.removesuffix(".exe")) + r"(\.exe)?$", re.I)
    cache = {}
    skip_audio_service = t.lower().removesuffix(".exe") in EXCLUDE_AUDIO_SERVICE

    def match(pid):
        if pid in cache:
            return cache[pid]
        ok = False
        try:
            import psutil
            p = psutil.Process(pid)
            chain = [p] + p.parents()
            ok = any((c.pid == root) if root is not None else bool(pat.match(c.name())) for c in chain)
            if ok and skip_audio_service and is_audio_service(pid):
                ok = False                                  # e.g. a video played inside Discord: not the voice chat
        except Exception:
            ok = False
        cache[pid] = ok
        return ok
    return match


def _device_key(name):
    return re.sub(r"\s+", " ", name.lower().replace("[loopback]", "")).strip()


class SessionSource:
    """The sound of one PROGRAM on any Windows: finds the output device the program plays on (audio sessions), listens to that
    device only (loopback) and lets the sound through only while the program itself is audibly playing (its session peak), so the
    game's music on the same device is not recognised as speech. The user chooses nothing but the program.

    Delivers 16 kHz mono float32 (is_float True): the format does not change when the program moves to another device."""
    lossless = False
    is_float = True
    sample_rate = 16000
    channels = 1

    def __init__(self, match, label="", enumerate_fn=None, open_device=None, poll=0.25, gate_hold=1.0, gate_peak=0.002,
                 gate=True, lose_after=10.0, open_default=None):
        self.match, self.label = match, label
        self.open_default = open_default or (lambda: DeviceSource("system"))
        self.enumerate_fn = enumerate_fn
        self.open_device = open_device or (lambda name: DeviceSource("device:" + name))
        self.poll, self.gate_hold, self.gate_peak, self.use_gate, self.lose_after = poll, gate_hold, gate_peak, gate, lose_after
        self.finished = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._on_data = None
        self.dev = None                  # the DeviceSource that is open
        self.dev_name = None
        self._conv = None
        self.gate_until = 0.0
        self.last_seen = 0.0
        self.status = "waiting for the program to play sound"
        self._th = None
        self._warned_map = False
        self.peak_now = 0.0
        self.chunks = 0
        self._gate_was = False

    def debug_state(self):
        """One line for --meter: which device, is the gate open, how loud is the program (its session) right now."""
        gate = "open" if (not self.use_gate or time.monotonic() < self.gate_until) else "closed"
        return f"[{self.dev_name or 'no device yet'}] gate {gate}, program peak {self.peak_now:.3f}, chunks {self.chunks}"

    # ---------------------------------------------------------------- audio from the device
    def _make_converter(self, dev):
        from .audio import Resampler, pcm_to_mono
        rs = Resampler(dev.sample_rate)
        ch, fl = dev.channels, dev.is_float

        def conv(pcm):
            return rs.process(pcm_to_mono(pcm, ch, fl))
        return conv

    def _on_device_data(self, pcm):
        if pcm is None or self._conv is None:
            return
        self.chunks += 1
        y = self._conv(pcm)
        if not len(y):
            return
        if self.use_gate and time.monotonic() >= self.gate_until:
            y = y * 0.0                                       # the program is quiet: whatever else plays is not for us
        self._on_data(y.astype("<f4").tobytes())

    # ---------------------------------------------------------------- finding the device
    def _open(self, name):
        with self._lock:
            self._close_locked()
            try:
                dev = self.open_device(name)
                self._conv = None
                dev.start(self._on_device_data)               # (sample_rate / channels are known after start)
                self._conv = self._make_converter(dev)
                self.dev, self.dev_name = dev, name
                self.status = f"listening to '{name}'"
                log.info("session source: listening to output device '%s'", name)
            except LookupError as e:
                if not self._warned_map:
                    self._warned_map = True
                    log.warning("device '%s' has no loopback of that name (%s): using the default output device", name, e)
                self._open_default()
            except Exception:
                log.exception("could not open device '%s'", name)
                self.dev = None

    def _open_default(self):
        try:
            dev = self.open_default()
            self._conv = None
            dev.start(self._on_device_data)
            self._conv = self._make_converter(dev)
            self.dev, self.dev_name = dev, "(default output device)"
            self.status = "listening to the default output device"
        except Exception:
            log.exception("could not open the default output device")
            self.dev = None

    def _close_locked(self):
        if self.dev is not None:
            try:
                self.dev.stop()
            except Exception:
                log.exception("device stop failed")
        self.dev = self.dev_name = self._conv = None

    def _resolve(self, now):
        sessions = [s for s in self.enumerate_fn() if s.pid and self.match(s.pid) and s.state != 2]
        by_dev = {}
        for s in sessions:
            d = by_dev.setdefault(s.device, {"peak": 0.0, "active": False})
            d["peak"] = max(d["peak"], s.peak)
            d["active"] = d["active"] or s.state == 1
        current = self.dev_name if self.dev_name in by_dev else None
        loud = [n for n, d in by_dev.items() if d["peak"] > self.gate_peak]
        if by_dev:
            self.last_seen = now
        if current is None and self.dev is not None and self.dev_name != "(default output device)" and now - self.last_seen > self.lose_after:
            log.info("the program has no sound session any more: closing '%s'", self.dev_name)
            with self._lock:
                self._close_locked()
            self.status = "waiting for the program to play sound"
        want = None
        if current is None and by_dev:
            want = (loud or list(by_dev))[0]                  # first sight of the program: its (loudest) device
        elif current is not None and loud and current not in loud:
            want = loud[0]                                    # it started to play somewhere else
        if want is not None and want != self.dev_name:
            log.info("program sessions: %s", {k: (round(v["peak"], 3), v["active"]) for k, v in by_dev.items()})
            self._open(want)
        # the gate: open while the program is audible on the device we listen to
        self.peak_now = by_dev[self.dev_name]["peak"] if self.dev_name in by_dev else 0.0
        if self.peak_now > self.gate_peak:
            self.gate_until = now + self.gate_hold
        is_open = now < self.gate_until
        if is_open != self._gate_was:
            self._gate_was = is_open
            log.info("gate %s (program peak %.3f)", "OPEN" if is_open else "closed", self.peak_now)

    def _run(self):
        while not self._stop.is_set():
            try:
                self._resolve(time.monotonic())
            except Exception:
                log.exception("session poll failed")
                time.sleep(2.0)
            self._stop.wait(self.poll)
        with self._lock:
            self._close_locked()
        if hasattr(self.enumerate_fn, "close"):
            self.enumerate_fn.close()
        self.finished.set()

    def start(self, on_data):
        if self.enumerate_fn is None:
            try:
                from .sessions import SessionPoller
                import pycaw  # noqa: F401
            except ImportError as e:
                raise RuntimeError("pycaw is missing (pip install pycaw): %s" % e)
            self.enumerate_fn = SessionPoller()           # COM runs in a helper process (see sessions.py)
        self._on_data = on_data
        self._th = threading.Thread(target=self._run, name="sessions", daemon=True)
        self._th.start()

    def stop(self):
        self._stop.set()
        if self._th is not None:
            self._th.join(3)


class WavSource:
    lossless = True                      # a file: nothing may be dropped
    is_float = False

    def __init__(self, path, realtime=False):
        self.path, self.realtime = path, realtime
        with wave.open(path, "rb") as w:
            if w.getsampwidth() != 2:
                raise RuntimeError("only 16-bit PCM WAV files are supported (convert: ffmpeg -i in.mp3 -ar 16000 -ac 1 out.wav)")
            self.sample_rate, self.channels = w.getframerate(), w.getnchannels()
        self.finished = threading.Event()
        self._stop = threading.Event()
        self._th = None

    def start(self, on_data):
        self._th = threading.Thread(target=self._run, args=(on_data,), name="wav-source", daemon=True)
        self._th.start()

    def _run(self, on_data):
        chunk = int(self.sample_rate * 0.02)                 # 20 ms
        try:
            with wave.open(self.path, "rb") as w:
                while not self._stop.is_set():
                    pcm = w.readframes(chunk)
                    if not pcm:
                        break
                    on_data(pcm)
                    if self.realtime:
                        time.sleep(0.02)
        finally:
            self.finished.set()
            on_data(None)                                    # end marker

    def stop(self):
        self._stop.set()
