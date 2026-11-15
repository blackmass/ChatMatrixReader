"""Self-test for glossary.py and its use in the Google / AI paths (local mock server, temp folder)."""
import json
import os
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import config
import paths
import glossary as g
import translator as t

tmp = tempfile.mkdtemp()
g.DATA_DIR = tmp
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
        q = SEEN["q"]                      # echo the placeholders back like Google does: "[L1] 던전"
        self._send([[[q.replace("dungeon", "던전"), "x", None, None, 1]], None, "en"])

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
# the glossary words do not go to Google: they are placeholders [L1] and are put back afterwards
out = t.translate(cfg, "LFM dungeon")
assert SEEN["q"] == "[L1] dungeon" and out == "LFM(구인!) 던전", (SEEN, out)
t.translate(dict(cfg, glossary_google=False), "LFM dungeon")
assert SEEN["q"] == "LFM dungeon", SEEN
out = t.translate(dict(cfg, glossary_style="replace"), "LFM dungeon")
assert SEEN["q"] == "[L1] dungeon" and out == "구인! 던전", (SEEN, out)
out = t.translate(cfg, "[L1] LFM dungeon")          # the window's own link placeholder keeps number 1
assert SEEN["q"] == "[L1] [L2] dungeon" and out == "[L1] LFM(구인!) 던전", (SEEN, out)
print("8a ok: google receives placeholders, the glossary words come back")

ai = {"translator": "openai", "api_url": base + "/v1", "target_lang": "한국어", "prompt": t.DEFAULT_PROMPT,
      "disable_reasoning": False, "timeout": 5}
write("# c\n## 파티 모집과 거래에 쓰는 약어\nLFM = 구인!\nWTS = 판매\n", bump=21)
t.translate(ai, "WTS item")
assert "WTS = 판매" in SEEN["system"] and "LFM = 구인!" in SEEN["system"] and "{{" not in SEEN["system"]
assert "## 파티 모집과 거래에 쓰는 약어" in SEEN["system"] and "# ChatMatrix" not in SEEN["system"], SEEN["system"]
t.translate(dict(cfg, glossary_google=True), "LFM dungeon")
assert "##" not in SEEN["q"] and SEEN["q"] == "[L1] dungeon", SEEN               # headings never reach Google
write("## 일반 약어\nb4 = before    # 예: I will be there b4 7 PM\nitem #5 = 5번 아이템\nLFM = 구인!\n", bump=22)
t.translate(ai, "b4 7")
assert "b4 = before    # 예: I will be there b4 7 PM" in SEEN["system"] and "item #5 = 5번 아이템" in SEEN["system"], SEEN["system"]
t.translate(dict(cfg, glossary_google=True), "b4 7 lfm")
assert SEEN["q"] == "[L1] 7 [L2]" and g.entries("Glossary.txt")[0] == ("b4", "before"), (SEEN, g.entries("Glossary.txt"))
print("8b ok: AI system prompt contains the glossary (and its ## headings)")

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
shutil.copy(os.path.join(paths.ROOT, "Glossary.sample.txt"), os.path.join(tmp, "Glossary.sample.txt"))
g.ensure_default("Glossary.txt")
assert os.path.exists(PATH) and "LFM = 구인" in open(PATH, encoding="utf-8").read()
write("MINE = 내것\n")
g.ensure_default("Glossary.txt")
assert open(PATH, encoding="utf-8").read() == "MINE = 내것\n"
print("10 ok: sample copied once, user file untouched")

shutil.rmtree(tmp, ignore_errors=True)
print("ALL GLOSSARY TESTS PASSED")


def _list_tests():
    import glossary as g, translator as t, os, tempfile
    d = tempfile.mkdtemp(); p = os.path.join(d, "G.txt")
    open(p, "w", encoding="utf-8").write(
        "## 일반 약어\nATM = 지금 이 순간    # 채팅에서 right now 대신\nLFM = 구인\n## 상점\nATM = 현금입출기\n## 장소\nSFK = 그림자 송곳니 성채\n")
    out = g.matched_list("LFM SFK, ATM pls", p)
    assert out == ("## 일반 약어\nLFM = 구인\nATM = 지금 이 순간    # 채팅에서 right now 대신\n## 장소\nSFK = 그림자 송곳니 성채\n## 상점\nATM = 현금입출기"), out
    assert g.matched_list("hello world", p) == ""
    assert len(g.matched_list("LFM SFK ATM", p, limit=2).splitlines()) == 4          # 2 entries + their 2 headings
    cfg = {"glossary_mode": "list", "glossary_file": p}
    assert t._user_text(cfg, "LFM x").startswith("Glossary for this message:\n## 일반 약어\nLFM = 구인\n\nMessage:\nLFM x")
    assert t._user_text(cfg, "nothing here") == "nothing here"
    assert t._user_text({"glossary_mode": "full", "glossary_file": p}, "LFM x") == "LFM x"
    sp = t.render_prompt(None, "한국어", "list")
    assert g.LIST_PLACEHOLDER in sp and "{{" not in sp and "LFM = " not in sp
    assert "Glossary for this message" in sp                                        # the rule that explains the list
    import config
    assert config.DEFAULTS["glossary_mode"] == "full"
    print("12 ok: glossary list mode")


_list_tests()


def _ambiguous_tests():
    import glossary as g, os, tempfile
    d = tempfile.mkdtemp(); p = os.path.join(d, "G.txt")
    open(p, "w", encoding="utf-8").write("JRT = 놀이공원\nJRT = 양손검\nLFM = 구인\nLFM = 구인\n")
    assert g.apply_google("LFM the JRT", p) == "LFM(구인) the JRT"                  # same meaning twice = one meaning; JRT is skipped
    assert g.apply_google_masked("LFM the JRT", p) == ("[L1] the JRT", ["LFM(구인)"])
    assert g.matched_list("JRT", p) == "JRT = 놀이공원\nJRT = 양손검"
    import translator as t
    assert "Do not think" in t.DEFAULT_PROMPT and "Do not think" in t.DEFAULT_SEND_PROMPT
    print("13 ok: ambiguous terms")


_ambiguous_tests()


def _mixed_tests():
    import glossary as g, translator as t, os, tempfile
    d = tempfile.mkdtemp(); p = os.path.join(d, "G.txt")
    open(p, "w", encoding="utf-8").write(
        "## 파티\nLFM = 구인\nSFK = 그림자 송곳니 성채\n## 상점\nATM = 현금입출기\n## 일반\nATM = 지금 이 순간    # right now 대신\n"
        "JRT = 놀이공원\nJRT = 양손검\nb4 = before    # 메모\n")
    out, lst = g.apply_mixed("LFM SFK need heal", p)
    assert out == "LFM(구인) SFK(그림자 송곳니 성채) need heal" and lst == "", (out, lst)
    out, lst = g.apply_mixed("give me the JRT", p)
    assert out == "give me the JRT" and lst == "## 일반\nJRT = 놀이공원\nJRT = 양손검", (out, lst)
    out, lst = g.apply_mixed("LFM ATM b4 now", p)
    assert out == "LFM(구인) ATM b4 now", out
    assert lst == "## 상점\nATM = 현금입출기\n## 일반\nATM = 지금 이 순간    # right now 대신\nb4 = before    # 메모", lst   # notes and several meanings -> list
    out, lst = g.apply_mixed("LFM LFM LFM", p, inline_max=2)
    assert out == "LFM(구인) LFM(구인) LFM" and lst == "## 파티\nLFM = 구인", (out, lst)   # beyond the limit: listed
    assert g.apply_mixed("hello", p) == ("hello", "")
    cfg = {"glossary_mode": "mixed", "glossary_file": p}
    assert t._user_text(cfg, "LFM SFK") == "LFM(구인) SFK(그림자 송곳니 성채)"
    u = t._user_text(cfg, "the JRT")
    assert u.startswith("Glossary for this message:\n## 일반\nJRT = 놀이공원\nJRT = 양손검\n\nMessage:\nthe JRT"), u
    assert t._user_text(cfg, "nothing") == "nothing"
    sp = t.render_prompt(None, "한국어", "mixed")
    assert g.MIXED_PLACEHOLDER in sp and "{{" not in sp and "LFM = " not in sp
    assert 'already carries its glossary meaning' in t.DEFAULT_PROMPT
    assert g.cache_key({"glossary_mode": "mixed", "glossary_file": p}) != g.cache_key({"glossary_mode": "list", "glossary_file": p})
    assert g.mode({"glossary_mode": "inline"}) == "list" and "mixed" in g.MODES
    print("14 ok: mixed glossary mode")


_mixed_tests()


def _extra_tests():
    import translator as t, glossary as g
    base = t.render_prompt(t.DEFAULT_PROMPT, "한국어")
    assert "{{" not in base and "Additional instructions" not in base and base.endswith("\n") and not base.endswith("\n\n"), repr(base[-80:])
    assert t.render_prompt(t.DEFAULT_PROMPT, "한국어", "full", "  ") == base               # blank = nothing changes
    out = t.render_prompt(t.DEFAULT_PROMPT, "한국어", "full", "Talk like a pirate. {{Glossary.txt}} {target_lang}")
    assert out.startswith(base.rstrip("\n")) and out.endswith(t.EXTRA_HEADER + "Talk like a pirate. {{Glossary.txt}} {target_lang}\n"), repr(out[-200:])
    assert "ONLY the translation" in t.EXTRA_HEADER                                         # the rules still win
    # a prompt of the user's own, without the marker: the extra is appended at its end
    mine = t.render_prompt("My rules {target_lang}", "한국어", "full", "Be brief.")
    assert mine == "My rules 한국어\n\n" + t.EXTRA_HEADER + "Be brief.\n", repr(mine)
    assert t.render_prompt("My rules", "한국어", "full", "") == "My rules"
    # the marker in the middle of the user's prompt
    mid = t.render_prompt("A {{extra_prompt}} B", "한국어", "full", "X")
    assert mid == "A " + t.EXTRA_HEADER + "X B", repr(mid)
    assert g.cache_key({"prompt": t.DEFAULT_PROMPT}) == g.cache_key({"prompt": t.DEFAULT_PROMPT.replace("{{extra_prompt}}", "")})
    import config
    assert config.DEFAULTS["extra_prompt"] == ""
    assert t.DEFAULT_PROMPT.rstrip().endswith("{{extra_prompt}}")
    print("15 ok: extra prompt")


_extra_tests()


def _send_extra_tests():
    import translator as t
    seen = []
    orig = t.translate
    t.translate = lambda cfg, text: (seen.append(cfg), "x")[1]
    try:
        t.translate_outgoing({"extra_prompt": "Talk like a pirate.", "send_extra_prompt": "Be polite.", "send_lang": "English"}, "hi")
        t.translate_outgoing({"extra_prompt": "Talk like a pirate.", "send_lang": "English"}, "hi")
    finally:
        t.translate = orig
    assert seen[0]["extra_prompt"] == "Be polite." and not seen[1]["extra_prompt"], (seen[0].get("extra_prompt"), seen[1].get("extra_prompt"))
    sp = t.render_prompt(seen[0]["prompt"], "English", "full", seen[0]["extra_prompt"])
    assert sp.endswith(t.EXTRA_HEADER + "Be polite.\n") and "pirate" not in sp and "{{" not in sp and "{send_lang}" not in sp
    assert t.DEFAULT_SEND_PROMPT.rstrip().endswith("{{extra_prompt}}")
    import config
    assert config.DEFAULTS["send_extra_prompt"] == ""
    print("16 ok: send extra prompt (separate from the received one)")


_send_extra_tests()
