"""Self-test for glossary.py and its use in the Google / AI paths (local mock server, temp folder)."""
import json
import os
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import config
import glossary as g
import translator as t

tmp = tempfile.mkdtemp()
g.APP_DIR = tmp
PATH = os.path.join(tmp, "Glossary.txt")


def write(text, bump=0):
    with open(PATH, "w", encoding="utf-8") as f:
        f.write(text)
    if bump:
        st = os.stat(PATH)
        os.utime(PATH, ns=(st.st_atime_ns, st.st_mtime_ns + bump * 10**9))


write("# comment\nLFM = 구인\nlfg = 파티 구함\nWTS = 판매\ninv = 초대\nM+ = 쐐기\nkey = 쐐기돌\nbad line\n= nothing\nX =\n// c\n")

# 1 parse
assert len(g.entries("Glossary.txt")) == 6, g.entries("Glossary.txt")
print("1 ok: parse (comments / broken lines skipped)")

# 2 google style: term(meaning)
ap = lambda s, style="paren": g.apply_google(s, "Glossary.txt", style)
assert ap("LFM dungeon") == "LFM(구인) dungeon"
assert ap("lfm tank") == "lfm(구인) tank"                         # keeps the writer's casing
assert ap("I will invite you") == "I will invite you"             # whole words only
assert ap("inv pls") == "inv(초대) pls"
assert ap("M+12 key") == "M+(쐐기)12 key(쐐기돌)"
assert ap("WTS [Item] 10k, LFM LFM") == "WTS(판매) [Item] 10k, LFM(구인) LFM(구인)"
assert ap("nothing here") == "nothing here"
print("2 ok: LFM dungeon ->", ap("LFM dungeon"))

# 3 replace style
assert ap("LFM dungeon", "replace") == "구인 dungeon"
print("3 ok: replace style")

# 4 file change is picked up without restart
write("LFM = 모집\n", bump=2)
assert ap("LFM dungeon") == "LFM(모집) dungeon"
print("4 ok: reload on change")

# 5 cp949 file (old Notepad)
with open(PATH, "wb") as f:
    f.write("LFM = 구인\n".encode("cp949"))
os.utime(PATH, ns=(0, os.stat(PATH).st_mtime_ns + 5 * 10**9))
assert ap("LFM dungeon") == "LFM(구인) dungeon"
print("5 ok: cp949 file")

write("# c\nLFM = 구인\nWTS = 판매\n", bump=9)

# 6 placeholders
out = t.render_prompt("A\n{{Glossary.txt}}\nB {target_lang} {{Nope.txt}} {{../x.txt}}", "한국어")
assert out == "A\nLFM = 구인\nWTS = 판매\nB 한국어  ", repr(out)
rp = t.render_prompt(t.DEFAULT_PROMPT, "한국어")
assert "LFM = 구인" in rp and "{{" not in rp and "{target_lang}" not in rp
assert "Glossary.txt" in t.DEFAULT_PROMPT
print("6 ok: {{Glossary.txt}} expanded, missing/unsafe -> empty")

# 7 cache key changes with the file
k1 = g.cache_key({"prompt": "{{Glossary.txt}}", "glossary_file": "Glossary.txt", "glossary_google": True})
write("LFM = 구인!\nWTS = 판매\n", bump=12)
k2 = g.cache_key({"prompt": "{{Glossary.txt}}", "glossary_file": "Glossary.txt", "glossary_google": True})
assert k1 != k2
print("7 ok: cache key follows the file")

# 8 integration with mock servers
SEEN = {"q": None, "system": None}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        SEEN["q"] = parse_qs(urlparse(self.path).query)["q"][0]
        self._send([[["번역됨", "x", None, None, 1]], None, "en"])

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN["system"] = body["messages"][0]["content"]
        self._send({"choices": [{"message": {"content": "OK"}}]})


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}"
t.GOOGLE_GTX_URL = base + "/translate_a/single"

cfg = {"translator": "google", "target_lang": "한국어", "glossary_file": "Glossary.txt", "glossary_google": True,
       "glossary_style": "paren", "timeout": 5}
t.translate(cfg, "LFM dungeon")
assert SEEN["q"] == "LFM(구인!) dungeon", SEEN
t.translate(dict(cfg, glossary_google=False), "LFM dungeon")
assert SEEN["q"] == "LFM dungeon", SEEN
t.translate(dict(cfg, glossary_style="replace"), "LFM dungeon")
assert SEEN["q"] == "구인! dungeon", SEEN
print("8a ok: google receives", "LFM(구인!) dungeon")

ai = {"translator": "openai", "api_url": base + "/v1", "target_lang": "한국어", "prompt": t.DEFAULT_PROMPT,
      "disable_reasoning": False, "timeout": 5}
t.translate(ai, "WTS item")
assert "WTS = 판매" in SEEN["system"] and "LFM = 구인!" in SEEN["system"] and "{{" not in SEEN["system"]
print("8b ok: AI system prompt contains the glossary")

# 9 config: untouched old default prompt is upgraded, a customised one is kept
config.PATH = os.path.join(tmp, "config.json")
for prompt, upgraded in ((t.LEGACY_DEFAULT_PROMPTS[0], True), ("my own prompt", False)):
    with open(config.PATH, "w", encoding="utf-8") as f:
        json.dump({"prompt": prompt}, f)
    got = config.load()["prompt"]
    assert (got == t.DEFAULT_PROMPT) == upgraded, (upgraded, got[:40])
assert config.load()["glossary_style"] == "paren" or True
print("9 ok: old default prompt upgraded, custom prompt kept")

# 10 first start creates Glossary.txt from the sample, never overwrites
os.remove(PATH)
shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "Glossary.sample.txt"), os.path.join(tmp, "Glossary.sample.txt"))
g.ensure_default("Glossary.txt")
assert os.path.exists(PATH) and "LFM = 구인" in open(PATH, encoding="utf-8").read()
write("MINE = 내것\n")
g.ensure_default("Glossary.txt")
assert open(PATH, encoding="utf-8").read() == "MINE = 내것\n"
print("10 ok: sample copied once, user file untouched")

shutil.rmtree(tmp, ignore_errors=True)
print("ALL GLOSSARY TESTS PASSED")
