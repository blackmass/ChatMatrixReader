"""Self-test for voiceinstall: what is installed, the steps, a job with stub commands, and that only the right folders are ever deleted."""
import os
import sys
import tempfile
import time

import voice
import voiceinstall as vi

tmp = tempfile.mkdtemp()
voice.DIR = os.path.join(tmp, "stt")
os.makedirs(voice.DIR)
venv = os.path.join(voice.DIR, ".venv")

# ---- state
assert vi.state(venv) == "none"
os.makedirs(venv)
assert vi.state(venv) == "broken", "a folder without Whisper (an installation that was cut off)"
sp = os.path.join(venv, "lib", "python3.11", "site-packages")
os.makedirs(sp)
assert vi.state(venv) == "broken"
os.makedirs(os.path.join(sp, "faster_whisper"))
assert vi.state(venv) == "cpu"
os.makedirs(os.path.join(sp, "nvidia", "cublas"))
assert vi.state(venv) == "cpu", "one of the two CUDA libraries is not enough"
os.makedirs(os.path.join(sp, "nvidia", "cudnn"))
assert vi.state(venv) == "gpu"
assert vi.dir_size(venv) == 0 and vi.fmt_gb(3 * 1024 ** 3) == "3.0 GB" and vi.fmt_gb(200 * 1024 ** 2) == "200 MB"

# ---- the steps
steps = vi.plan("cpu", "PY", venv)
assert len(steps) == 2 and steps[0][1][:3] == ["PY", "-m", "venv"] and steps[1][1][-2:] == ["-r", vi.REQ_BASE], steps
assert "--no-input" in steps[1][1]
steps = vi.plan("gpu", "PY", venv)
assert len(steps) == 3 and steps[2][1][-1] == vi.REQ_GPU
steps = vi.plan("gpu_extra", "PY", venv)
assert len(steps) == 1 and steps[0][1][-1] == vi.REQ_GPU, "adding the GPU libraries does not touch the environment itself"
rm = vi.remove_gpu_steps(venv)
assert rm[0][1][-4:] == ["uninstall", "-y"] + vi.GPU_PACKAGES[:0] + vi.GPU_PACKAGES or rm[0][1][-3:] == ["-y"] + vi.GPU_PACKAGES, rm

# ---- which python
class R:
    def __init__(self, rc, out):
        self.returncode, self.stdout = rc, out
assert vi.pick_python((3, 11), exe="X") == ("X", "")
other = os.path.join(tmp, "py311.exe")
open(other, "w").close()
import shutil
shutil.which = lambda *a, **k: None      # the test machine may have a python3.11 of its own
tags = []
def fake(argv, **k):
    tags.append(argv[1])
    return R(0, (other + "\n").encode())
assert vi.pick_python((3, 15), run=fake, exe="X") == (other, "") and tags == ["-3.11"], "3.11 is looked for first"
assert vi.pick_python((3, 12), run=fake, exe="X") == (other, ""), "3.11 wins over the reader's 3.12"
assert vi.pick_python((3, 12), run=lambda *a, **k: R(1, b""), exe="X") == ("X", ""), "no 3.11: the reader's supported Python"
tags2 = []
def only312(argv, **k):
    tags2.append(argv[1])
    return R(0, (other + "\n").encode()) if argv[1] == "-3.12" else R(1, b"")
assert vi.pick_python((3, 15), run=only312, exe="X") == (other, "") and tags2 == ["-3.11", "-3.12"]
exe, why = vi.pick_python((3, 15), run=lambda *a, **k: R(1, b""), exe="X")
assert exe is None and "3.15" in why and "3.11" in why
def boom(*a, **k):
    raise OSError("no py launcher")
assert vi.pick_python((3, 15), run=boom, exe="X")[0] is None
assert vi.pick_python((3, 8), run=boom, exe="X")[0] is None, "too old"
# default install folder without the py launcher
if sys.platform == "win32":
    lad = os.path.join(tmp, "lad"); d = os.path.join(lad, "Programs", "Python", "Python311"); os.makedirs(d)
    open(os.path.join(d, "python.exe"), "w").close()
    old = os.environ.get("LocalAppData"); os.environ["LocalAppData"] = lad
    try:
        assert vi.find_python("3.11", run=boom) == os.path.join(d, "python.exe")
    finally:
        if old is None: del os.environ["LocalAppData"]
        else: os.environ["LocalAppData"] = old

# ---- failure texts
assert "인터넷" in vi.explain_failure("WARNING: Retrying ... Connection broken")
assert "공간" in vi.explain_failure("OSError: [Errno 28] No space left on device")
assert "파이썬" in vi.explain_failure("ERROR: No matching distribution found for ctranslate2")
assert vi.INSTALL_LOG in vi.explain_failure("something else")

# ---- a job with stub commands
vi.INSTALL_LOG = os.path.join(tmp, "install.log")
def run_job(job):
    ev = vi.Events()
    job.on_event = ev
    job.start()
    job.th.join(20)
    return ev.drain()
ok_steps = [("one", [sys.executable, "-c", "print('Collecting numpy')\nprint('Installing collected packages: numpy')"]),
            ("two", [sys.executable, "-c", "pass"])]
evs = run_job(vi.Job(ok_steps, None, venv))
kinds = [k for k, _ in evs]
assert kinds[0] == "step" and evs[-1] == ("done", (True, "")), evs
assert any(k == "detail" and "numpy" in p for k, p in evs) and ("step", "two") in evs, evs
assert os.path.isfile(vi.INSTALL_LOG) and "Collecting numpy" in open(vi.INSTALL_LOG, encoding="utf-8").read()

bad = [("one", [sys.executable, "-c", "pass"]),
       ("two", [sys.executable, "-c", "import sys\nprint('ERROR: No matching distribution found for x')\nsys.exit(1)"]),
       ("three", [sys.executable, "-c", "print('never')"])]
evs = run_job(vi.Job(bad, None, venv, clean_on_fail=True))
assert evs[-1][0] == "done" and evs[-1][1][0] is False and "파이썬" in evs[-1][1][1], evs
assert ("step", "three") not in evs, "stops at the first failing step"
assert not os.path.exists(venv), "a failed new installation is removed (no half installation)"
os.makedirs(venv)
evs = run_job(vi.Job(bad, None, venv, clean_on_fail=False))
assert os.path.isdir(venv), "without clean_on_fail the environment stays (adding the GPU libraries to a working one)"
evs = run_job(vi.Job([("x", ["/no/such/program"])], None, venv))
assert evs[-1][1][0] is False

slow = [("slow", [sys.executable, "-c", "import time; time.sleep(30)"])]
job = vi.Job(slow, None, venv)
ev = vi.Events()
job.on_event = ev
job.start()
time.sleep(0.8)
t0 = time.time()
job.cancel()
job.th.join(10)
assert time.time() - t0 < 8 and ev.drain()[-1][1][0] is False, "cancel ends the running command"

# ---- deleting: only the extension's own .venv
assert vi.is_safe_venv(venv)
assert not vi.is_safe_venv(tmp) and not vi.is_safe_venv(voice.DIR) and not vi.is_safe_venv(os.path.join(tmp, ".venv"))
os.makedirs(os.path.join(tmp, "other", ".venv"))
assert not vi.is_safe_venv(os.path.join(tmp, "other", ".venv")), "a folder called .venv somewhere else"
ok, msg = vi.remove_all(os.path.join(tmp, "other", ".venv"))
assert not ok and os.path.isdir(os.path.join(tmp, "other", ".venv"))
link = os.path.join(voice.DIR, "link")
try:
    os.symlink(tmp, link)
    assert not vi.is_safe_venv(link)
except OSError:
    pass
open(os.path.join(venv, "big.bin"), "wb").write(b"x" * 1000)
assert vi.remove_all(venv) == (True, "") and not os.path.exists(venv)
assert vi.remove_all(venv) == (True, ""), "nothing there is fine"

# ---- everything stays inside the extension's folder
assert "--no-cache-dir" in vi.plan("cpu", "PY", venv)[1][1], "pip's own download cache (in the user's profile) is off"
seen = []
probe = [("env", [sys.executable, "-c", "import os, sys\nprint('TMPDIR=' + os.environ['TEMP'])"])]
job = vi.Job(probe, None, venv)
env = job._env()
assert env["TEMP"] == env["TMP"] == env["TMPDIR"] == os.path.join(voice.DIR, ".tmp") and os.path.isdir(env["TEMP"])
open(os.path.join(env["TEMP"], "wheel.tmp"), "w").write("x")
evs = run_job(vi.Job(ok_steps, None, venv))
assert not os.path.exists(os.path.join(voice.DIR, ".tmp")), "the temporary folder is removed after the job"

# ---- the models: extension's own folder only
vi.MODELS = os.path.join(voice.DIR, "models")
assert vi.models_size() == 0 and vi.remove_models() == (True, 0)
os.makedirs(os.path.join(vi.MODELS, "models--Systran--faster-whisper-small", "blobs"))
open(os.path.join(vi.MODELS, "models--Systran--faster-whisper-small", "blobs", "m.bin"), "wb").write(b"y" * 700)
assert vi.models_size() == 700 and vi.is_safe_models(vi.MODELS)
assert not vi.is_safe_models(os.path.join(tmp, "models")) and not vi.is_safe_models(voice.DIR)
assert vi.remove_models(os.path.join(tmp, "elsewhere", "models")) == (True, 0)
os.makedirs(os.path.join(tmp, "other", "models"))
assert vi.remove_models(os.path.join(tmp, "other", "models")) == (False, 0) and os.path.isdir(os.path.join(tmp, "other", "models"))
assert vi.remove_models() == (True, 700) and not os.path.exists(vi.MODELS)

# the global Hugging Face cache is only measured, never deleted
cache = os.path.join(tmp, "hub")
for n in ("models--Systran--faster-whisper-small", "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo",
          "models--deepdml--faster-whisper-large-v3-turbo-ct2", "models--bert-base-uncased", "models--someone--whisper-large-ct2"):
    os.makedirs(os.path.join(cache, n, "blobs"))
    open(os.path.join(cache, n, "blobs", "m.bin"), "wb").write(b"y" * 500)
assert vi.legacy_models_size(cache) == 2000, "four Whisper folders, not the bert model"
assert not hasattr(vi, "model_dirs") and all(os.path.isdir(os.path.join(cache, n)) for n in os.listdir(cache))
print("test_voiceinstall OK")
