"""Self-test for outgoing.py / translator.translate_outgoing / hotkeys.py (mock server, no internet needed)."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import hotkeys
import logsetup
import outgoing as o
import translator as t

logsetup.setup()
SEEN = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        SEEN.append(("GET", q))
        self._send([[["[" + q["tl"][0] + "] " + q["q"][0], q["q"][0], None, None, 1]], None, "ko"])

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append(("POST", body))
        user = body["messages"][-1]["content"]
        self._send({"choices": [{"message": {"content": {"탱커 구함": '  "Translation: LFM tank"  ', "길게": "x" * 300,
                                                         "명령": "/invite Bob", "줄바꿈": "line one\nline two",
                                                         "파이프": "a|cffffffff b"}.get(user, "EN:" + user)}}]})


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"
t.GOOGLE_GTX_URL = BASE + "/translate_a/single"

# --- command splitting
assert o.split_command("안녕하세요") == ("", "안녕하세요", "plain")
assert o.split_command("/w Bob 안녕") == ("/w Bob ", "안녕", "chat")
assert o.split_command("/W Bob-Realm   안녕 하세요") == ("/W Bob-Realm ", "안녕 하세요", "chat")
assert o.split_command("/r 고마워") == ("/r ", "고마워", "chat")
assert o.split_command("/1 판매합니다") == ("/1 ", "판매합니다", "chat")
assert o.split_command("/p")[2] == "chat" and o.split_command("/w")[2] == "chat"
assert o.split_command("/dance") == ("", "/dance", "other")
assert o.split_command("/target Bob")[2] == "other"
print("1 ok: command splitting")

# --- cleaning
assert o.clean_translation('  "Translation: LFM tank"  ') == "LFM tank"
assert o.clean_translation("a\n b\r\nc") == "a b c"
assert o.clean_translation("/invite Bob") == "invite Bob"           # never a game command
assert o.clean_translation("“Hello there”") == "Hello there"
assert o.escape_pipes("a|cffffffff b") == "a||cffffffff b"
print("2 ok: output cleaning")

cfg = {"translator": "openai", "api_url": BASE + "/v1", "api_model": "m", "temperature": 0.1, "timeout": 5,
       "send_lang": "English", "target_lang": "한국어", "prompt": "RECEIVE PROMPT {target_lang}",
       "glossary_file": "Glossary.txt", "glossary_google": True, "glossary_style": "paren"}

# --- prepare(): the whole path against the mock LLM
r = o.prepare(cfg, "탱커 구함")
assert r.text == "LFM tank" and r.translated and r.note is None, r.text
sys_prompt = SEEN[-1][1]["messages"][0]["content"]
assert "English" in sys_prompt and "{send_lang}" not in sys_prompt and "RECEIVE PROMPT" not in sys_prompt
assert SEEN[-1][1]["messages"][1]["content"] == "탱커 구함"
r = o.prepare(cfg, "/w Bob 탱커 구함")
assert r.text == "/w Bob LFM tank", r.text
assert SEEN[-1][1]["messages"][1]["content"] == "탱커 구함"                 # only the sentence was translated
n = len(SEEN)
r = o.prepare(cfg, "/dance")
assert r.text == "/dance" and not r.translated and r.note and len(SEEN) == n         # no request for commands
r = o.prepare(cfg, "12345")
assert r.text == "12345" and len(SEEN) == n                                           # nothing to translate
assert o.prepare(cfg, "명령").text == "invite Bob"
assert o.prepare(cfg, "줄바꿈").text == "line one line two"
assert o.prepare(cfg, "파이프").text == "a||cffffffff b"
print("3 ok: prepare() with an LLM")

# --- errors
for raw, why in [("", "empty"), ("   ", "empty"), ("/w Bob", "no body"), ("/w", "no body")]:
    try:
        o.prepare(cfg, raw)
        raise SystemExit("expected error: " + why)
    except o.OutgoingError:
        pass
try:
    o.prepare(cfg, "길게")
    raise SystemExit("expected too long")
except o.OutgoingError as e:
    assert "300/255" in str(e), e
try:
    o.prepare(dict(cfg, api_url="http://127.0.0.1:1/v1", timeout=2), "안녕")
    raise SystemExit("expected failure")
except o.OutgoingError as e:
    assert "연결 실패" in str(e), e
try:
    o.prepare(dict(cfg, translator="none"), "안녕")
    raise SystemExit("expected failure")
except o.OutgoingError:
    pass
long_cmd = "/w " + "a" * 40 + " 안녕"
assert o.prepare(cfg, long_cmd).text.startswith("/w " + "a" * 40 + " EN:")
print("4 ok: errors are reported, nothing is sent to the clipboard")

# --- Google path: target = send language, source auto, Korean glossary NOT applied
g = {"translator": "google", "send_lang": "English", "target_lang": "한국어", "timeout": 5, "glossary_google": True,
     "glossary_style": "paren", "glossary_file": "Glossary.txt", "google_api_key": ""}
r = o.prepare(g, "LFM 구인 dungeon")
q = SEEN[-1][1]
assert q["tl"] == ["en"] and q["sl"] == ["auto"] and q["q"] == ["LFM 구인 dungeon"], q
assert r.text == "[en] LFM 구인 dungeon"
r = o.prepare(dict(g, send_lang="日本語"), "hello")
assert SEEN[-1][1]["tl"] == ["ja"]
print("5 ok: google outgoing")

# --- default prompt
assert "{send_lang}" in t.DEFAULT_SEND_PROMPT and "{{Glossary.txt}}" in t.DEFAULT_SEND_PROMPT

# --- hotkeys
assert hotkeys.normalize(" shift + return ") == "Shift+Enter" and hotkeys.DEFAULT == "Shift+Enter"
assert hotkeys.parse("Ctrl+Alt+F5") == (frozenset({"Ctrl", "Alt"}), 0x74)
assert hotkeys.key_of_keysym("Return") == "Enter" and hotkeys.key_of_keysym("a") == "A" and hotkeys.key_of_keysym("F3") == "F3"
assert hotkeys.key_of_keysym("Escape") is None and hotkeys.mod_of_keysym("Shift_L") == "Shift"
for bad in ["", "Shift", "Foo", "Esc", "A+B"]:
    try:
        hotkeys.parse(bad)
        raise SystemExit("expected error for " + repr(bad))
    except ValueError:
        pass
print("6 ok: hotkeys")
print("ALL OUTGOING TESTS PASSED")
