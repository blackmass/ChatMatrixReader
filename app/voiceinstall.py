"""Install and remove the voice recognition (Whisper) - the environment in extensions/stt/.venv - from inside the reader.

    state()                 "none" | "broken" | "cpu" | "gpu"      what is installed (looked up in the files, nothing is started)
    plan(kind)              the steps of an installation: kind "cpu" | "gpu" | "gpu_extra" (add the GPU libraries to a CPU installation)
    Job(steps, on_event)    runs steps in a thread without any window; on_event(kind, text): "step" / "detail" / "done"
    remove_gpu_steps()      the step that takes the GPU libraries out again
    remove_all()            deletes the .venv folder (only that folder: it is checked)
    models_size() / remove_models()   the downloaded Whisper models: extensions/stt/models (never the user's global Hugging Face cache)
    legacy_models_size()    models an earlier version of the reader left in the global cache (only reported, never touched)

EVERYTHING this module and the extension write stays inside extensions/stt: the .venv, the models, a temporary folder for pip (.tmp);
pip's own download cache is switched off (--no-cache-dir).

Python 3.11 is preferred for the environment (found through the "py" launcher or the default install folders); the reader's own Python is used
when it is 3.11 or the only supported one, and 3.12 / 3.13 / 3.10 are the fallbacks. Everything the pip commands print goes to chatmatrix_stt_install.log.
"""
import glob
import logging
import os
import queue
import re
import shutil
import stat
import subprocess
import sys
import threading

import paths
import voice
from i18n import tr

log = logging.getLogger("cmr.voiceinstall")

VENV = os.path.join(voice.DIR, ".venv")
REQ_BASE = os.path.join(voice.DIR, "requirements.txt")
REQ_GPU = os.path.join(voice.DIR, "requirements-gpu.txt")
GPU_PACKAGES = ["nvidia-cublas-cu12", "nvidia-cudnn-cu12"]
MODELS = os.path.join(voice.DIR, "models")
TMP = os.path.join(voice.DIR, ".tmp")
INSTALL_LOG = os.path.join(paths.ROOT, "chatmatrix_stt_install.log")
# download sizes in GB, estimates (shown as "about"): the basic packages, the CUDA libraries, the model that is fetched at the first start
SIZE_GB = {"cpu": 0.5, "gpu_extra": 2.0, "gpu": 2.5, "model": 1.6}
SUPPORTED = ((3, 9), (3, 13))          # Python versions the packages (ctranslate2, onnxruntime ...) are known to come for
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


# ------------------------------------------------------------------------------------------------ what is installed
def site_packages(venv=None):
    venv = venv or VENV
    hits = glob.glob(os.path.join(venv, "Lib", "site-packages")) + glob.glob(os.path.join(venv, "lib", "python*", "site-packages"))
    return hits[0] if hits else None


def state(venv=None):
    """none: no environment | broken: an environment without Whisper (an installation that was cut off) | cpu | gpu"""
    venv = venv or VENV
    if not os.path.isdir(venv):
        return "none"
    sp = site_packages(venv)
    if not sp or not os.path.isdir(os.path.join(sp, "faster_whisper")):
        return "broken"
    if os.path.isdir(os.path.join(sp, "nvidia", "cublas")) and os.path.isdir(os.path.join(sp, "nvidia", "cudnn")):
        return "gpu"
    return "cpu"


def has_nvidia():
    """Is there an NVIDIA driver (so that the GPU libraries are of any use)?"""
    if sys.platform == "win32":
        return os.path.exists(os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvcuda.dll"))
    return bool(shutil.which("nvidia-smi"))


def dir_size(path):
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        pass
    return total


def fmt_gb(n):
    return f"{n / 1024 ** 3:.1f} GB" if n >= 1024 ** 3 else f"{n / 1024 ** 2:.0f} MB"


# ------------------------------------------------------------------------------------------------ which Python
def reader_python():
    exe = sys.executable
    base = os.path.basename(exe).lower()
    if base == "pythonw.exe":
        alt = os.path.join(os.path.dirname(exe), "python.exe")
        if os.path.isfile(alt):
            return alt
    return exe


PREFERRED = ("3.11", "3.12", "3.13", "3.10")      # Python 3.11 first: that is the one the packages are tested with


def find_python(tag, run=subprocess.run):
    """The python.exe of version `tag` ("3.11"), found through the "py" launcher, the default install folders or the PATH; "" if none."""
    try:
        r = run(["py", "-" + tag, "-c", "import sys; print(sys.executable)"], capture_output=True, timeout=20, creationflags=NO_WINDOW)
        path = r.stdout.decode("utf-8", "replace").strip().splitlines()[-1] if r.returncode == 0 and r.stdout.strip() else ""
    except (OSError, subprocess.TimeoutExpired, IndexError):
        path = ""
    if path and os.path.isfile(path):
        return path
    short = tag.replace(".", "")
    cands = []
    if sys.platform == "win32":
        for base in (os.environ.get("LocalAppData"), os.environ.get("ProgramFiles"), os.environ.get("ProgramW6432")):
            if base:
                sub = os.path.join("Programs", "Python") if base == os.environ.get("LocalAppData") else "Python"
                cands.append(os.path.join(base, sub, "Python" + short, "python.exe"))
    else:
        found = shutil.which("python" + tag)
        if found:
            cands.append(found)
    return next((c for c in cands if os.path.isfile(c)), "")


def pick_python(version=None, run=subprocess.run, exe=None):
    """-> (python executable, "") or (None, reason in the user's language).
    Python 3.11 is preferred; the reader's own Python is used when it is 3.11 or (if there is no 3.11) within SUPPORTED;
    otherwise 3.12 / 3.13 / 3.10 are looked for."""
    version = tuple(version or sys.version_info[:2])
    exe = exe or reader_python()
    ok = SUPPORTED[0] <= version <= SUPPORTED[1]
    if version == (3, 11):
        return exe, ""
    path = find_python(PREFERRED[0], run)
    if path:
        return path, ""
    if ok:
        return exe, ""
    for tag in PREFERRED[1:]:
        path = find_python(tag, run)
        if path:
            return path, ""
    return None, tr("이 프로그램의 파이썬({ver})에는 음성 인식 패키지(onnxruntime, av 등)가 아직 없습니다.\n\n"
                   "파이썬 3.11을 python.org에서 추가로 설치한 뒤 다시 시도하세요. (설치할 때 'py launcher'를 체크하세요.)\n"
                   "지금 쓰는 파이썬을 지우거나 이 프로그램을 다시 설치할 필요는 없습니다. 3.11이 있으면 음성 인식 설치가 자동으로 찾아 씁니다.",
                   ver="%d.%d" % version)


# ------------------------------------------------------------------------------------------------ the steps
def _pip(vpy, *args):
    return [vpy, "-m", "pip", *args]


def plan(kind, python, venv=None):
    """-> [(label, argv)]. kind: cpu | gpu | gpu_extra."""
    venv = venv or VENV
    sub = os.path.join("Scripts", "python.exe") if sys.platform == "win32" else os.path.join("bin", "python")
    vpy = os.path.join(venv, sub)
    common = ["--disable-pip-version-check", "--no-input", "--no-cache-dir"]
    steps = []
    if kind in ("cpu", "gpu"):
        steps.append((tr("가상 환경을 만드는 중..."), [python, "-m", "venv", venv]))
        steps.append((tr("Whisper와 필요한 패키지를 설치하는 중..."), _pip(vpy, "install", *common, "-r", REQ_BASE)))
    if kind in ("gpu", "gpu_extra"):
        steps.append((tr("GPU 라이브러리(CUDA)를 설치하는 중..."), _pip(vpy, "install", *common, "-r", REQ_GPU)))
    return steps


def remove_gpu_steps(venv=None):
    venv = venv or VENV
    sub = os.path.join("Scripts", "python.exe") if sys.platform == "win32" else os.path.join("bin", "python")
    return [(tr("GPU 라이브러리를 지우는 중..."), _pip(os.path.join(venv, sub), "uninstall", "-y", *GPU_PACKAGES))]


def explain_failure(tail):
    t = (tail or "").lower()
    if "no space left" in t or "errno 28" in t or "not enough space" in t:
        return tr("디스크 공간이 부족합니다. 공간을 확보한 뒤 다시 시도하세요.")
    if any(w in t for w in ("getaddrinfo", "connection", "timed out", "timeout", "ssl", "proxy", "temporary failure")):
        return tr("패키지를 내려받지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.")
    if "no matching distribution" in t or "could not find a version" in t:
        return tr("이 컴퓨터의 파이썬에 맞는 패키지를 찾지 못했습니다 (파이썬 버전이 너무 새롭거나 오래되었을 수 있습니다).")
    if "permission" in t or "access is denied" in t:
        return tr("파일에 접근할 수 없습니다. 이 폴더에 쓸 수 있는지, 보안 프로그램이 막고 있지 않은지 확인하세요.")
    return tr("설치에 실패했습니다. 자세한 내용: {path}", path=INSTALL_LOG)


_COLLECT = re.compile(r"^(?:Collecting|Downloading|Using cached)\s+(\S+)")


class Job:
    """Runs the steps one after the other in a thread, without a window. Events: ("step", label) when a step starts,
    ("detail", text) what pip is doing (package names), ("done", (ok, message)) at the end (also after cancel())."""

    def __init__(self, steps, on_event, venv=None, clean_on_fail=False):
        self.steps, self.on_event = steps, on_event
        self.venv = venv or VENV
        self.clean_on_fail = clean_on_fail                 # a new environment that failed is removed (no half installations)
        self._cancel = threading.Event()
        self.proc = None
        self.th = None

    def start(self):
        self.th = threading.Thread(target=self._run, name="voice-install", daemon=True)
        self.th.start()

    def cancel(self):
        self._cancel.set()
        p = self.proc
        if p is not None:
            try:
                p.kill()
            except OSError:
                pass

    def _env(self):
        """pip writes its temporary files to the temp folder: that one is inside the extension's folder too (this process only)."""
        tmp = os.path.join(voice.DIR, ".tmp")
        os.makedirs(tmp, exist_ok=True)
        return dict(os.environ, TMP=tmp, TEMP=tmp, TMPDIR=tmp, PIP_NO_INPUT="1")

    def _log(self, text):
        try:
            with open(INSTALL_LOG, "a", encoding="utf-8") as f:
                f.write(text if text.endswith("\n") else text + "\n")
        except OSError:
            pass

    def _fail(self, msg):
        if self.clean_on_fail and os.path.isdir(self.venv):
            remove_all(self.venv)
        self._clean_tmp()
        self.on_event("done", (False, msg))

    def _clean_tmp(self):
        tmp = os.path.join(voice.DIR, ".tmp")
        if os.path.basename(tmp) == ".tmp" and os.path.isdir(tmp):
            shutil.rmtree(tmp, onerror=_rm_error)

    def _run(self):
        try:
            self._log("==== " + " | ".join(label for label, _ in self.steps))
            for label, argv in self.steps:
                if self._cancel.is_set():
                    return self._fail(tr("취소했습니다."))
                self.on_event("step", label)
                self._log("$ " + " ".join(argv))
                try:
                    self.proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                                 errors="replace", cwd=voice.DIR, creationflags=NO_WINDOW, env=self._env())
                except OSError as e:
                    self._log(repr(e))
                    return self._fail(explain_failure(str(e)))
                tail = []
                for line in self.proc.stdout:
                    line = line.rstrip()
                    self._log(line)
                    tail = (tail + [line])[-25:]
                    m = _COLLECT.match(line)
                    if m:
                        self.on_event("detail", tr("받는 중: {name}", name=m.group(1)))
                    elif line.startswith("Installing collected packages"):
                        self.on_event("detail", tr("설치하는 중..."))
                rc = self.proc.wait()
                self.proc = None
                if self._cancel.is_set():
                    return self._fail(tr("취소했습니다."))
                if rc != 0:
                    return self._fail(explain_failure("\n".join(tail)))
            self._clean_tmp()
            self.on_event("done", (True, ""))
        except Exception as e:                                # never leave the window waiting
            log.exception("installation failed")
            self._fail(str(e))


# ------------------------------------------------------------------------------------------------ removing
def _rm_error(func, path, _exc):
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except OSError:
        pass


def is_safe_venv(path):
    """Only the extension's own .venv may be deleted: the exact folder, nothing above it, no link that leads elsewhere."""
    try:
        real = os.path.realpath(path)
        return (os.path.basename(real) == ".venv" and real == os.path.realpath(os.path.join(voice.DIR, ".venv"))
                and not os.path.islink(path) and os.path.commonpath([real, os.path.realpath(voice.DIR)]) == os.path.realpath(voice.DIR))
    except (OSError, ValueError):
        return False


def remove_all(venv=None):
    """-> (ok, message)."""
    venv = venv or VENV
    if not os.path.exists(venv):
        return True, ""
    if not is_safe_venv(venv):
        return False, tr("지울 폴더가 올바르지 않아 중단했습니다: {path}", path=venv)
    for _ in range(3):
        shutil.rmtree(venv, onerror=_rm_error)
        if not os.path.exists(venv):
            return True, ""
    return False, tr("일부 파일을 지우지 못했습니다. 음성 인식이 꺼져 있는지 확인하고 다시 시도하세요: {path}", path=venv)


def legacy_cache():
    """The user's global Hugging Face cache (where models went before the reader stored them in its own folder)."""
    for key in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        if os.environ.get(key):
            return os.environ[key]
    home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    return os.path.join(home, "hub")


def _whisper_dirs(cache):
    out = []
    for d in glob.glob(os.path.join(cache, "models--*")):
        name = os.path.basename(d).lower()
        if os.path.isdir(d) and ("faster-whisper" in name or ("whisper" in name and "ct2" in name)):
            out.append(d)
    return out


def models_size(models=None):
    return dir_size(models or MODELS)


def legacy_models_size(cache=None):
    """Whisper models in the global cache: reported to the user, who may delete them by hand. This module never deletes there."""
    return sum(dir_size(d) for d in _whisper_dirs(cache or legacy_cache()))


def is_safe_models(path):
    try:
        real = os.path.realpath(path)
        return (os.path.basename(real) == "models" and real == os.path.realpath(os.path.join(voice.DIR, "models"))
                and not os.path.islink(path))
    except OSError:
        return False


def remove_models(models=None):
    """Deletes the extension's own models folder. -> (ok, freed bytes)."""
    models = models or MODELS
    if not os.path.exists(models):
        return True, 0
    if not is_safe_models(models):
        return False, 0
    n = dir_size(models)
    for _ in range(3):
        shutil.rmtree(models, onerror=_rm_error)
        if not os.path.exists(models):
            return True, n
    return False, 0


class Events:
    """A thread-safe box for the events of a Job: the window reads it from its own timer (Tk must not be touched from the thread)."""

    def __init__(self):
        self.q = queue.Queue()

    def __call__(self, kind, payload):
        self.q.put((kind, payload))

    def drain(self):
        out = []
        while True:
            try:
                out.append(self.q.get_nowait())
            except queue.Empty:
                return out
