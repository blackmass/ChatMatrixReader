"""Self-test for the custom HTTP translator (a local server plays DeepL / Papago / Claude)."""
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

import translator
from translator import TranslateError

SEEN = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
        SEEN.append((self.path, dict(self.headers), raw))
        if self.path.startswith("/deepl"):
            body = {"translations": [{"text": "번역:" + json.loads(raw)["text"][0]}]}
        elif self.path.startswith("/papago"):
            body = {"message": {"result": {"translatedText": "P:" + urllib.parse.parse_qs(raw)["text"][0]}}}
        elif self.path.startswith("/claude"):
            body = {"content": [{"type": "text", "text": "<think>x</think>C:" + json.loads(raw)["messages"][0]["content"]}]}
        elif self.path.startswith("/azure"):
            body = [{"translations": [{"text": "A:" + json.loads(raw)[0]["Text"]}]}]
        else:
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b'{"error":"nope"}')
            return
        data = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_port
common = {"translator": "custom", "target_lang": "한국어", "glossary_google": False, "timeout": 5, "prompt": "Translate to {target_lang}."}

# 1 DeepL style: header key, JSON body, upper-case code, tricky text ({key} and quotes must stay literal)
cfg = dict(common, custom_url=base + "/deepl", custom_headers='{"Authorization": "DeepL-Auth-Key {key}"}', custom_body_type="json",
           custom_body='{"text": ["{text}"], "target_lang": "{TARGET}"}', custom_path="translations.0.text", custom_key="K:fx")
out = translator.translate(cfg, 'say "hi" {key} \\ ok')
assert out == '번역:say "hi" {key} \\ ok', out
path, hdr, raw = SEEN[-1]
assert hdr["Authorization"] == "DeepL-Auth-Key K:fx", hdr
assert json.loads(raw) == {"text": ['say "hi" {key} \\ ok'], "target_lang": "KO"}, raw
print("1 ok: json body + header key + escaping")

# 2 Papago style: form body, key split at ':'
cfg = dict(common, custom_url=base + "/papago", custom_headers='{"X-ID": "{key1}", "X-SECRET": "{key2}"}', custom_body_type="form",
           custom_body="source=en&target={target}&text={text}", custom_path="message.result.translatedText", custom_key="id1:sec2")
out = translator.translate(cfg, "a&b=c d")
assert out == "P:a&b=c d", out
path, hdr, raw = SEEN[-1]
assert hdr["X-Id"] == "id1" and hdr["X-Secret"] == "sec2", hdr
assert urllib.parse.parse_qs(raw)["target"] == ["ko"], raw
print("2 ok: form body + key split")

# 3 Claude style: {system}, think-tags removed
cfg = dict(common, custom_url=base + "/claude", custom_headers='{"x-api-key": "{key}"}', custom_body_type="json",
           custom_body='{"system": "{system}", "messages": [{"role": "user", "content": "{text}"}]}', custom_path="content.0.text", custom_key="k")
out = translator.translate(cfg, "hello")
assert out == "C:hello", out
assert json.loads(SEEN[-1][2])["system"] == "Translate to 한국어."
print("3 ok: {system} + AI cleanup")

# 4 Azure style: list answer, key in the address is quoted
cfg = dict(common, custom_url=base + "/azure?to={target}", custom_headers="{}", custom_body_type="json",
           custom_body='[{"Text": "{text}"}]', custom_path="0.translations.0.text", custom_key="")
assert translator.translate(cfg, "hello") == "A:hello"
assert SEEN[-1][0] == "/azure?to=ko", SEEN[-1][0]
print("4 ok: list answer path")

# 5 errors
for bad, frag in [(dict(cfg, custom_path="nothing.here"), "nothing.here"), (dict(cfg, custom_url=base + "/x"), "HTTP 403"),
                  (dict(cfg, custom_body="not json"), "JSON"), (dict(cfg, custom_url="ftp://x"), "http"),
                  (dict(cfg, custom_headers='{"k": "{key}"}'), "API Key")]:
    try:
        translator.translate(bad, "hello")
        raise AssertionError("no error for " + frag)
    except TranslateError as e:
        assert frag in str(e), (frag, str(e))
print("5 ok: clear errors")

# 5b the request log never shows the API key
import logsetup
logsetup.setup()
translator.translate(dict(cfg, log_request=True, custom_url=base + "/azure?to={target}&k={key}", custom_key="TOPSECRET",
                          custom_headers='{"H": "{key}"}'), "hello")
shown = "\n".join(x for x in logsetup.ring.snapshot() if "요청 전문 [custom]" in x)
assert shown and "TOPSECRET" not in shown and "***" in shown and "hello" in shown, shown
print("5b ok: key hidden in the request log")

# 6 cache key follows the settings
assert translator.custom_signature(cfg) != translator.custom_signature(dict(cfg, custom_path="x"))
assert translator.custom_signature({"translator": "google"}) == 0
print("6 ok: cache signature")

# 7 every preset is a valid request definition
for name, (url, headers, btype, body, path, note) in translator.CUSTOM_PRESETS.items():
    translator.custom_check({"custom_url": url, "custom_headers": headers, "custom_body_type": btype, "custom_body": body, "custom_path": path})
print("7 ok: presets are valid")
print("ALL CUSTOM TESTS PASSED")
srv.shutdown()
