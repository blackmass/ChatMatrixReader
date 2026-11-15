"""Self-test for voice.py (the child process is a small stub script) and for App.on_voice with a stand-in for the window."""
import os
import queue
import sys
import tempfile
import time
import types

import voice

# ---- the command line built from the settings
a = voice.build_args({"voice_target": "wow", "voice_lang": "ko", "voice_mode": "live", "voice_partial_ms": 800, "voice_device": "cuda",
                      "voice_model": "small", "voice_end_ms": 100}, python="PY", script="S")
assert a[:4] == ["PY", "-X", "utf8", "S"] and "--json" in a, a
assert a[a.index("--target") + 1] == "wow" and a[a.index("--lang") + 1] == "ko", a
assert a[a.index("--partial-ms") + 1] == "800" and a[a.index("--device") + 1] == "cuda" and a[a.index("--model") + 1] == "small", a
assert a[a.index("--end-ms") + 1] == "300", "end_ms is clamped to 300..2000"
b = voice.build_args({}, python="PY", script="S")
assert "--partial-ms" not in b and "--device" not in b and "--model" not in b, b
assert b[b.index("--target") + 1] == "discord" and b[b.index("--lang") + 1] == "auto", b
e = voice.build_args({"voice_target": "evil; rm"}, python="PY", script="S")
assert e[e.index("--target") + 1] == "discord"

# ---- a stub child: status, partial, text, then waits until stdin is closed
tmp = tempfile.mkdtemp()
stub = os.path.join(tmp, "stub.py")
open(stub, "w", encoding="utf-8").write('''
import sys, json, time
def out(**k): print(json.dumps(k, ensure_ascii=False), flush=True)
out(type="status", state="loading", msg="load")
out(type="status", state="ready", msg="ready", engine={"device": "cuda", "compute": "float16", "model": "m", "fallback": False})
out(type="status", state="listening", msg="listening to X")
out(type="partial", text="hel")
out(type="text", text="hello 안녕")
if "--die" in sys.argv:
    sys.exit(3)
for line in sys.stdin:
    pass
''')

def drain(q, until=None, timeout=5.0):
    got, end = [], time.time() + timeout
    while time.time() < end:
        try:
            k, m = q.get(timeout=0.1)
        except queue.Empty:
            continue
        got.append(m)
        if until and until(m):
            break
    return got

q = queue.Queue()
vm = voice.VoiceManager(q, lambda: {}, python=sys.executable, script=stub)
# build_args puts our options after the script: the stub ignores them
assert vm.state == "off" and not vm.running()
assert vm.start() and vm.running()
got = drain(q, until=lambda m: m.get("type") == "text")
types_ = [m["type"] for m in got]
assert types_ == ["status", "status", "status", "status", "partial", "text"], types_       # starting, loading, ready, listening
assert vm.engine_info.get("device") == "cuda", "the reader keeps how the engine runs"
assert got[-1]["text"] == "hello 안녕", got[-1]
assert vm.state == "listening" and vm.msg == "listening to X", (vm.state, vm.msg)
assert vm.start() is True and len([1 for _ in [0]]) == 1                  # already running: nothing new
vm.stop()
assert not vm.running() and vm.state == "off"
rest = drain(q, timeout=0.6)
assert any(m.get("type") == "off" for m in rest), "stop tells the indicator it is off"
assert not any(m["type"] == "exit" for m in rest), "a stop asked for is not reported as a crash: %r" % rest

# ---- the child dies by itself: an exit message with the code
vm2 = voice.VoiceManager(q, lambda: {}, python=sys.executable, script=stub)
orig = voice.build_args
voice.build_args = lambda cfg, python=None, script=None: [python, script, "--die"]
try:
    assert vm2.start()
    got = drain(q, until=lambda m: m.get("type") == "exit")
finally:
    voice.build_args = orig
ex = [m for m in got if m["type"] == "exit"]
assert ex and ex[0]["code"] == 3, got
assert vm2.state == "off"

# ---- not installed: an error message, no crash
vm3 = voice.VoiceManager(q, lambda: {}, python=os.path.join(tmp, "nope.exe"), script=stub)
assert vm3.start() is False and vm3.state == "error"
got = drain(q, until=lambda m: m.get("type") == "status")
assert got[-1]["state"] == "error" and got[-1]["msg"] == "not installed", got

if not os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.py")):
    print("voice ok (the App.on_voice part waits for the Qt window code)")
    raise SystemExit(0)

# ---- App.on_voice with a stand-in object (app.py itself needs Windows / macOS, so the two methods are taken out of its source)
import ast
from decoder import Line
from i18n import tr

src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.py"), encoding="utf-8").read()
cls = next(n for n in ast.parse(src).body if isinstance(n, ast.ClassDef) and n.name == "App")
wanted = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in ("_clear_partial", "on_voice")]
assert len(wanted) == 2
import time
ns = {"tr": tr, "Line": Line, "voice": voice, "time": time, "log": __import__("logging").getLogger("t")}
exec(compile(ast.Module(body=wanted, type_ignores=[]), "app.py", "exec"), ns)
shown, system = [], []

class Root:
    def after(self, ms, fn=None):
        return "job"
    def after_cancel(self, j):
        pass

class Status:
    def __init__(self): self.v = ""
    def set(self, v): self.v = v

import voicemeter
me = types.SimpleNamespace(vmodel=voicemeter.Model(), cfg={"voice_target": "discord"}, root=Root(), status=Status(), _cap_status="capture ok", _part_job=None, _voice_last_warn="",
                           _show_line=lambda line: shown.append(line), add_system=lambda msg, tag="system": system.append(msg))
me._clear_partial = lambda: ns["_clear_partial"](me)
on_voice = lambda m: ns["on_voice"](me, m)
on_voice({"type": "status", "state": "listening", "msg": ""})
on_voice({"type": "partial", "text": "hel"})
assert "hel" in me.status.v and me._part_job == "job", me.status.v
on_voice({"type": "text", "text": "hello"})
assert shown and shown[0].channel == "!VC" and shown[0].text == "hello" and me.status.v == "capture ok", (shown, me.status.v)
on_voice({"type": "text", "text": "   "})
assert len(shown) == 1, "an empty text is not shown"
n0 = len(system)
on_voice({"type": "warn", "code": "no_audio", "seconds": 8, "msg": "no sound"})
on_voice({"type": "status", "state": "listening", "msg": "listening to Discord.exe"})
on_voice({"type": "status", "state": "loading", "msg": "x"})
on_voice({"type": "level", "db": -20.0, "speech": True})
assert len(system) == n0, "warnings and ordinary status changes are not lines in the window: %r" % system[n0:]
assert me.vmodel.state == "active", me.vmodel.state
on_voice({"type": "status", "state": "error", "msg": "not installed"})
assert "Whisper" in system[-1] and "README" not in system[-1], system[-1]
assert me.vmodel.state == "error" and me.vmodel.err_code == "not_installed"
on_voice({"type": "exit", "code": 3})
assert "3" in system[-1] and me.vmodel.err_code == "exit"
# ---- recognition method "openai": command line, key, addresses, explanations, connection test
o = voice.build_args({"voice_engine": "openai", "voice_oa_url": " http://localhost:8000/v1 ", "voice_oa_model": "m1", "voice_oa_format": "verbose_json",
                      "voice_oa_timeout": 20, "voice_mode": "live", "voice_device": "cuda", "voice_model": "whisper-small",
                      "voice_max_s": 8, "voice_oa_key": "sk-secret"}, python="PY", script="S")
assert o[o.index("--engine") + 1] == "openai" and o[o.index("--url") + 1] == "http://localhost:8000/v1", o
assert o[o.index("--model") + 1] == "m1" and o[o.index("--response-format") + 1] == "verbose_json" and o[o.index("--timeout") + 1] == "20", o
assert "--partial-ms" not in o and "--device" not in o and "whisper-small" not in o, "no live mode / whisper settings with the openai method: %r" % o
assert o[o.index("--max-s") + 1] == "8", o
assert "sk-secret" not in " ".join(o), "the key is not on the command line"
assert voice.build_env({"voice_engine": "openai", "voice_oa_key": " sk-secret "}) == {voice.KEY_ENV: "sk-secret"}
assert voice.build_env({"voice_engine": "whisper", "voice_oa_key": "sk-secret"}) == {}, "the key is only given to the openai method"
assert voice.build_env({"voice_engine": "openai"}) == {}
w = voice.build_args({}, python="PY", script="S")
assert w[w.index("--max-s") + 1] == "12" and "--engine" not in w and "--url" not in w, w
assert voice.build_args({"voice_max_s": 999}, python="PY", script="S")[-1] == "30" or "30" in voice.build_args({"voice_max_s": 999}, python="PY", script="S")

for u, local in (("http://localhost:8000/v1", True), ("http://127.0.0.1:1/v1", True), ("http://192.168.0.5:8000/v1", True), ("http://10.1.2.3/v1", True),
                 ("https://api.openai.com/v1", False), ("http://8.8.8.8/v1", False), ("http://myserver.example.com/v1", False),
                 ("http://box.local:8000/v1", True), ("", False), ("not a url", False)):
    assert voice.is_local_url(u) is local, (u, local)
assert voice.url_host("http://localhost:8000/v1") == "localhost:8000"

assert "404" in voice.explain_error("[not_found] HTTP 404 x") and "x" in voice.explain_error("[not_found] HTTP 404 x")
assert "키" in voice.explain_error("[unauthorized] HTTP 401")
assert "연결" in voice.explain_error("recognition failed 5 times in a row - stopped ([no_connection] refused)"), "a code inside a longer text"
assert voice.explain_error("no engine") == "no engine" and voice.explain_error("") == ""

# connection test against a tiny local server, through the real stt_main.py
import http.server, threading
class OK(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        data = b'{"text": ""}'
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), OK)
threading.Thread(target=srv.serve_forever, daemon=True).start()
main_py = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extensions", "stt", "stt_main.py")
ok, text = voice.check_connection({"voice_oa_url": "http://127.0.0.1:%d/v1" % srv.server_address[1]}, python=sys.executable, script=main_py)
assert ok and "연결" in text, (ok, text)
ok, text = voice.check_connection({"voice_oa_url": "http://127.0.0.1:9/v1"}, python=sys.executable, script=main_py)
assert not ok and "연결할 수 없" in text, (ok, text)
ok, text = voice.check_connection({"voice_oa_url": "x"}, python=os.path.join(tmp, "nope.exe"), script=main_py)
assert not ok and "Whisper" in text, text
srv.shutdown()
print("ALL VOICE TESTS PASSED")

# ---- OptionsWindow._apply_voice: saving restarts a running recognition when its settings changed, nothing else
cls = next(n for n in ast.parse(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "options.py"), encoding="utf-8").read()).body
           if isinstance(n, ast.ClassDef) and n.name == "OptionsWindow")
fn = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "_apply_voice")
ns2 = {"logging": __import__("logging")}
exec(compile(ast.Module(body=[fn], type_ignores=[]), "options.py", "exec"), ns2)

class FakeVM:
    def __init__(self, running): self._r, self.state, self.calls = running, "listening" if running else "off", []
    def running(self): return self._r
    def start(self): self.calls.append("start"); self._r = True; self.state = "loading"
    def stop(self): self.calls.append("stop"); self._r = False; self.state = "off"
    def restart(self): self.calls.append("restart")

base = {"voice_enabled": True, "voice_target": "discord", "voice_lang": "auto", "voice_mode": "sentence", "voice_translate": True,
        "voice_end_ms": 700, "voice_device": "auto", "voice_model": ""}
def apply(running, old, **chg):
    vm = FakeVM(running)
    ns2["_apply_voice"](types.SimpleNamespace(app=types.SimpleNamespace(voice=vm)), old, dict(old, **chg))
    return vm.calls
assert apply(False, base) == [], "saving the options never turns it on"
assert apply(True, base) == [], "nothing changed: nothing happens"
assert apply(True, base, voice_lang="ko") == ["restart"]
assert apply(True, base, voice_translate=False) == [], "the translation switch needs no restart"
assert apply(False, base, voice_lang="ko") == [], "switched off: a changed language is simply used at the next start"
assert apply(False, dict(base, voice_enabled=False), voice_enabled=True) == [], "the check only counts at the next program start"
assert apply(True, base, voice_enabled=False) == [], "unchecking does not switch a running recognition off"
print("ALL VOICE APPLY TESTS PASSED")

# ---- which program: presets, a program of the user's own, nothing dangerous gets onto the command line
def tgt(cfg):
    a = voice.build_args(cfg, python="PY", script="S")
    return a[a.index("--target") + 1]
assert tgt({"voice_target": "discord-all"}) == "discord-all" and tgt({"voice_target": "system"}) == "system"
assert tgt({"voice_target": "app", "voice_app": "chrome.exe"}) == "chrome.exe"
assert tgt({"voice_target": "app", "voice_app": "My Game (x64).exe"}) == "My Game (x64).exe"
assert tgt({"voice_target": "app", "voice_app": ""}) == "discord", "no program chosen yet"
assert tgt({"voice_target": "app", "voice_app": "x.exe; del *"}) == "discord", "not a file name"
assert tgt({"voice_target": "app", "voice_app": "..\\evil.exe"}) == "discord"
assert voice.target_name({"voice_target": "app", "voice_app": "chrome.exe"}) == "chrome.exe"
assert voice.target_name({"voice_target": "discord-all"}) == "Discord" and voice.target_name({"voice_target": "wow"}) == "World of Warcraft"
assert set(voice.TARGETS) == {"discord", "discord-all", "wow", "system", "app"}

# ---- the program list: a stub child that answers like `stt_main.py --json --sessions`
import json as _json, os as _os, tempfile as _tf
_d = _tf.mkdtemp()
_stub = _os.path.join(_d, "stub.py")
open(_stub, "w").write("import json\nprint(json.dumps({'type':'sessions','items':[{'name':'chrome.exe','devices':['Speakers'],'active':True,'peak':0.2,'count':3},"
                       "{'name':'x','devices':[],'active':False,'peak':0,'count':1}, {'devices':[]}]}))\n")
import sys as _sys
rows, err = voice.list_sessions(python=_sys.executable, script=_stub)
assert err == "" and [r["name"] for r in rows] == ["chrome.exe", "x"], (rows, err)
rows, err = voice.list_sessions(python=_sys.executable, script=_os.path.join(_d, "missing.py"))
assert rows == [] and err
open(_stub, "w").write("print('no json here')\n")
rows, err = voice.list_sessions(python=_sys.executable, script=_stub)
assert rows == [] and err
open(_stub, "w").write("import json\nprint(json.dumps({'type':'sessions','items':[],'error':'boom'}))\n")
rows, err = voice.list_sessions(python=_sys.executable, script=_stub)
assert rows == [] and "boom" in err
print("test_voice: program choice OK")

# ---- "compute device" line
assert voice.describe_device({}, False) == ("-", False)
assert voice.describe_device({}, True)[1] is False and voice.describe_device({}, True)[0] != "-"
t, w = voice.describe_device({"device": "cuda", "compute": "float16", "model": "large-v3-turbo"}, True)
assert t.startswith("GPU") and "float16" in t and "large-v3-turbo" in t and not w, t
t, w = voice.describe_device({"device": "cpu", "compute": "int8", "model": "small", "fallback": False}, True)
assert t.startswith("CPU") and "int8" in t and not w, t
t, w = voice.describe_device({"device": "cpu", "compute": "int8", "model": "small", "fallback": True}, True)
assert t.startswith("CPU") and w, "the GPU was wanted but did not work: a warning"
vm.stop()
assert vm.engine_info == {}
print("test_voice: device line OK")

# ---- the GPU / VRAM lines: only what this recognition itself uses; unknown = "not measurable", never 0, never the whole card
GB = 1024 ** 3
now = 100.0
gt, vt = voice.gpu_lines({"used": 19 * GB, "total": 24 * GB, "util": 15, "proc": None, "t": 99.0}, "", None, now)
assert gt == vt and not gt[0].isdigit() and "19" not in vt, (gt, vt)             # the card's figures are never shown
gt, vt = voice.gpu_lines({"proc": int(3.1 * GB), "t": 99.0}, "4% (최대 20%)", None, now)
assert gt.startswith("4%") and "3.1 GB" in vt, (gt, vt)
gt, vt = voice.gpu_lines({"proc": int(3.1 * GB), "t": 90.0}, "", 1 * GB, now)      # the driver figure is too old: the counters
assert "1.0 GB" in vt, vt
gt, vt = voice.gpu_lines({}, "", None, now)
assert gt == vt and not gt[0].isdigit(), (gt, vt)
print("test_voice: gpu lines OK")

# ---- the speaker button / start without an installation: what is said, and a cut-off installation counts as not installed
import tempfile as _tf
_old_dir = voice.DIR
_old_script, _old_venv = voice.SCRIPT, None
import voiceinstall as _vi0
_old_venv = _vi0.VENV
with _tf.TemporaryDirectory() as _d:
    voice.DIR = _d
    try:
        assert "설치하기" in voice.missing({}) and "끝나지" not in voice.missing({})
        os.makedirs(os.path.join(_d, ".venv", "Scripts")); os.makedirs(os.path.join(_d, ".venv", "bin"))
        for _n in (os.path.join("Scripts", "python.exe"), os.path.join("bin", "python")):
            open(os.path.join(_d, ".venv", _n), "w").close()
        open(os.path.join(_d, "stt_main.py"), "w").close()
        voice.SCRIPT = os.path.join(_d, "stt_main.py")
        import voiceinstall as _vi
        _vi.VENV = os.path.join(_d, ".venv")
        assert "끝나지" in (voice.missing({}) or ""), "environment without the package = cut off"
        assert voice.missing({"voice_engine": "openai"}) is None, "an OpenAI server needs no Whisper package"
    finally:
        voice.DIR, voice.SCRIPT, _vi0.VENV = _old_dir, _old_script, _old_venv
print("test_voice: missing OK")
