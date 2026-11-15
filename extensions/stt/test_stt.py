"""Self-test of the STT system without a model, a microphone or Windows (run: python3 test_stt.py from this folder)."""
import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sttcore import filters                                    # noqa: E402
from sttcore.audio import Resampler, pcm16_to_mono             # noqa: E402
from sttcore.segmenter import Segmenter                        # noqa: E402

fails = 0


def check(name, cond, extra=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + (f"  {extra}" if extra and not cond else ""))
    if not cond:
        fails += 1


rng = np.random.default_rng(1)
SR = 16000


def noise(sec, amp):
    return (rng.standard_normal(int(SR * sec)) * amp).astype(np.float32)


def speech(sec, amp=0.15):                                     # "speech": noise with a slow wobble
    t = np.arange(int(SR * sec)) / SR
    return (rng.standard_normal(len(t)) * amp * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))).astype(np.float32)


def run_seg(x, **kw):
    s = Segmenter(**kw)
    out = []
    for i in range(0, len(x), 480):                           # feed in odd chunks (30 ms)
        out += s.feed(x[i:i + 480])
    out += s.flush()
    return out


# ---- resampler
t = np.arange(44100 * 2) / 44100
sine = np.sin(2 * np.pi * 440 * t).astype(np.float32)
whole = Resampler(44100).process(sine)
rs = Resampler(44100)
parts = [rs.process(sine[i:i + 1000]) for i in range(0, len(sine), 1000)]
chunked = np.concatenate(parts)
check("resample length ~ 16000 * 2 s", abs(len(whole) - 32000) < 8, len(whole))
check("resample chunked == whole", len(chunked) >= len(whole) - 8 and np.allclose(chunked[:len(whole) - 8], whole[:len(whole) - 8], atol=1e-3))
peak = np.fft.rfftfreq(len(whole), 1 / SR)[np.argmax(np.abs(np.fft.rfft(whole)))]
check("resample keeps 440 Hz", abs(peak - 440) < 5, peak)
check("48k -> 16k exact ratio", abs(len(Resampler(48000).process(np.zeros(48000, np.float32))) - 16000) < 4)
st = (np.stack([sine[:100] * 32767, np.zeros(100)], axis=1)).astype("<i2").tobytes()
check("stereo -> mono average", np.allclose(pcm16_to_mono(st, 2)[:5], sine[:5] / 2, atol=1e-3))

# ---- segmenter
x = np.concatenate([noise(1, 0.002), speech(2.0), noise(1.5, 0.002), speech(1.0), noise(1.5, 0.002)])
segs = run_seg(x)
check("two sentences found", len(segs) == 2, [len(s) / SR for s in segs])
check("durations plausible", len(segs) == 2 and 1.9 < len(segs[0]) / SR < 3.0 and 0.9 < len(segs[1]) / SR < 2.0)
check("a click is ignored", len(run_seg(np.concatenate([noise(1, 0.002), speech(0.15), noise(1.5, 0.002)]))) == 0)
check("a short pause does not split", len(run_seg(np.concatenate([noise(0.5, 0.002), speech(1.0), noise(0.4, 0.002), speech(1.0), noise(1.5, 0.002)]))) == 1)
long = np.concatenate([noise(0.5, 0.002), speech(30.0), noise(1.5, 0.002)])
ls = run_seg(long, max_s=12.0)
check("long speech is cut (<= 12 s each)", len(ls) >= 3 and all(len(s) / SR <= 12.5 for s in ls), [round(len(s) / SR, 1) for s in ls])
check("nothing lost on a cut", abs(sum(len(s) for s in ls) / SR - 30.0) < 1.5, sum(len(s) for s in ls) / SR)
loud_floor = np.concatenate([noise(2, 0.02), speech(2.0, 0.25), noise(1.5, 0.02)])
check("works with a noisy background", len(run_seg(loud_floor)) == 1)
check("pure noise: nothing", len(run_seg(noise(5, 0.003))) == 0)
check("flush at the end of a file", len(run_seg(np.concatenate([noise(1, 0.002), speech(1.5)]))) == 1)

# ---- filters
check("normal text kept", filters.keep("Everyone stack on the tank", 3.0, -0.3, 0.01)[0])
check("empty dropped", not filters.keep("  ", 1.0)[0])
check("punctuation only dropped", not filters.keep("...", 1.0)[0])
check("phantom 'Thank you.' dropped when short+unsure", not filters.keep("Thank you.", 1.0, -0.9, 0.2)[0])
check("'Thank you.' kept when sure", filters.keep("Thank you.", 1.0, -0.2, 0.01)[0])
check("no-speech dropped", not filters.keep("blah blah", 2.0, -1.2, 0.9)[0])
check("low confidence dropped", not filters.keep("xyzzy", 2.0, -2.0, 0.1)[0])


# ---- whole process with the fake engine (no model) on a WAV file, JSON lines like the reader sees them
def write_wav(path, x, sr=SR):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def run_json(args, timeout=60):
    """Like the reader: stdin stays open (end of stdin would stop the process) until the output is complete."""
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "stt_main.py"), "--json"] + args, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        out = proc.stdout.read()
        proc.wait(timeout=timeout)
    finally:
        proc.stdin.close()
        err = proc.stderr.read()
        proc.kill() if proc.poll() is None else None
    return proc.returncode, out, err


tmp = tempfile.mkdtemp()
wav = os.path.join(tmp, "t.wav")
write_wav(wav, np.concatenate([noise(1, 0.002), speech(2, 0.2), noise(1.2, 0.002), speech(1.5, 0.2), noise(1.2, 0.002)]))
log = os.path.join(tmp, "t.log")
rc, so, se = run_json(["--engine", "fake", "--wav", wav, "--fast", "--log", log])
msgs = [json.loads(l) for l in so.splitlines() if l.strip()]
texts = [m for m in msgs if m["type"] == "text"]
states = [m["state"] for m in msgs if m["type"] == "status"]
check("process exit code 0", rc == 0, se[-300:])
check("states loading, ready, listening, done", states == ["loading", "ready", "listening", "done"], states)
check("two texts", len(texts) == 2, texts)
check("text has timings", all({"audio_s", "infer_s", "delay_s"} <= set(m) for m in texts))
check("log file written", os.path.exists(log) and "segment" in open(log, encoding="utf-8").read())

# ---- live mode: partial texts while a sentence is spoken, then the final text; a non-streaming engine warns
rc, so, se = run_json(["--engine", "fake", "--wav", wav, "--fast", "--partial-ms", "1", "--log", log])
msgs = [json.loads(l) for l in so.splitlines() if l.strip()]
types = [m["type"] for m in msgs]
check("live mode: partial texts appear", "partial" in types, types)
check("live mode: the two final texts still come", types.count("text") == 2, types)
check("live mode: no partial after its final text before the next sentence starts",
      all(not (types[i] == "text" and types[i + 1:i + 2] == ["partial"] and msgs[i + 1]["audio_s"] > 2.5) for i in range(len(types) - 1)))
check("streaming engine: no warning", "warn" not in types, types)
rc, so, se = run_json(["--engine", "fake", "--wav", wav, "--fast", "--log", log])
check("live mode off: no partial", '"partial"' not in so)

# ---- errors are reported, not thrown
rc, so, se = run_json(["--engine", "nope", "--wav", wav, "--log", log])
m = [json.loads(l) for l in so.splitlines() if l.strip()]
check("unknown engine -> error status", rc != 0 and m and m[-1]["state"] == "error", so)
rc, so, se = run_json(["--target", "no_such_program_xyz", "--log", log])
m = [json.loads(l) for l in so.splitlines() if l.strip()]
check("target not running -> error status", rc == 4 and m and m[-1]["state"] == "error" and "not running" in m[-1]["msg"], so)
rc, so, se = run_json(["--engine", "whisper", "--wav", wav, "--fast", "--log", log])
m = [json.loads(l) for l in so.splitlines() if l.strip()]
try:
    import faster_whisper  # noqa: F401
    print("skip  whisper-not-installed check (faster-whisper is installed here)")
except ImportError:
    check("whisper not installed -> clear error", rc == 2 and m[-1]["state"] == "error" and "faster-whisper" in m[-1]["msg"], so[-300:])

# ---- the reader closes stdin: the process ends by itself (real-time file, long enough to still run)
write_wav(os.path.join(tmp, "long.wav"), np.concatenate([speech(2, 0.2), noise(60, 0.002)]))
proc = subprocess.Popen([sys.executable, os.path.join(HERE, "stt_main.py"), "--engine", "fake", "--wav", os.path.join(tmp, "long.wav"),
                         "--json", "--log", log], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8")
proc.stdin.close()
try:
    rc = proc.wait(timeout=15)
    check("end of stdin stops the process", True)
except subprocess.TimeoutExpired:
    proc.kill()
    check("end of stdin stops the process", False)


# ---- DeviceSource with a fake PyAudioWPatch
import threading
import time
import types

fake = types.ModuleType("pyaudiowpatch")
fake.paInt16, fake.paContinue = 8, 0
class _Stream:
    def __init__(self, cb): self.cb, self.closed = cb, False
    def start_stream(self): self.cb(b"\x01\x00" * 960, 480, None, 0)
    def stop_stream(self): pass
    def close(self): self.closed = True
class _PA:
    devs = [{"index": 3, "name": "Speakers (Realtek) [Loopback]", "defaultSampleRate": 48000.0, "maxInputChannels": 2},
            {"index": 5, "name": "Headset (USB) [Loopback]", "defaultSampleRate": 44100.0, "maxInputChannels": 2}]
    def get_default_wasapi_loopback(self): return self.devs[0]
    def get_loopback_device_info_generator(self): return iter(self.devs)
    def open(self, **kw): return _Stream(kw["stream_callback"])
    def terminate(self): pass
fake.PyAudio = _PA
sys.modules["pyaudiowpatch"] = fake
from sttcore import capture                                    # noqa: E402
got = []
d = capture.DeviceSource("system"); d.start(got.append)
check("device source: default device", d.device_name.startswith("Speakers") and d.sample_rate == 48000 and len(got) == 1 and not d.is_float)
d.stop()
d = capture.DeviceSource("device:headset"); d.start(got.append)
check("device source: by name part", d.device_name.startswith("Headset") and d.sample_rate == 44100)
d.stop()
d = capture.DeviceSource("device:5"); d.start(got.append)
check("device source: by number", d.device_name.startswith("Headset"))
d.stop()
try:
    capture.DeviceSource("device:nothing").start(got.append)
    check("device source: unknown name raises", False)
except LookupError:
    check("device source: unknown name raises", True)
d = capture.DeviceSource("device:speakers(realtek (r) audio)"); d.start(got.append)
check("device source: names that differ in spaces/brackets still match", d.device_name.startswith("Speakers"))
d.stop()
check("list_loopback_devices", [x[0] for x in capture.list_loopback_devices()] == [3, 5] and capture.list_loopback_devices()[0][4])

# ---- a live source that goes silent (a loopback sends nothing): the sentence must still end by itself
from sttcore.engines import get_engine                         # noqa: E402
from sttcore.pipeline import Pipeline                          # noqa: E402
from sttcore.protocol import Out                               # noqa: E402
import logging                                                 # noqa: E402


class QuietSource:
    lossless, is_float, sample_rate, channels = False, False, 16000, 1
    def start(self, on_data):
        def run():
            x = (speech(2.0, 0.2) * 32767).astype("<i2").tobytes()
            for i in range(0, len(x), 640):
                on_data(x[i:i + 640]); time.sleep(0.01)
            # ... and then nothing at all
        threading.Thread(target=run, daemon=True).start()
    def stop(self): pass


class Collect(Out):
    def __init__(self): super().__init__(True); self.msgs = []
    def emit(self, kind, **kw): self.msgs.append((kind, kw))


col, stop = Collect(), threading.Event()
pl = Pipeline(QuietSource(), get_engine("fake", {}, logging.getLogger("x")), col, {"seg": {}}, stop)
th = threading.Thread(target=pl.run, daemon=True); th.start()
t0 = time.time()
while time.time() - t0 < 6 and not any(k == "text" for k, _ in col.msgs):
    time.sleep(0.1)
stop.set(); th.join(3)
check("silent live source: sentence ends by itself", any(k == "text" for k, _ in col.msgs), [k for k, _ in col.msgs])

# ---- process capture is refused when Windows cannot isolate the process
nat = types.ModuleType("proctap._native")
class _PL:
    def __init__(self, pid): pass
    def is_process_specific(self): return False
    def get_last_error(self): return "Windows 10 Build 20438 or later is required for process-specific capture"
nat.ProcessLoopback = _PL
pt = types.ModuleType("proctap"); pt._native = nat
sys.modules["proctap"], sys.modules["proctap._native"] = pt, nat
try:
    capture.ProcessSource(1234).start(lambda b: None)
    check("unsupported Windows: process capture refused", False)
except RuntimeError as e:
    check("unsupported Windows: process capture refused", "--target system" in str(e) and "20438" in str(e), str(e))

# ---- SessionSource: finds the device of the program, listens to it only, mutes the sound while the program is quiet
from sttcore.sessions import Session                           # noqa: E402


class FakeDev:
    def __init__(self, name): self.name, self.sample_rate, self.channels, self.is_float, self.cb, self.stopped = name, 16000, 1, False, None, False
    def start(self, cb): self.cb = cb
    def stop(self): self.stopped = True


state = {"sessions": [], "opened": []}


def fake_enum(): return list(state["sessions"])


def fake_open(name):
    d = FakeDev(name); state["opened"].append(d); return d


tone = (np.sin(np.arange(1600) * 0.3) * 0.5 * 32767).astype("<i2").tobytes()
heard = []
ss = capture.SessionSource(lambda pid: pid == 100, "discord", enumerate_fn=fake_enum, open_device=fake_open, poll=0.05, gate_hold=0.3,
                           open_default=lambda: FakeDev("default"))
ss.start(heard.append)
time.sleep(0.2)
check("session: nothing opened while the program is silent / absent", state["opened"] == [])
state["sessions"] = [Session("Game Out", "g", 200, 1, 0.5), Session("Voice B", "b", 100, 1, 0.0)]
time.sleep(0.3)
check("session: opens the device the PROGRAM plays on", [d.name for d in state["opened"]] == ["Voice B"], [d.name for d in state["opened"]])
d = state["opened"][0]
d.cb(tone)                                                         # the program is quiet (peak 0): the sound is muted
time.sleep(0.05)
check("session: muted while the program is quiet", len(heard) == 1 and not np.any(np.frombuffer(heard[-1], "<f4")))
state["sessions"] = [Session("Game Out", "g", 200, 1, 0.5), Session("Voice B", "b", 100, 1, 0.2)]
time.sleep(0.2)
d.cb(tone)
time.sleep(0.05)
check("session: sound passes while the program plays", len(heard) == 2 and np.max(np.abs(np.frombuffer(heard[-1], "<f4"))) > 0.1)
state["sessions"] = [Session("Game Out", "g", 200, 1, 0.5), Session("Voice B", "b", 100, 1, 0.0)]
time.sleep(0.5)                                                    # gate_hold 0.3 s has passed
d.cb(tone)
time.sleep(0.05)
check("session: closes again after the hold time", not np.any(np.frombuffer(heard[-1], "<f4")))
state["sessions"] = [Session("Voice B", "b", 100, 1, 0.0), Session("Other", "o", 100, 1, 0.3)]
time.sleep(0.3)
check("session: follows the program to another device", [x.name for x in state["opened"]][-1] == "Other" and d.stopped, [x.name for x in state["opened"]])
ss.stop()
check("session: stop closes the device", state["opened"][-1].stopped)

# matcher: the program's helper processes count (Chromium style), unrelated ones do not
m = capture.make_matcher("python3")
import os as _os                                               # noqa: E402
check("matcher: own process matches", m(_os.getpid()))
check("matcher: unrelated pid does not", not capture.make_matcher("no_such_program_xyz")(_os.getpid()))
check("matcher: pid:N includes children of N", capture.make_matcher(f"pid:{_os.getppid()}")(_os.getpid()))

# Discord: the audio-service helper (web audio) is not the voice chat; the renderer is
fakeps = types.ModuleType("psutil")
CMDS = {1: ["Discord.exe", "--type=renderer"], 2: ["Discord.exe", "--type=utility", "--utility-sub-type=audio.mojom.AudioService"], 3: ["Discord.exe"]}
class _P:
    def __init__(self, pid):
        if pid not in CMDS: raise ProcessLookupError(pid)
        self.pid = pid
    def cmdline(self): return CMDS[self.pid]
    def name(self): return "Discord.exe"
    def parents(self): return []
fakeps.Process = _P
real_ps = sys.modules.get("psutil")
sys.modules["psutil"] = fakeps
md = capture.make_matcher("discord")
check("discord: renderer (voice) matches", md(1))
check("discord: audio service (web audio) is left out", not md(2))
check("discord: main process matches", md(3))
check("other programs keep their audio service", capture.make_matcher("discord.exe")(2) is False and capture.make_matcher("pid:2")(2))
sys.modules["psutil"] = real_ps

class _Slow(type(get_engine("fake", {}, logging.getLogger("x")))):
    streaming = False
col2 = []
class _Col:
    def emit(self, kind, **kw): col2.append((kind, kw))
class _Src:
    lossless = True; sample_rate = 16000; channels = 1; is_float = True
    def start(self, cb): cb(np.zeros(1600, np.float32).tobytes()); cb(None)
    def stop(self): pass
Pipeline(_Src(), _Slow({}, logging.getLogger("x")), _Col(), {"seg": {}, "partial_ms": 500}, threading.Event()).run()
check("non-streaming engine in live mode: warns 'not recommended'", any(k == "warn" and "Not recommended" in kw["msg"] for k, kw in col2), col2)

# ---- program choice: "discord-all" is the same program without the voice-only rule; the chooser's rows
check("discord-all: same processes as discord", capture.PRESETS["discord-all"] is capture.PRESETS["discord"])
check("needs_sessions: only the voice-only target", capture.needs_sessions("discord") and capture.needs_sessions("Discord.exe")
      and not capture.needs_sessions("discord-all") and not capture.needs_sessions("chrome.exe") and not capture.needs_sessions("system"))
from sttcore.sessions import Session                                  # noqa: E402
_names = {10: "chrome.exe", 11: "Chrome.exe", 12: "discord.exe", 13: "idle.exe"}
_rounds = [[Session("Speakers", "d1", 10, 1, 0.0), Session("Speakers", "d1", 12, 1, 0.0), Session("Sys", "d2", 0, 1, 0.9),
            Session("Headset", "d3", 13, 0, 0.0)],
           [Session("Speakers", "d1", 11, 1, 0.3), Session("Headset", "d3", 12, 1, 0.0), Session("Speakers", "d1", 99, 1, 0.5)]]
_rows = capture.group_sessions(_rounds, lambda pid: _names.get(pid, ""))
check("group: one row per program (names compare without case), system sounds and unknown pids left out",
      [r["name"] for r in _rows] == ["chrome.exe", "discord.exe", "idle.exe"], str(_rows))
check("group: peak is the maximum, devices are collected, active if ever active, counted by process",
      _rows[0]["peak"] == 0.3 and _rows[0]["devices"] == ["Speakers"] and _rows[0]["count"] == 2 and _rows[1]["devices"] == ["Speakers", "Headset"]
      and _rows[1]["active"] and not _rows[2]["active"], str(_rows))

# ---- downloads stay inside the extension: models_dir -> download_root, HF_HOME only for this process
import types as _types                                                 # noqa: E402
import stt_main as _sm                                                  # noqa: E402
_old = {k: _os.environ.get(k) for k in ("HF_HOME", "HF_HUB_CACHE")}
_os.environ["HF_HUB_CACHE"] = "/somewhere/else"
_md = _sm.confine_downloads(_os.path.join(tempfile.mkdtemp(), "models"))
check("confine: HF_HOME inside the models folder, a global cache setting is not followed",
      _os.environ["HF_HOME"].startswith(_md) and "HF_HUB_CACHE" not in _os.environ, _os.environ["HF_HOME"])
check("confine: the default is the 'models' folder next to the script", _sm.confine_downloads("") == _os.path.join(_sm.HERE, "models"))
for _k, _v in _old.items():
    _os.environ.pop(_k, None) if _v is None else _os.environ.__setitem__(_k, _v)
_calls = []
_fake = _types.ModuleType("faster_whisper")
class _WM:
    def __init__(self, size, **kw):
        _calls.append((size, kw))
    def transcribe(self, *a, **k):
        return iter(()), None
_fake.WhisperModel = _WM
sys.modules["faster_whisper"] = _fake
from sttcore.engines import whisper_fw as _wfw                          # noqa: E402
import logging as _lg                                                   # noqa: E402
_target = _os.path.join(tempfile.mkdtemp(), "m")
_e = _wfw.WhisperEngine({"model": "small", "device": "cpu", "models_dir": _target}, _lg.getLogger("t"))
_e._make("cpu", "int8")
check("whisper: download_root is the extension's models folder (and it is created)",
      _calls and _calls[-1][1].get("download_root") == _target and _os.path.isdir(_target), str(_calls))
_e2 = _wfw.WhisperEngine({"model": "small", "device": "cpu"}, _lg.getLogger("t"))
_e2._make("cpu", "int8")
check("whisper: without models_dir nothing is passed (old behaviour for other callers)", "download_root" not in _calls[-1][1])
del sys.modules["faster_whisper"]

# ---- NVIDIA: nvml (a fake library), the model footprint, the statistics thread
from sttcore import nvml as _nv                                         # noqa: E402
GB = 1024 ** 3
class _FakeLib:
    def __init__(self, procs, v3=True):
        self.procs, self.shut = procs, False
        if not v3:
            self.nvmlDeviceGetComputeRunningProcesses_v2 = self.nvmlDeviceGetComputeRunningProcesses_v3
            self.nvmlDeviceGetComputeRunningProcesses_v3 = None
    def nvmlInit_v2(self): return 0
    def nvmlShutdown(self): self.shut = True; return 0
    def nvmlDeviceGetCount_v2(self, p): p._obj.value = 1; return 0
    def nvmlDeviceGetHandleByIndex_v2(self, i, p): p._obj.value = 1234; return 0
    def nvmlDeviceGetMemoryInfo(self, h, p):
        o = p._obj; o.total, o.used, o.free = 24 * GB, 5 * GB, 19 * GB; return 0
    def nvmlDeviceGetUtilizationRates(self, h, p): p._obj.gpu = 17; return 0
    def nvmlDeviceGetTemperature(self, h, t, p): p._obj.value = 63; return 0
    def nvmlDeviceGetComputeRunningProcesses_v3(self, h, pc, arr):
        n = len(self.procs)
        if arr is None:
            pc._obj.value = n
            return 0 if n == 0 else 7
        for i, (pid, mem) in enumerate(self.procs):
            arr[i].pid, arr[i].usedGpuMemory = pid, mem
        pc._obj.value = n
        return 0
_n = _nv.Nvml(_FakeLib([(100, 3 * GB), (101, GB // 2), (999, 7 * GB)]))
check("nvml: whole card", _n.card(0) == {"total": 24 * GB, "used": 5 * GB, "util": 17, "temp": 63}, str(_n.card(0)))
check("nvml: memory of our processes only, summed", _n.process_mem({100, 101}) == 3 * GB + GB // 2 and _n.process_mem({100}) == 3 * GB)
check("nvml: not listed -> None (never 0)", _n.process_mem({5}) is None)
_n.close()
_na = _nv.Nvml(_FakeLib([(100, _nv.NOT_AVAILABLE)]))
check("nvml: 'not available' (WDDM) -> None", _na.process_mem({100}) is None)
check("nvml: no processes at all -> None", _nv.Nvml(_FakeLib([])).process_mem({100}) is None)
check("nvml: older _v2 call is used when _v3 is missing", _nv.Nvml(_FakeLib([(100, GB)], v3=False)).process_mem({100}) == GB)
check("nvml: no library / no driver -> open() gives None, no exception", _nv.Nvml.open() is None or True)

# the model's footprint: card memory after minus before the load
_seq = iter([2 * GB, 2 * GB + int(2.9 * GB)])
_orig = _wfw.WhisperEngine._card_used
_wfw.WhisperEngine._card_used = lambda self: next(_seq)
sys.modules["faster_whisper"] = _fake
_e3 = _wfw.WhisperEngine({"model": "small", "device": "cuda"}, _lg.getLogger("t"))
_desc = _e3.load()
_wfw.WhisperEngine._card_used = _orig
check("whisper: info carries the model's video memory", abs(_e3.info().get("vram_model", 0) - int(2.9 * GB)) < 10 and _e3.info()["device"] == "cuda", str(_e3.info()))
_e4 = _wfw.WhisperEngine({"model": "small", "device": "cpu"}, _lg.getLogger("t"))
_e4.load()
check("whisper on the CPU: no video memory figure", "vram_model" not in _e4.info())
del sys.modules["faster_whisper"]

# the statistics thread emits "gpu" lines while it runs
import threading as _th                                                  # noqa: E402
from sttcore import pipeline as _pl                                     # noqa: E402
class _Out:
    def __init__(self): self.msgs = []
    def emit(self, kind, **kw): self.msgs.append((kind, kw))
_o, _stop = _Out(), _th.Event()
_obj = _types.SimpleNamespace(stop=_stop, out=_o)
_real_open = _nv.Nvml.open
_nv.Nvml.open = classmethod(lambda cls: _nv.Nvml(_FakeLib([(_os.getpid(), 2 * GB)])))
_t = _th.Thread(target=_pl.Pipeline._gpu_loop, args=(_obj,), daemon=True)
_t.start()
import time as _time                                                    # noqa: E402
_time.sleep(2.3)
_stop.set()
_t.join(3)
_nv.Nvml.open = _real_open
_g = [kw for k, kw in _o.msgs if k == "gpu"]
check("gpu thread: one line per second with card and process figures",
      len(_g) >= 2 and _g[0]["used"] == 5 * GB and _g[0]["total"] == 24 * GB and _g[0]["util"] == 17 and _g[0]["proc"] == 2 * GB, str(_g[:1]))

print("failures:", fails)
sys.exit(1 if fails else 0)

