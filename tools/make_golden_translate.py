"""Runs the 2.0 translator / glossary / usage on scripted scenarios (the HTTP layer replaced by canned answers) and stores
requests + results in tests/golden/translate.json. The JS port (app/core/translate.js ...) must make the same requests and give
the same results.   python tools/make_golden_translate.py <path to ChatMatrixReader2/app>"""
import json, logging, os, sys, tempfile, time as _time

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "ChatMatrixReader2", "app")
sys.path.insert(0, SRC)
logging.disable(logging.CRITICAL)
import glossary as gl, usage, translator as tz

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "golden")
TMP = tempfile.mkdtemp()
GLOSSARY = """# comment line
## Dungeons
SFK = 그림자 송곳니 성채
RFC = 성난불길 협곡   # Ragefire Chasm
M+ = 신화+
Dead Mines = 죽음의 폐광
## General
LFM = 구인
inv = 초대
ATM = 현금입출기
ATM = 지금 이 순간
b4 = 이전   # a note
// another comment
"""
EXTRA = "## Extra\nfoo = 푸\n# hidden\nbar = 바\n"
open(os.path.join(TMP, "Glossary.txt"), "w", encoding="utf-8").write(GLOSSARY)
open(os.path.join(TMP, "Extra.txt"), "w", encoding="utf-8").write(EXTRA)
gl.DATA_DIR = TMP
usage.PATH = os.path.join(TMP, "usage.json")

TEXTS = ["LFM SFK need heal", "lfm sfk", "M+12 key", "inv me", "invite me", "ATM please", "where is the ATM", "b4 the boss", "[L1] LFM [L2] SFK",
         "Dead Mines run", "no terms here", "", "LFM, RFC; SFK.", "한글 LFM 입니다", "SFK LFM SFK", "LFM SFK RFC M+ inv b4 ATM Dead Mines",
         "(L3) tank LFM", "x" * 5 + " LFM"]
out = {"glossary": [], "prompt": [], "send_cfg": [], "openai": [], "google": [], "custom": [], "usage": []}

for style in ("paren", "replace"):
    for t in TEXTS:
        out["glossary"].append(["apply_google", [t, style], gl.apply_google(t, None, style)])
        for start in (1, 4):
            r = gl.apply_google_masked(t, None, style, start)
            out["glossary"].append(["apply_google_masked", [t, style, start], [r[0], r[1]]])
for t in TEXTS:
    out["glossary"].append(["matched_list", [t], gl.matched_list(t)])
    out["glossary"].append(["matched_list2", [t], gl.matched_list(t, None, 2)])
    r = gl.apply_mixed(t)
    out["glossary"].append(["apply_mixed", [t], [r[0], r[1]]])
    r = gl.apply_mixed(t, None, 20, 1)
    out["glossary"].append(["apply_mixed_inline1", [t], [r[0], r[1]]])
out["glossary"].append(["entries", [], [list(e) for e in gl.entries()]])
out["glossary"].append(["parse_rich", [GLOSSARY], [list(e) for e in gl.parse_rich(GLOSSARY)]])
out["glossary"].append(["content_lines", [GLOSSARY], gl._content_lines(GLOSSARY, True)])
for cfg in ({}, {"glossary_mode": "list"}, {"glossary_mode": "mixed"}, {"glossary_mode": "inline"}, {"glossary_mode": "zzz"}):
    out["glossary"].append(["mode", [cfg], gl.mode(cfg)])

PROMPTS = [None, "", "Translate to {target_lang}.\n{{Glossary.txt}}\nEnd", "A {{extra_prompt}} B {{extra_prompt}} C {target_lang}",
           "x {{ Extra.txt }} {{Missing.txt}} {{../secret.txt}} {{/abs.txt}} {{sub/x.txt}} {braces} {{extra_prompt}}", "no placeholders at all"]
for p in PROMPTS:
    for mode in ("full", "list", "mixed"):
        for extra in ("", "  be formal  "):
            out["prompt"].append([p, "한국어", mode, extra, tz.render_prompt(p, "한국어", mode, extra)])

for cfg in ({}, {"send_lang": "Deutsch"}, {"send_lang": "  ", "send_extra_prompt": "x", "extra_prompt": "y"},
            {"send_prompt": "Say it in {send_lang}: {{Glossary.txt}}", "send_lang": "日本語", "glossary_google": True}):
    r = tz.send_cfg(cfg)
    out["send_cfg"].append([cfg, r])


# ---------------------------------------------------------------- scripted HTTP
class FakeTime:
    now = 0.0
    sleeps = []
    def monotonic(self): return FakeTime.now
    def sleep(self, s): FakeTime.sleeps.append(round(s, 6)); FakeTime.now += s
    def perf_counter(self): return _time.perf_counter()
tz.time = FakeTime()

calls, queue = [], []
def spec_to_exc(spec):
    return (tz.TransientError if spec[0] == "X" else tz.TranslateError)(spec[1])
def fake_json(url, payload=None, headers=None, timeout=30.0):
    calls.append(["json", url, payload, headers, timeout])
    if not queue: raise AssertionError("no canned answer left")
    r = queue.pop(0)
    if isinstance(r, dict) and "err" in r: raise spec_to_exc(r["err"])
    return r["data"]
class _Req: pass
def fake_form(req, headers, timeout):
    calls.append(["form", req.full_url, req.data.decode(), dict(headers), timeout])
    r = queue.pop(0)
    if isinstance(r, dict) and "err" in r: raise spec_to_exc(r["err"])
    return r["data"]
tz._http_json, tz._http_form = fake_json, fake_form

def reset():
    tz._extras_rejected.clear()
    tz._g_next_slot = tz._g_block_until = 0.0; tz._g_block_n = 0
    FakeTime.now = 0.0
    usage._state = None
    try: os.remove(usage.PATH)
    except OSError: pass

def run(group, name, cfg, steps, outgoing=False):
    """steps: [{text, advance?, responses: [{data}|{err:[kind,msg]}]}]"""
    reset()
    notes = []
    tz.usage_notify = notes.append
    res = []
    for st in steps:
        FakeTime.now += st.get("advance", 0.0)
        del calls[:]; del FakeTime.sleeps[:]
        queue[:] = list(st.get("responses", []))
        try:
            o = (tz.translate_outgoing if outgoing else tz.translate)(cfg, st["text"])
            r = {"ok": o}
        except tz.RateLimited as e:
            r = {"err": "RateLimited", "msg": str(e), "delay": round(e.delay, 6)}
        except tz.TransientError as e:
            r = {"err": "TransientError", "msg": str(e)}
        except tz.TranslateError as e:
            r = {"err": "TranslateError", "msg": str(e)}
        res.append({"result": r, "calls": json.loads(json.dumps(calls)), "sleeps": list(FakeTime.sleeps), "left": len(queue)})
    out[group].append({"name": name, "cfg": cfg, "steps": steps, "outgoing": outgoing, "expect": res, "notes": list(notes), "usage_total": usage.total()})

def ok(content, finish="stop", **msg):
    return {"data": {"choices": [{"message": dict({"content": content}, **msg), "finish_reason": finish}]}}
def err(kind, msg): return {"err": [kind, msg]}

OA = {"translator": "openai", "api_url": "localhost:1234", "target_lang": "한국어"}
run("openai", "basic", dict(OA, api_model=" my-model ", api_key=" k ", temperature=0.5, max_tokens=100, timeout=12), [{"text": "LFM SFK", "responses": [ok("구인 그림자")]}])
run("openai", "url forms", dict(OA, api_url="https://api.openai.com/v1/chat/completions/"), [{"text": "hi", "responses": [ok("안녕")]}])
run("openai", "url path", dict(OA, api_url="http://host:5/custom/path"), [{"text": "hi", "responses": [ok("안녕")]}])
run("openai", "url empty", dict(OA, api_url=" "), [{"text": "hi"}])
run("openai", "think clean", OA, [{"text": "a", "responses": [ok("<think>hmm\nmm</think>\n안녕 ")]}, {"text": "b", "responses": [ok("<think>cut off")]}])
for mode in ("full", "list", "mixed"):
    run("openai", "glossary " + mode, dict(OA, glossary_mode=mode, extra_prompt="formal"), [{"text": "LFM SFK and ATM and b4", "responses": [ok("x")]}, {"text": "nothing", "responses": [ok("y")]}])
run("openai", "length retry", OA, [{"text": "a", "responses": [ok("", "length"), ok("답")]}])
run("openai", "reasoning retry", OA, [{"text": "a", "responses": [ok("", "stop", reasoning_content="thinking"), ok("답")]}])
run("openai", "retry off", dict(OA, retry_on_reasoning=False), [{"text": "a", "responses": [ok("", "length")]}])
run("openai", "retry still empty", OA, [{"text": "a", "responses": [ok("", "length"), ok("", "length")]}])
run("openai", "empty plain", OA, [{"text": "a", "responses": [ok("", "stop")]}])
run("openai", "extras rejected", OA, [{"text": "a", "responses": [err("T", "HTTP 400 bad field"), ok("답1")]}, {"text": "b", "responses": [ok("답2")]}])
run("openai", "400 not extras", dict(OA, disable_reasoning=False), [{"text": "a", "responses": [err("T", "HTTP 400 bad")]}])
run("openai", "500", OA, [{"text": "a", "responses": [err("X", "HTTP 503 down")]}])
run("openai", "bad format", OA, [{"text": "a", "responses": [{"data": {"nope": 1}}]}, {"text": "b", "responses": [{"data": {"choices": []}}]}])
run("openai", "tokens", OA, [{"text": "a", "responses": [{"data": {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 2}}}]}])
run("openai", "no reasoning field", dict(OA, disable_reasoning=False), [{"text": "a", "responses": [ok("ok")]}])
run("openai", "custom reasoning body", dict(OA, reasoning_off_body='{"think": false}'), [{"text": "a", "responses": [ok("ok")]}])
run("openai", "bad reasoning json", dict(OA, reasoning_off_body="{nope"), [{"text": "a"}])
run("openai", "reasoning not object", dict(OA, reasoning_off_body="[1]"), [{"text": "a"}])
run("openai", "custom prompt", dict(OA, prompt="To {target_lang}: {{Extra.txt}} {{extra_prompt}}", extra_prompt="hey"), [{"text": "a", "responses": [ok("ok")]}])
run("openai", "outgoing", dict(OA, send_lang="English", send_extra_prompt="casual", send_route="openai", glossary_mode="mixed"), [{"text": "구인 그림자", "responses": [ok("LFM SFK")]}], outgoing=True)
run("openai", "outgoing google", dict(OA, send_lang="Deutsch", send_route="google_free"), [{"text": "안녕", "responses": [{"data": [[["Hallo", "안녕", None, None, 10]], None, "ko"]}]}], outgoing=True)
run("openai", "mode none", {"translator": "none"}, [{"text": "a"}])

G = {"translator": "google", "google_free": True, "target_lang": "한국어"}
gdata = lambda s, det="en": {"data": [[[s, "x", None, None, 10]], None, det]}
run("google", "free basic", G, [{"text": "hello", "responses": [{"data": [[["안녕 ", "hel", None, None, 1], ["세상", "lo", None, None, 1], None, ["", "", None]], None, "en"]}]}])
run("google", "free glossary", dict(G, glossary_google=True), [{"text": "LFM SFK need heal", "responses": [gdata("[L1] [L2] 힐러 필요")]}, {"text": "[L1] LFM SFK", "responses": [gdata("[L1] [L2] [L3]")]}])
run("google", "free glossary replace", dict(G, glossary_google=True, glossary_style="replace"), [{"text": "LFM ATM", "responses": [gdata("[L1] [L2]")]}])
run("google", "glossary off", dict(G, glossary_google=False), [{"text": "LFM SFK", "responses": [gdata("x")]}])
run("google", "spacing", G, [{"text": "a", "responses": [gdata("1")]}, {"text": "b", "responses": [gdata("2")]}, {"text": "c", "responses": [gdata("3")]}, {"text": "d", "advance": 5.0, "responses": [gdata("4")]}])
run("google", "429 escalation", G, [{"text": "a", "responses": [err("T", "HTTP 429 <html>blocked</html>")]}, {"text": "b"}, {"text": "c", "advance": 31.0, "responses": [err("T", "HTTP 403 forbidden")]},
                                      {"text": "d", "advance": 61.0, "responses": [err("T", "JSON이 아닌 응답: <html>")]}, {"text": "e", "advance": 121.0, "responses": [gdata("ok")]},
                                      {"text": "f", "responses": [err("T", "HTTP 429 x")]}])
run("google", "blocked then ok", G, [{"text": "a", "responses": [err("T", "HTTP 429 x")]}, {"text": "b", "advance": 40.0, "responses": [gdata("fine")]}])
run("google", "transient", G, [{"text": "a", "responses": [err("X", "HTTP 503 x")]}, {"text": "b", "responses": [{"data": [[], None, "en"]}]}, {"text": "c", "responses": [{"data": {"x": 1}}]}])
run("google", "other http error", G, [{"text": "a", "responses": [err("T", "HTTP 404 nope")]}])
run("google", "language code", dict(G, target_lang="English"), [{"text": "안녕", "responses": [gdata("hello", "ko")]}])
run("google", "bad language", dict(G, target_lang="Klingon!"), [{"text": "안녕"}])
V2 = {"translator": "google", "google_free": False, "google_api_key": " KEY&1 ", "target_lang": "日本語"}
run("google", "v2 basic", V2, [{"text": "hello wörld", "responses": [{"data": {"data": {"translations": [{"translatedText": "こんにちは", "detectedSourceLanguage": "en"}]}}}]}])
run("google", "v2 usage notify", V2, [{"text": "x" * 60000, "responses": [{"data": {"data": {"translations": [{"translatedText": "a"}]}}}]},
                                      {"text": "y" * 60000, "responses": [{"data": {"data": {"translations": [{"translatedText": "b"}]}}}]},
                                      {"text": "z" * 30, "responses": [{"data": {"data": {"translations": [{"translatedText": "c"}]}}}]}])
run("google", "v2 free flag wins", dict(V2, google_free=True), [{"text": "a", "responses": [gdata("x")]}])
run("google", "v2 bad format", V2, [{"text": "a", "responses": [{"data": {"data": {}}}]}])
for i, m in enumerate(["API key not valid. Please pass a valid API key.", "Cloud Translation API has not been used in project 1", "API_KEY_SERVICE_BLOCKED", "Requests from referer <empty> are blocked", "Billing must be enabled", "other problem"]):
    run("google", "v2 hint %d" % i, V2, [{"text": "a", "responses": [err("T", "HTTP 403 " + m)]}])
run("google", "v2 glossary", dict(V2, glossary_google=True), [{"text": "LFM SFK", "responses": [{"data": {"data": {"translations": [{"translatedText": "[L1] [L2]"}]}}}]}])

C = {"translator": "custom", "target_lang": "한국어", "custom_key": "id:secret"}
def preset(name, **kw):
    p = tz.CUSTOM_PRESETS[name]
    return dict(C, custom_preset=name, custom_url=p[0], custom_headers=p[1], custom_body_type=p[2], custom_body=p[3], custom_path=p[4], **kw)
ans = {
    "DeepL Free": {"translations": [{"text": "딥엘"}]}, "DeepL Pro": {"translations": [{"text": "딥엘2"}]},
    "Azure Translator": [{"translations": [{"text": "애저"}]}], "Papago (NAVER Cloud)": {"message": {"result": {"translatedText": "파파고"}}},
    "LibreTranslate": {"translatedText": "리브레"}, "Claude (Anthropic API)": {"content": [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": "<think>x</think>클로드"}]},
    "Gemini (Google AI Studio)": {"candidates": [{"content": {"parts": [{"text": "제미니"}]}}]},
}
for name in tz.CUSTOM_PRESETS:
    run("custom", name, preset(name, glossary_mode="mixed"), [{"text": 'Hi {key} "q" LFM &x=1 [L1]', "responses": [{"data": ans[name]}]}])
    run("custom", name + " log", preset(name, log_request=True), [{"text": "Hello", "responses": [{"data": ans[name]}]}])
run("custom", "check url", dict(preset("DeepL Free"), custom_url="ftp://x"), [{"text": "a"}])
run("custom", "check headers", dict(preset("DeepL Free"), custom_headers="[1]"), [{"text": "a"}])
run("custom", "check headers bad", dict(preset("DeepL Free"), custom_headers="{x"), [{"text": "a"}])
run("custom", "check body", dict(preset("DeepL Free"), custom_body="{x"), [{"text": "a"}])
run("custom", "check path", dict(preset("DeepL Free"), custom_path=" "), [{"text": "a"}])
run("custom", "no key", dict(preset("DeepL Free"), custom_key=""), [{"text": "a"}])
run("custom", "no key needed", dict(preset("LibreTranslate"), custom_key="", custom_body='{"q": "{text}", "target": "{target}"}'), [{"text": "a", "responses": [{"data": {"translatedText": "x"}}]}])
run("custom", "path missing", preset("DeepL Free"), [{"text": "a", "responses": [{"data": {"translations": []}}]}, {"text": "b", "responses": [{"data": {"translations": [{"text": 5}]}}]}, {"text": "c", "responses": [{"data": {"translations": [{"text": "  "}]}}]}])
run("custom", "glossary masked", dict(preset("DeepL Free"), glossary_google=True), [{"text": "LFM [L2] SFK", "responses": [{"data": {"translations": [{"text": "[L3] [L2] [L4]"}]}}]}])
run("custom", "glossary masked replace", dict(preset("DeepL Free"), glossary_google=True, glossary_style="replace"), [{"text": "LFM ATM", "responses": [{"data": {"translations": [{"text": "[L1]!"}]}}]}])
run("custom", "thinking kept", dict(preset("Claude (Anthropic API)"), custom_body='{"model": "m", "thinking": {"type": "enabled"}, "system": "{system}", "messages": [{"role": "user", "content": "{text}"}]}'), [{"text": "a", "responses": [{"data": ans["Claude (Anthropic API)"]}]}])
run("custom", "other host no thinking", dict(preset("Claude (Anthropic API)"), custom_url="https://proxy.example/v1/messages", custom_body='{"system": "{system}", "text": "{text}"}'), [{"text": "a", "responses": [{"data": ans["Claude (Anthropic API)"]}]}])
run("custom", "http error", preset("DeepL Free"), [{"text": "a", "responses": [err("T", "HTTP 456 quota")]}])
run("custom", "form header kept", dict(preset("Papago (NAVER Cloud)"), custom_headers='{"Content-Type": "x/y", "A": "{key1}"}'), [{"text": "a b", "responses": [{"data": ans["Papago (NAVER Cloud)"]}]}])
run("custom", "target upper", dict(preset("DeepL Free"), target_lang="中文(简体)"), [{"text": "a", "responses": [{"data": ans["DeepL Free"]}]}])
run("custom", "outgoing custom", dict(preset("DeepL Free"), send_lang="English", send_route="custom"), [{"text": "안녕", "responses": [{"data": {"translations": [{"text": "hello"}]}}]}], outgoing=True)

json.dump(out, open(os.path.join(OUT, "translate.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0, sort_keys=True)
print({k: len(v) for k, v in out.items()})
