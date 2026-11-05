"""Self-test for translator.py using local mock servers (no internet, no LM Studio needed)."""
import json
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import logsetup
import translator as t

logsetup.setup()

SEEN = []          # requests received by the mock server


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        SEEN.append(("GET", u.path, None, dict(self.headers)))
        if u.path == "/v1/models":
            return self._send(200, {"data": [{"id": "model-a"}, {"id": "model-b"}]})
        if u.path == "/translate_a/single":
            q = parse_qs(u.query)
            text, tl = q["q"][0], q["tl"][0]
            if text == "limited":
                return self._send(429, {"error": "too many requests"})
            # gtx format: [[[translated, original, ...], ...], null, detected_lang]
            return self._send(200, [[[f"[{tl}] {text}", text, None, None, 1],
                                     [" 두번째 문장", " second", None, None, 1]], None, "en"])
        self._send(404, {"error": "nope"})

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        SEEN.append(("POST", u.path, body, dict(self.headers)))
        if u.path == "/v1/chat/completions":
            user = body["messages"][-1]["content"]
            if user == "boom":
                return self._send(500, {"error": "model crashed"})
            if user == "reasoning-only":
                return self._send(200, {"choices": [{"finish_reason": "length",
                                                     "message": {"content": "", "reasoning_content": "thinking..."}}]})
            if user == "cut-think":
                return self._send(200, {"choices": [{"finish_reason": "length",
                                                     "message": {"content": "<think>still thinking"}}]})
            if user == "strict" and ("reasoning_effort" in body):
                return self._send(400, {"error": "unknown field reasoning_effort"})
            if user == "same":
                return self._send(200, {"choices": [{"message": {"content": "same"}}]})
            return self._send(200, {"choices": [{"message": {"content": f"<think>hmm</think>\n번역:{user}"}}]})
        if u.path == "/language/translate/v2":
            return self._send(200, {"data": {"translations": [{"translatedText": "V2:" + body["q"]}]}})
        self._send(404, {"error": "nope"})


srv = HTTPServer(("127.0.0.1", 0), Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}"

# --- URL normalisation
assert t.openai_base("localhost:1234") == "http://localhost:1234/v1"
assert t.openai_base("http://localhost:1234/") == "http://localhost:1234/v1"
assert t.openai_base("http://localhost:1234/v1/chat/completions") == "http://localhost:1234/v1"
assert t.openai_base("https://x.example/api/v1/") == "https://x.example/api/v1"
print("1 ok: url normalisation")

# --- OpenAI chat
cfg = {"translator": "openai", "api_url": BASE + "/v1", "api_model": "model-a", "api_key": "secret",
       "target_lang": "한국어", "prompt": "Translate to {target_lang}. {not_a_format_field}",
       "temperature": 0.3, "timeout": 5}
out = t.translate(cfg, "LFM M+ need tank")
assert out == "번역:LFM M+ need tank", out                       # <think> stripped
method, path, body, hdrs = SEEN[-1]
assert path == "/v1/chat/completions" and body["model"] == "model-a" and body["temperature"] == 0.3
assert body["messages"][0]["content"] == "Translate to 한국어. {not_a_format_field}"
assert body["messages"][1] == {"role": "user", "content": "LFM M+ need tank"}
assert hdrs.get("Authorization") == "Bearer secret"
print("2 ok: openai request/response, prompt substitution, think-strip")

# model omitted when empty
cfg2 = dict(cfg, api_model="", api_key="")
t.translate(cfg2, "hi")
assert "model" not in SEEN[-1][2] and "Authorization" not in SEEN[-1][3]
print("3 ok: empty model / key omitted")

# --- reasoning off: extras are sent by default, can be disabled, errors are explained
t.translate(cfg, "hi")
assert SEEN[-1][2]["reasoning_effort"] == "none" and SEEN[-1][2]["chat_template_kwargs"] == {"enable_thinking": False}
t.translate(dict(cfg, disable_reasoning=False), "hi")
assert "reasoning_effort" not in SEEN[-1][2]
t.translate(dict(cfg, reasoning_off_body='{"reasoning_effort": "low"}'), "hi")
assert SEEN[-1][2]["reasoning_effort"] == "low" and "chat_template_kwargs" not in SEEN[-1][2]
for bad in ("reasoning-only", "cut-think"):
    try:
        t.translate(cfg, bad)
        raise SystemExit("expected error for " + bad)
    except t.TranslateError as e:
        assert "추론" in str(e), e
n = len(SEEN)
assert t.translate(cfg, "strict") == "번역:strict"            # 400 -> retried without the extra fields
assert len(SEEN) == n + 2 and "reasoning_effort" not in SEEN[-1][2]
t.translate(cfg, "strict")                                      # remembered: no wasted first attempt
assert len(SEEN) == n + 3 and "reasoning_effort" not in SEEN[-1][2]
try:
    t.translate(dict(cfg, reasoning_off_body="not json"), "x")
    raise SystemExit("expected error")
except t.TranslateError:
    pass
print("3b ok: reasoning off / retry on 400 / reasoning-only explained")

# --- models list
assert t.list_models(cfg) == ["model-a", "model-b"]
print("4 ok: model list")

# --- errors
try:
    t.translate(cfg, "boom")
    raise SystemExit("expected error")
except t.TranslateError as e:
    assert "500" in str(e), e
try:
    t.translate(dict(cfg, api_url="http://127.0.0.1:1/v1", timeout=2), "x")
    raise SystemExit("expected error")
except t.TranslateError as e:
    assert "연결 실패" in str(e), e
print("5 ok: HTTP error and connection error are reported")

# --- Google (unofficial endpoint) and official v2
t.GOOGLE_GTX_URL = BASE + "/translate_a/single"
t.GOOGLE_V2_URL = BASE + "/language/translate/v2"
g = {"translator": "google", "target_lang": "한국어", "google_api_key": "", "timeout": 5}
assert t.translate(g, "hello") == "[ko] hello 두번째 문장"
assert t.translate(dict(g, target_lang="日本語"), "hello").startswith("[ja]")
assert t.translate(dict(g, google_api_key="K"), "hello") == "V2:hello"
try:
    t.translate(dict(g, target_lang="Klingon"), "x")
    raise SystemExit("expected error")
except t.TranslateError:
    pass
print("6 ok: google gtx + v2 + unknown language")

# --- google rate limit: detected, explained, and the server is left alone during the pause
n = len(SEEN)
try:
    t.translate(g, "limited")
    raise SystemExit("expected error")
except t.TranslateError as e:
    assert "제한" in str(e) and "30초" in str(e), e
assert len(SEEN) == n + 1
try:
    t.translate(g, "hello")
    raise SystemExit("expected error")
except t.TranslateError as e:
    assert "대기 중" in str(e), e
assert len(SEEN) == n + 1                               # no request was sent while paused
t._g_block_until = 0.0
t._g_block_n = 0
assert t.translate(g, "hello").startswith("[ko]")       # works again after the pause
print("6b ok: google rate limit pause")

# --- script check / filtering
assert t.looks_like_target("안녕하세요 같이 던전 가실분", "한국어")
assert not t.looks_like_target("LFM tank pls", "한국어")
assert not t.looks_like_target("LFM 탱커 구함 inv pls", "한국어")
assert t.should_translate("LFM tank", {"translator": "openai", "target_lang": "한국어"})
assert not t.should_translate("LFM tank", {"translator": "none"})
assert not t.should_translate("123 !!!", {"translator": "openai", "target_lang": "한국어"})
assert not t.should_translate("안녕", {"translator": "openai", "target_lang": "한국어", "skip_same_lang": True})
print("7 ok: should_translate")

# --- service: async, cache, identical result suppressed, error reporting, queue limit
q = queue.Queue()
svc = t.TranslationService(q, lambda: cfg)
assert svc.submit(1, "hello") and svc.submit(2, "same") and svc.submit(3, "boom")
res = {}
deadline = time.time() + 5
while len(res) < 3 and time.time() < deadline:
    kind, (tok, r, err) = q.get(timeout=5)
    res[tok] = (r, err)
assert res[1] == ("번역:hello", None), res
assert res[2] == (None, None), res                 # translation identical to original -> nothing to add
assert res[3][0] is None and "500" in res[3][1], res
n_before = len(SEEN)
svc.submit(4, "hello")                             # cached: no new request
kind, (tok, r, err) = q.get(timeout=5)
assert (tok, r) == (4, "번역:hello") and len(SEEN) == n_before
print("8 ok: service async/cache/suppression/errors")

slow_cfg = dict(cfg, max_pending=1, api_url="http://10.255.255.1:1/v1", timeout=1)   # unroutable: stays pending
svc2 = t.TranslationService(queue.Queue(), lambda: slow_cfg)
assert svc2.submit(1, "a") is True
assert svc2.submit(2, "b") is False                # queue limit reached
print("9 ok: pending limit")

lines = "\n".join(logsetup.ring.snapshot())
assert "openai OK" in lines and "openai FAIL" in lines and "HTTP 500" in lines and "google FAIL" in lines, lines
assert "secret" not in lines                                # API keys must never reach the log
print("10 ok: log lines recorded, key not logged")

svc.shutdown()
svc2.shutdown()
print("ALL TRANSLATOR TESTS PASSED")
