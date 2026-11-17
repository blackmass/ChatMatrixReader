"""2.0 outgoing / hotkeys / upkeep(pure parts) on a corpus -> tests/golden/send.json.   python tools/make_golden_send.py <ChatMatrixReader2/app>"""
import json, logging, os, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "ChatMatrixReader2", "app")
sys.path.insert(0, SRC)
logging.disable(logging.CRITICAL)
import outgoing as o, hotkeys as hk, upkeep as up, config, translator as t

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "golden", "send.json")
out = {"split": [], "clean": [], "pipes": [], "hotkeys": [], "prepare": [], "upkeep": []}
RAW = ["안녕하세요", "/w Bob 안녕", "/W Bob-Realm   안녕 하세요", "/r 고마워", "/1 판매합니다", "/p", "/w", "/dance", "/target Bob", "", "  /s  hi  ", "/say\nmulti\nline",
       "/whisper Bob", "/emote waves", "/me dances", "/10 x", "hello /w not", "/", "//x"]
for r in RAW:
    out["split"].append([r, list(o.split_command(r))])
CLEAN = ['  "Translation: LFM tank"  ', "a\n b\r\nc", "/invite Bob", "“Hello there”", "「こんにちは」", "'x'", "translated: ok", "번역: 좋아", '"Translation: "quoted""', "  //  /a", "", None, '""', '"', "«a b»", "Translation:", "x\n\n\ny"]
for c in CLEAN:
    out["clean"].append([c, o.clean_translation(c)])
for p in ["a|cffffffff b", "||", "none", ""]:
    out["pipes"].append([p, o.escape_pipes(p)])
for h in [" shift + return ", "Ctrl+Alt+F5", "ctrl+a", "F12", "Alt+`", "PgUp", "shift+del", "control+ins", "", "Shift", "Foo", "Esc", "A+B", "Shift+Shift+A", "ctl+space", "1", "shift + 0", "spacebar"]:
    try:
        mods, vk = hk.parse(h)
        out["hotkeys"].append([h, {"mods": sorted(mods), "vk": vk, "norm": hk.normalize(h)}])
    except ValueError:
        out["hotkeys"].append([h, "error"])
CFG = {"send_lang": "English"}
for raw, fake in [("탱커 구함", '  "Translation: LFM tank"  '), ("/w Bob 탱커 구함", "LFM tank"), ("/dance", "x"), ("12345", "x"), ("명령", "/invite Bob"), ("줄바꿈", "line one\nline two"),
                  ("파이프", "a|cffffffff b"), ("길게", "x" * 300), ("", "x"), ("   ", "x"), ("/w Bob", "x"), ("/w", "x"), ("/w " + "a" * 40 + " 안녕", "EN:안녕"),
                  ("안녕", ""), ("안녕", '""'), ("한글" * 100, "ok"), ("/s " + "가" * 90, "x"), ("/dance " + "x" * 300, "y"), ("안녕", "TRANSLATE_ERROR")]:
    def fn(c, text, fake=fake):
        if fake == "TRANSLATE_ERROR": raise t.TranslateError("HTTP 500 boom")
        return fake
    try:
        r = o.prepare(CFG, raw, translate_fn=fn)
        out["prepare"].append([raw, fake, {"text": r.text, "translated": r.translated, "note": r.note}])
    except o.OutgoingError as e:
        out["prepare"].append([raw, fake, {"error": str(e)}])
base = dict(config.DEFAULTS)
CFGS = [base, dict(base, translator="openai"), dict(base, translator="none"), dict(base, translator="google", channel_route={"G": "openai"}),
        dict(base, translator="custom", custom_body='{"system": "{system}"}'), dict(base, translator="custom", custom_body='{}'), dict(base, translator="google", google_free=True, google_api_key="k"),
        dict(base, translator="google", google_api_key=" k "), dict(base, translator="none", send_route="openai", send_enabled=True), dict(base, translator="none", send_route="openai", send_enabled=False),
        dict(base, translator="openai", api_url="u", api_model="m", api_key="k"), dict(base, translator="custom", custom_url="u", custom_key="k", custom_headers="h", custom_body="b")]
for c in CFGS:
    out["upkeep"].append([{k: c[k] for k in ("translator", "channel_route", "custom_body", "google_free", "google_api_key", "send_route", "send_enabled", "api_url", "api_model", "api_key", "custom_url", "custom_key", "custom_headers", "translate_test_start")},
                          {"ai_mode": up.ai_mode(c), "conn_key": {k: list(v) for k, v in up.conn_key(c).items()},
                           "mode_key": {m: list(up.mode_key(c, m)) for m in ("openai", "google", "custom", "none")}, "start": up.ConnWatch().start_modes(c)}])
json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, sort_keys=True)
print({k: len(v) for k, v in out.items()})
