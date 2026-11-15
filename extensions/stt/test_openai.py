"""Self-test for the engine "openai": a fake server on localhost speaks the OpenAI speech-to-text API."""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import wave
import logging

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sttcore.engines import get_engine                     # noqa: E402
from sttcore.engines import openai_http as oh              # noqa: E402

fails = 0


def check(name, cond, extra=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + (f"  {extra}" if extra and not cond else ""))
    if not cond:
        fails += 1


# ---- the fake server -------------------------------------------------------------------------------------------------------
LAST = {}
BEHAVIOUR = {"key": None, "delay": 0.0, "verbose": False, "garbage": False}


def parse_multipart(body, ctype):
    boundary = ctype.split("boundary=")[1].encode()
    fields, files = {}, {}
    for part in body.split(b"--" + boundary)[1:-1]:
        head, _, data = part.partition(b"\r\n\r\n")
        data = data[:-2]
        name = head.split(b'name="')[1].split(b'"')[0].decode()
        if b'filename="' in head:
            files[name] = data
        else:
            fields[name] = data.decode("utf-8")
    return fields, files


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        if self.path != "/v1/audio/transcriptions":
            return self._send(404, {"error": "not found"})
        if BEHAVIOUR["key"] and self.headers.get("Authorization") != "Bearer " + BEHAVIOUR["key"]:
            return self._send(401, {"error": "bad key"})
        fields, files = parse_multipart(body, self.headers["Content-Type"])
        LAST.clear()
        LAST.update(fields=fields, file=files.get("file"), auth=self.headers.get("Authorization"))
        if fields.get("model") == "bad":
            return self._send(400, {"error": "unknown model"})
        time.sleep(BEHAVIOUR["delay"])
        if BEHAVIOUR["garbage"]:
            return self._send(200, "<html>not json</html>", raw=True)
        if BEHAVIOUR["verbose"]:
            return self._send(200, {"text": "hello 안녕", "language": "ko",
                                    "segments": [{"text": " hello", "avg_logprob": -0.3, "no_speech_prob": 0.01},
                                                 {"text": " 안녕", "avg_logprob": -0.4, "no_speech_prob": 0.02}]})
        self._send(200, {"text": " hello 안녕 "})

    def _send(self, code, obj, raw=False):
        data = (obj if raw else json.dumps(obj, ensure_ascii=False)).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Srv(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):          # a client that gave up (the timeout test) is not an error here
        pass


srv = Srv(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}/v1"
log = logging.getLogger("t")


def engine(**cfg):
    return get_engine("openai", dict({"url": BASE}, **cfg), log)


def err_of(fn):
    try:
        fn()
    except RuntimeError as e:
        return str(e)
    return ""


# ---- address
check("address: /v1 gets the path", oh.endpoint("http://h:1/v1/") == "http://h:1/v1/audio/transcriptions")
check("address: the full path is kept", oh.endpoint("http://h:1/v1/audio/transcriptions") == "http://h:1/v1/audio/transcriptions")
check("address: no scheme -> bad_address", err_of(lambda: oh.endpoint("localhost:8000")).startswith("[bad_address]"))
check("address: empty -> bad_address", err_of(lambda: oh.endpoint("")).startswith("[bad_address]"))

# ---- the request
e = engine(model="my-model")
desc = e.load()
check("load asks the server once and describes it", "127.0.0.1" in desc and "my-model" in desc, desc)
f = LAST["fields"]
check("request: model / format / temperature", f["model"] == "my-model" and f["response_format"] == "json" and f["temperature"] == "0", f)
check("request: no language / prompt when not given", "language" not in f and "prompt" not in f, f)
with wave.open(__import__("io").BytesIO(LAST["file"])) as w:
    check("request: the file is a 16 kHz mono 16 bit WAV of one second", (w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()) == (16000, 1, 2, 16000))
r = e.transcribe(np.zeros(8000, np.float32), "ko", "raid words")
check("language and prompt are sent", LAST["fields"].get("language") == "ko" and LAST["fields"].get("prompt") == "raid words", LAST["fields"])
check("json answer: text, no confidence", len(r) == 1 and r[0].text == "hello 안녕" and r[0].avg_logprob is None, r)

BEHAVIOUR["verbose"] = True
r = engine(response_format="verbose_json").transcribe(np.zeros(8000, np.float32), None, None)
check("verbose_json: one result per segment with confidence", [x.text.strip() for x in r] == ["hello", "안녕"] and r[0].avg_logprob == -0.3 and r[1].no_speech_prob == 0.02, r)
check("verbose_json is asked for", LAST["fields"]["response_format"] == "verbose_json")
BEHAVIOUR["verbose"] = False

# ---- key: from the settings or from the environment
BEHAVIOUR["key"] = "sk-test"
check("wrong key: unauthorized", err_of(lambda: engine(api_key="nope").load()).startswith("[unauthorized]"))
check("no key: unauthorized", err_of(lambda: engine().load()).startswith("[unauthorized]"))
engine(api_key="sk-test").load()
check("key from the settings: sent as Bearer", LAST["auth"] == "Bearer sk-test")
os.environ[oh.ENV_KEY] = "sk-test"
engine().load()
check("key from the environment: sent as Bearer", LAST["auth"] == "Bearer sk-test")
del os.environ[oh.ENV_KEY]
BEHAVIOUR["key"] = None

# ---- errors
check("wrong path: not_found", err_of(lambda: get_engine("openai", {"url": BASE.replace("/v1", "/v2")}, log).load()).startswith("[not_found]"))
check("unknown model: bad_request", err_of(lambda: engine(model="bad").load()).startswith("[bad_request]"))
check("nobody listens: no_connection", err_of(lambda: get_engine("openai", {"url": "http://127.0.0.1:9/v1"}, log).load()).startswith("[no_connection]"))
BEHAVIOUR["garbage"] = True
check("not JSON: bad_response", err_of(lambda: engine().load()).startswith("[bad_response]"))
BEHAVIOUR["garbage"] = False
BEHAVIOUR["delay"] = 3.0
t0 = time.time()
check("slow server: timeout", err_of(lambda: engine(timeout=2).load()).startswith("[timeout]"))
check("the timeout is kept", time.time() - t0 < 2.9, time.time() - t0)
BEHAVIOUR["delay"] = 0.0

# ---- the whole program (a WAV of two sentences, engine openai) and --check
tmp = tempfile.mkdtemp()
wav = os.path.join(tmp, "s.wav")
sr = 16000
sil = np.zeros(sr, np.float32)
tone = (0.3 * np.sin(2 * np.pi * 440 * np.arange(sr * 2) / sr)).astype(np.float32)
sig = np.concatenate([sil, tone, sil, tone, sil])
with wave.open(wav, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes((sig * 32767).astype("<i2").tobytes())
HERE = os.path.dirname(os.path.abspath(__file__))
main = os.path.join(HERE, "stt_main.py")


def run(*args, env=None):
    p = subprocess.run([sys.executable, main, "--json", "--log", os.path.join(tmp, "l.log"), *args], capture_output=True, text=True,
                       timeout=60, env=dict(os.environ, **(env or {})))
    return p.returncode, [json.loads(x) for x in p.stdout.splitlines() if x.strip()]


rc, msgs = run("--engine", "openai", "--url", BASE, "--wav", wav, "--fast", "--lang", "ko")
texts = [m["text"] for m in msgs if m["type"] == "text"]
check("whole program: both sentences come out as text", texts == ["hello 안녕", "hello 안녕"], (rc, msgs))
check("whole program: language reached the server", LAST["fields"].get("language") == "ko", LAST["fields"])
rc, msgs = run("--engine", "openai", "--url", BASE, "--check")
check("--check ok: exit 0 and a check message", rc == 0 and msgs and msgs[-1]["type"] == "check" and msgs[-1]["ok"] is True, (rc, msgs))
rc, msgs = run("--engine", "openai", "--url", "http://127.0.0.1:9/v1", "--check")
check("--check failed: exit 1, ok false, code in the message", rc == 1 and msgs[-1]["ok"] is False and msgs[-1]["msg"].startswith("[no_connection]"), (rc, msgs))
BEHAVIOUR["key"] = "sk-env"
rc, msgs = run("--engine", "openai", "--url", BASE, "--check", env={oh.ENV_KEY: "sk-env"})
check("the key reaches the program through the environment", rc == 0, msgs)
BEHAVIOUR["key"] = None
rc, msgs = run("--engine", "openai", "--url", "nonsense", "--wav", wav, "--fast")
check("bad address: an error status, no crash", rc != 0 and any(m["type"] == "status" and m["state"] == "error" and "[bad_address]" in m["msg"] for m in msgs), (rc, msgs))

print("failures:", fails)
sys.exit(1 if fails else 0)
