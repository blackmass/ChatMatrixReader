"""Voice recognition (optional extension): runs extensions/stt/stt_main.py as a hidden child process and passes what it says to the
reader through the same queue the other background threads use.

    VoiceManager(q, cfg_getter).start() / .stop() / .restart()        q gets  ("voice", {"type": ..., ...})
        types: status (state loading/ready/listening/stopped/error, msg), text, partial, warn, level, exit (code)
    installed()      the extension's own Python environment exists (extensions/stt/.venv)

The reader never imports the heavy packages (Whisper, CUDA ...): they live in the extension's own .venv, so a missing or broken
installation can never stop the reader. The child ends by itself when this process dies (it watches its stdin).
"""
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import ipaddress

import paths
import resmeter
from i18n import tr

log = logging.getLogger("cmr.voice")

DIR = os.path.join(paths.ROOT, "extensions", "stt")
SCRIPT = os.path.join(DIR, "stt_main.py")
LOG = os.path.join(paths.ROOT, "chatmatrix_stt.log")

# what the user can choose as "program" (key -> label, shown through tr()); "app" = a program picked from the list (voice_app)
TARGETS = {"discord": "Discord (음성 대화만)", "discord-all": "Discord (전체 소리)", "wow": "World of Warcraft",
           "system": "모든 소리 (기본 출력 장치)", "app": "직접 고른 프로그램"}
TARGET_SHORT = {"discord": "Discord", "discord-all": "Discord", "wow": "World of Warcraft"}     # in sentences ("listening to ...")
APP_RE = re.compile(r"^[\w .\-()\[\]+&']{1,80}\.exe$", re.I)
LANGS = ["auto", "ko", "en", "ja", "zh", "ru", "es", "de", "fr", "pt", "it", "pl", "tr", "uk"]
DEVICES = ["auto", "cuda", "cpu"]
ENGINES = {"whisper": "Whisper", "openai": "OpenAI"}               # key -> label (the labels are translated in the options)
OA_FORMATS = ["json", "verbose_json"]
KEY_ENV = "CHATMATRIX_STT_API_KEY"
STATES = ("off", "starting", "loading", "listening", "error")


def target_arg(cfg):
    """The value for stt_main --target from the settings. A program name from the settings is only used when it looks like a file name."""
    t = cfg.get("voice_target")
    if t == "app":
        app = str(cfg.get("voice_app") or "").strip()
        return app if APP_RE.match(app) else "discord"
    return t if t in TARGETS else "discord"


def target_name(cfg):
    """The program in words (for the tooltip of the indicator)."""
    t = cfg.get("voice_target")
    if t == "app":
        return str(cfg.get("voice_app") or "").strip() or tr("직접 고른 프로그램")
    if t == "system":
        return tr("모든 소리")
    return TARGET_SHORT.get(t, "Discord")


def python_exe():
    sub = os.path.join("Scripts", "python.exe") if sys.platform == "win32" else os.path.join("bin", "python")
    return os.path.join(DIR, ".venv", sub)


def installed():
    return os.path.isfile(SCRIPT) and os.path.isfile(python_exe())


def not_installed_text(broken=False):
    """What to say when the voice recognition cannot start because it is not installed (broken: the installation was cut off)."""
    if broken:
        return tr("음성 인식 설치가 끝나지 않았습니다. 옵션의 음성 탭에서 설치하기를 다시 눌러 주세요.")
    return tr("음성 인식(Whisper)이 설치되어 있지 않습니다. 옵션의 음성 탭에서 설치하기를 눌러 설치해 주세요.")


def missing(cfg):
    """None when it can start, else the text to show. Whisper needs its package in the environment (an installation that was cut off
    has the environment but not the package); an OpenAI-compatible server only needs the environment."""
    if not installed():
        return not_installed_text()
    if (cfg.get("voice_engine") or "whisper") != "openai":
        import voiceinstall
        if voiceinstall.state() == "broken":
            return not_installed_text(broken=True)
    return None


def build_args(cfg, python=None, script=None):
    """The command line for the child, from the settings. Pure function (tested without starting anything). The API key is NOT in
    it (every program can read command lines): see build_env()."""
    lang = str(cfg.get("voice_lang") or "auto")
    args = [python or python_exe(), "-X", "utf8", script or SCRIPT, "--json",
            "--target", target_arg(cfg),
            "--lang", lang, "--log", LOG, "--meter", "--meter-ms", "200"]
    end_ms = int(cfg.get("voice_end_ms", 700) or 700)
    args += ["--end-ms", str(max(300, min(2000, end_ms)))]
    args += ["--max-s", str(max(3, min(30, int(cfg.get("voice_max_s", 12) or 12))))]
    engine = cfg.get("voice_engine") or "whisper"
    if engine == "openai":
        args += ["--engine", "openai", "--url", str(cfg.get("voice_oa_url") or "").strip(),
                 "--response-format", cfg.get("voice_oa_format") if cfg.get("voice_oa_format") in OA_FORMATS else "json",
                 "--timeout", str(max(2, min(300, int(cfg.get("voice_oa_timeout", 30) or 30))))]
        if cfg.get("voice_oa_model"):
            args += ["--model", str(cfg["voice_oa_model"]).strip()]
        return args                                    # no live mode here: one request per sentence (see the options tab)
    if cfg.get("voice_mode") == "live":
        args += ["--partial-ms", str(max(300, min(3000, int(cfg.get("voice_partial_ms", 1000) or 1000))))]
    dev = cfg.get("voice_device") or "auto"
    if dev in DEVICES and dev != "auto":
        args += ["--device", dev]
    if cfg.get("voice_model"):
        args += ["--model", str(cfg["voice_model"])]
    if engine not in ("whisper", ""):
        args += ["--engine", str(engine)]              # (tests: the fake engine)
    return args


def build_env(cfg):
    """Extra environment for the child: the API key of the openai engine."""
    key = (cfg.get("voice_oa_key") or "").strip() if cfg.get("voice_engine") == "openai" else ""
    return {KEY_ENV: key} if key else {}


def is_local_url(url):
    """Is the server on this PC or in the home network (the sound does not leave it)? localhost, loopback and private addresses."""
    try:
        host = urllib.parse.urlparse((url or "").strip()).hostname or ""
    except ValueError:
        return False
    if host.lower() in ("localhost", "host.docker.internal"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return host.lower().endswith((".local", ".lan", ".home", ".internal"))
    return ip.is_loopback or ip.is_private or ip.is_link_local


def url_host(url):
    try:
        return urllib.parse.urlparse((url or "").strip()).netloc or ""
    except ValueError:
        return ""


def explain_error(msg):
    """The child's error text ("[no_connection] ...") in the user's language; any other text stays as it is."""
    m = re.search(r"\[(\w+)\]\s*(.*)", msg or "", re.S)
    if not m:
        return msg or ""
    code, detail = m.group(1), m.group(2).strip()
    if code == "no_connection":
        return tr("서버에 연결할 수 없습니다. 주소를 확인하고 서버가 실행 중인지 보세요. ({detail})", detail=detail)
    if code == "not_found":
        return tr("주소가 맞지 않습니다 (404). 주소 끝이 /v1 인지 확인하세요. ({detail})", detail=detail)
    if code == "unauthorized":
        return tr("API 키가 맞지 않습니다. ({detail})", detail=detail)
    if code == "bad_request":
        return tr("서버가 요청을 받아들이지 않았습니다. 모델 이름을 확인하세요. ({detail})", detail=detail)
    if code == "server_error":
        return tr("서버 내부 오류입니다. ({detail})", detail=detail)
    if code == "timeout":
        return tr("서버가 제한 시간 안에 답하지 않았습니다. ({detail})", detail=detail)
    if code == "bad_response":
        return tr("서버의 답을 알아볼 수 없습니다. OpenAI 방식의 음성 인식(transcriptions)을 지원하는 서버인지 확인하세요. ({detail})", detail=detail)
    if code == "bad_address":
        return tr("주소는 http:// 또는 https:// 로 시작해야 합니다 (예: http://localhost:8000/v1)")
    return msg


def check_connection(cfg, python=None, script=None, timeout=90):
    """The "test connection" button: runs the child once with --check. -> (ok, text in the user's language). Blocks: call it in a thread."""
    py = python or python_exe()
    if not (os.path.isfile(script or SCRIPT) and os.path.isfile(py)):
        return False, not_installed_text()
    args = [py, "-X", "utf8", script or SCRIPT, "--json", "--check", "--log", LOG, "--engine", "openai",
            "--url", str(cfg.get("voice_oa_url") or "").strip(),
            "--response-format", cfg.get("voice_oa_format") if cfg.get("voice_oa_format") in OA_FORMATS else "json",
            "--timeout", str(max(2, min(300, int(cfg.get("voice_oa_timeout", 30) or 30))))]
    if cfg.get("voice_oa_model"):
        args += ["--model", str(cfg["voice_oa_model"]).strip()]
    kw = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if sys.platform == "win32" else {}
    try:
        p = subprocess.run(args, capture_output=True, timeout=timeout, env=dict(os.environ, **build_env(cfg)),
                           cwd=os.path.dirname(script or SCRIPT), **kw)
    except subprocess.TimeoutExpired:
        return False, tr("서버가 제한 시간 안에 답하지 않았습니다. ({detail})", detail=f"{timeout} s")
    except OSError as e:
        return False, str(e)
    last = None
    for line in p.stdout.decode("utf-8", errors="replace").splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if isinstance(m, dict) and m.get("type") == "check":
            last = m
    if last is None:
        return False, tr("시험 결과를 받지 못했습니다. 자세한 내용: {path}", path=LOG)
    if last.get("ok"):
        return True, tr("연결되었습니다 ({secs}초)", secs=last.get("secs", 0))
    return False, explain_error(last.get("msg", ""))


def describe_device(info, running):
    """The line "compute device: ..." for the options: -> (text in the user's language, warning?)."""
    if not running:
        return "-", False
    if not info:
        return tr("준비 중..."), False
    dev, comp = info.get("device"), info.get("compute") or ""
    model = info.get("model") or ""
    if dev == "cuda":
        text = tr("GPU (CUDA, {compute})", compute=comp)
    elif dev == "cpu":
        text = tr("CPU ({compute})", compute=comp)
    else:
        return str(dev or "-"), False
    if info.get("fallback"):
        return tr("CPU ({compute}) - GPU를 쓰지 못해 CPU로 동작 중", compute=comp), True
    if model:
        text += " · " + model
    return text, False


def gpu_lines(gpu_info, proc_gpu_text, proc_vram, now):
    """The GPU and VRAM lines of the options -> (gpu text, vram text), in the user's language. ONLY what this recognition itself uses:
    proc_gpu_text / proc_vram from the Windows counters, or the video memory the extension read from the NVIDIA driver (gpu_info["proc"]).
    The whole card's figures say nothing about this program (the game uses the card too), so they are not shown; what is not known is
    "not measurable", never 0."""
    g = gpu_info if (gpu_info and now - gpu_info.get("t", 0) < 5.0) else {}
    mine = g.get("proc") or proc_vram
    return proc_gpu_text or tr("측정할 수 없음"), (resmeter.fmt_bytes(mine) if mine else tr("측정할 수 없음"))


def list_sessions(python=None, script=None, timeout=70):
    """The program chooser: which programs play sound right now. -> (rows, error text in the user's language, "" = ok).
    A row: {"name": "chrome.exe", "devices": [...], "active": bool, "peak": 0..1, "count": n}. Blocks (about 2 s): call it in a thread."""
    py = python or python_exe()
    if not (os.path.isfile(script or SCRIPT) and os.path.isfile(py)):
        return [], not_installed_text()
    kw = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if sys.platform == "win32" else {}
    try:
        p = subprocess.run([py, "-X", "utf8", script or SCRIPT, "--json", "--sessions"], capture_output=True, timeout=timeout,
                           cwd=os.path.dirname(script or SCRIPT), **kw)
    except subprocess.TimeoutExpired:
        return [], tr("목록을 가져오지 못했습니다 (시간 초과)")
    except OSError as e:
        return [], str(e)
    for line in p.stdout.decode("utf-8", errors="replace").splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if isinstance(m, dict) and m.get("type") == "sessions":
            rows = [r for r in (m.get("items") or []) if isinstance(r, dict) and r.get("name")]
            return rows, (tr("목록을 가져오지 못했습니다: {msg}", msg=m["error"]) if m.get("error") else "")
    return [], tr("목록을 가져오지 못했습니다. 자세한 내용: {path}", path=LOG)


class VoiceManager:
    def __init__(self, q, get_cfg, python=None, script=None):
        self.q, self.get_cfg = q, get_cfg
        self.python, self.script = python, script
        self.proc = None
        self.state = "off"
        self.msg = ""
        self.engine_info = {}                            # how the engine runs (device, model ...), known after "ready"
        self.gpu_info = {}                               # from the extension (NVIDIA driver library): "proc" = video memory of the recognition itself (+ "t")
        self.child_pid = None                            # the extension's own process id (it tells it): the process tree may not show it
        self._lock = threading.Lock()
        self._gen = 0                                   # a child that was replaced must not report into the new one's state

    # ------------------------------------------------------------------ control
    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        with self._lock:
            if self.running():
                return True
            py = self.python or python_exe()
            if not (os.path.isfile(self.script or SCRIPT) and os.path.isfile(py)):
                self._set("error", "not installed")
                self.q.put(("voice", {"type": "status", "state": "error", "msg": "not installed"}))
                return False
            args = build_args(self.get_cfg(), python=py, script=self.script)
            log.info("starting the voice recognition: %s", args)
            kw = {}
            if sys.platform == "win32":
                kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            try:
                self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                             cwd=os.path.dirname(self.script or SCRIPT), env=dict(os.environ, **build_env(self.get_cfg())), **kw)
            except OSError as e:
                log.exception("cannot start the voice recognition")
                self._set("error", str(e))
                self.q.put(("voice", {"type": "status", "state": "error", "msg": str(e)}))
                return False
            self._gen += 1
            self.engine_info, self.gpu_info, self.child_pid = {}, {}, None
            self._set("starting", "")
            self.q.put(("voice", {"type": "status", "state": "starting", "msg": ""}))
            threading.Thread(target=self._read, args=(self.proc, self._gen), name="voice-reader", daemon=True).start()
            return True

    def stop(self, wait=3.0):
        with self._lock:
            p, self.proc = self.proc, None
            self._gen += 1
            self.engine_info, self.gpu_info, self.child_pid = {}, {}, None
        if p is None:
            self._set("off", "")
            self.q.put(("voice", {"type": "off"}))
            return
        try:
            p.stdin.write(b'{"cmd": "stop"}\n')
            p.stdin.flush()
            p.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            p.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            log.warning("the voice recognition did not stop: killing it")
            p.kill()
        self._set("off", "")
        self.q.put(("voice", {"type": "off"}))

    def restart(self):
        self.stop(wait=1.0)
        return self.start()

    # ------------------------------------------------------------------ reading the child's messages
    def _set(self, state, msg):
        self.state, self.msg = state, msg

    def _read(self, proc, gen):
        try:
            for raw in proc.stdout:
                try:
                    m = json.loads(raw.decode("utf-8", errors="replace"))
                except ValueError:
                    continue
                if not isinstance(m, dict) or gen != self._gen:
                    continue
                if m.get("type") == "gpu":                      # statistics for the options window only: not an event for the window
                    self.gpu_info = dict(m, t=time.monotonic())
                    continue
                if m.get("type") == "status":
                    st = m.get("state")
                    if isinstance(m.get("engine"), dict) and m["engine"]:
                        self.engine_info = m["engine"]
                    if isinstance(m.get("pid"), int):
                        self.child_pid = m["pid"]
                    if st in ("loading", "listening", "error"):
                        self._set(st, m.get("msg", ""))
                    elif st in ("ready",):
                        self._set("loading", m.get("msg", ""))
                self.q.put(("voice", m))
        except Exception:
            log.exception("reading the voice recognition failed")
        code = proc.wait()
        if gen == self._gen:
            if self.state != "error":
                self._set("off", "")
            self.q.put(("voice", {"type": "exit", "code": code}))
