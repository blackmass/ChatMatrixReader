"""Runs the 2.0 Python functions on a corpus of inputs and stores the answers (tests/golden/*.json): the JS ports must give the same.
python tools/make_golden.py <path to ChatMatrixReader2/app>"""
import json, logging, os, sys, dataclasses
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "ChatMatrixReader2", "app")
sys.path.insert(0, SRC)
logging.disable(logging.CRITICAL)
import chattext as ct, joiner as jn, decoder as dec

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "golden")
os.makedirs(OUT, exist_ok=True)
L = lambda c, name: "\x02" + chr(48 + c) + name + "\x03"

TEXTS = [
    "hello world", "", "LFM [tank] +12 <3", "<Big Guild> recruiting <Other Guild>", "I <3 you", "<<A>> and <1234>",
    "Who needs " + L(4, "[Sword of Truth]") + "?", L(3, "[Boots]") + " " + L(2, "[Cloak]"), L(3, "[Only Link]"),
    "WTS " + L(5, "[센달 생존 전문가의 장화]\x04[Sendal's Boots of Survival]") + " 10k",
    "tip " + L(4, "[Item]\x07\x0b" + "3Blue line\x08\x08Plain line\x0c right\x08\x0b4purple") + " end",
    "quest " + L(10, "[Fetch Rats (1234)]") + " and " + L(10, "[Other (55)]") + " done",
    "unclosed \x02" + "4[Broken name", "stray \x02 and \x03 chars", "\x02" + "5[A]\x03\x02" + "5[B]\x03",
    L(20, "gibberish here"), "[SERVER] reboot in 5 minutes", "line\n\x02" + "3[N]\n",
    "한글 문장 " + L(3, "[아이템]") + " 입니다", "<길드명> 모집중입니다", "|1이;가; 퀘스트", "아이템|1을;를; 받았다", "세개|1으로;로; 이동", "5|1이;가; 맞다",
    "|Kx2|k", "see |Kx2|k and |Kx3|k", "  |Kx9|k  ", "[L1] hello [L2]", "[ L 3 ] x [l4] y （L5） 【L6】",
    "Hello [Link One] and [Link Two]!", "[Faction Banner]", "[A] [B] [C]",
]
FUNCS1 = ["mark_guilds", "split_guild", "resolve_josa", "readable", "plain", "mask_links", "is_unintelligible", "link_qualities",
          "link_tips", "hide_protected", "check_text", "has_original", "segments", "segments_tips", "split_tip", "tip_runs", "tip_plain"]
cases = []
for fn in FUNCS1:
    for t in TEXTS:
        r = getattr(ct, fn)(t)
        cases.append([fn, [t], r])
for t in TEXTS:
    cases.append(["plain_orig", [t, True], ct.plain(t, True)])
    cases.append(["segments_local", [t, False], ct.segments(t, False)])
    cases.append(["is_server_notice", ["!SY", t], ct.is_server_notice("!SY", t)])
    cases.append(["is_server_notice", ["P", t], ct.is_server_notice("P", t)])
for ch in ("@x", "P", "", "!SY"):
    cases.append(["is_command", [ch], ct.is_command(ch)])
for t in TEXTS:                                                                    # translator round trips
    masked, names = ct.mask_links(t)
    quals = ct.link_qualities(t)
    tips = ct.link_tips(t)
    for tr in (masked, masked.replace("[L1]", ""), masked + " [L9]", "번역: " + masked):
        cases.append(["ensure_links", [tr, names], list(ct.ensure_links(tr, names))])
        cases.append(["unmask_links", [tr, names], ct.unmask_links(tr, names)])
        cases.append(["split_translation", [tr, names, quals], ct.split_translation(tr, names, quals)])
        cases.append(["split_translation_tips", [tr, names, quals, tips], ct.split_translation(tr, names, quals, tips)])
    cases.append(["color_brackets", [t, quals], ct.color_brackets(t, quals)])
    cases.append(["color_brackets_tips", [t, quals, tips], ct.color_brackets(t, quals, tips)])
    cases.append(["color_brackets", [t, [3]], ct.color_brackets(t, [3])])
    cases.append(["color_brackets", [t, [3, 4, 5]], ct.color_brackets(t, [3, 4, 5])])
json.dump(cases, open(os.path.join(OUT, "chattext.json"), "w", encoding="utf-8"), ensure_ascii=False)
print(len(cases), "chattext cases")

# ---- joiner: sequences of (channel, id, sender, text, now) and flush times
def lines(seq):
    return [dataclasses.asdict(l) for l in seq]

def run(steps, timeout=1.0):
    j = jn.Joiner(timeout)
    out = []
    for st in steps:
        if st[0] == "feed":
            _, ch, i, who, text, now = st
            out.append(lines(j.feed(dec.Line(ch, i, who, text), now)))
        else:
            _, now, force = st
            out.append(lines(j.flush_due(now, force)))
    return out

C, CI = "\x05", "\x06"
F = lambda ch, i, who, text, now=0.0: ["feed", ch, i, who, text, now]
SC = []
SC.append([F("S", 1, "A", "plain line")])
SC.append([F("S", 1, "A", "first part" + C), F("S", 2, "A", C + "second part" + C), F("S", 3, "A", C + " end")])
SC.append([F("S", 1, "A", "first" + C), F("S", 2, "B", C + "other speaker")])
SC.append([F("S", 1, "A", "first" + C), F("S", 5, "A", C + "gap in ids")])
SC.append([F("S", 1, "A", "first" + C), F("S", 2, "A", "normal line")])
SC.append([F("S", 1, "A", "first" + C), ["flush", 0.5, False], ["flush", 1.5, False]])
SC.append([F("S", 1, "A", "first" + C), ["flush", 0.1, True]])
SC.append([F("S", 65535, "A", "wrap" + C), F("S", 1, "A", C + "around")])
SC.append([F("S", 7, "A", C + "continuation without start")])
SC.append([F("S", 7, "A", C + "continuation without start" + C), ["flush", 5, False]])
SC.append([F("S", 1, "A", "see " + "\x02" + "4[Long Na" + "\x03" + C), F("S", 2, "A", CI + "4me]" + "\x03" + " more")])
SC.append([F("S", 1, "A", "see " + "\x02" + "4[Long Na" + C), F("S", 2, "A", CI + "4me]\x03 more")])
SC.append([F("S", 1, "A", "x\x02" + "4[Name]\x03" + C), F("S", 2, "A", CI + "4[Name2]\x03 y")])
SC.append([F("S", 3, "A", CI + "4rest of name\x03 tail")])
SC.append([F("S", 3, "A", CI + "4local\x04orig\x03 tail")])
SC.append([F("S", 3, "A", CI + "4tip lines\x07x\x08y\x03 tail")])
SC.append([F("S", 3, "A", CI + "4tip lines\x07x\x08y" + C), F("S", 4, "A", CI + "4more\x03 tail")])
SC.append([F("S", 3, "A", CI + "4noclose")])
SC.append([F("S", 1, "A", "a" + C), F("S", 2, "A", C + "b" + C), ["flush", 3, False], F("S", 3, "A", C + "c")])
SC.append([F("S", 1, "A", "한글" + C), F("S", 2, "A", C + "이어짐")])
SC.append([F("S", 1, "A", "a" + C), F("S", 2, "A", CI), F("S", 3, "A", C + "x")])
json.dump([[s, run(s)] for s in SC], open(os.path.join(OUT, "joiner.json"), "w", encoding="utf-8"), ensure_ascii=False)
print(len(SC), "joiner scenarios")


# ---- pipeline: the same driver runs in Python here and in JS (tests/test_pipeline.mjs); the events must be equal
import config, pipeline as pl
from i18n import tr as _tr


class FakeService:
    def __init__(self):
        self.sent, self.ok = [], True

    def submit(self, token, text, route=None):
        if self.ok:
            self.sent.append([token, text, route])
        return self.ok


def ev_dict(e):
    d = dataclasses.asdict(e)
    d["type"] = type(e).__name__
    return d


BASE = dict(translator="google", target_lang="한국어", skip_same_lang=True, skip_regex="", skip_regex_hide=False, win1_off=[], channel_route={},
            show_time=True, class_colors=True, head_mode="basic")
CFGS = [
    ("default", {}, []),
    ("none", dict(translator="none"), []),
    ("regex_hide", dict(skip_regex="^lfm|\\d{4}", skip_regex_hide=True), []),
    ("windows", dict(win1_off=["S", "!NPC"]), [{"id": 3, "channels": ["S", "!NPC", "G"]}, {"id": 4, "channels": ["!ETC"]}]),
    ("routes", dict(channel_route={"G": "off", "P": "openai", "!NPC": "google_free"}), []),
]
CH = ["S", "P", "G", "W", "WT", "O", "C1", "CM", "E", "!MS", "!SY", "!LT", "!PG", "!CN", "!AD", "!UN", "!VC", "@x", "!RS", "R"]
PTXT = TEXTS + ["[restricted]", "◈ pinged you", "%s waves at you.", "LFM tank 1234 key", "!!!", "ㅋㅋㅋ", "<Guild>: hi there friend",
                "x" * 40 + " [link] " + L(3, "[A]") + " " + L(4, "[B]")]
steps = []
for i, ch in enumerate(CH):
    for j, t in enumerate(PTXT):
        sender = "" if (i + j) % 5 == 0 else "Nam%d" % (j % 4)
        steps.append([ch, i * 100 + j, sender, t, "ABKM"[(i + j) % 4] if (i + j) % 3 else "", (i + j) % 7 - 1])
out = []
for name, over, wins in CFGS:
    cfg = dict(BASE, **over)
    svc = FakeService()
    p = pl.Pipeline(lambda: cfg, svc, lambda: wins, now=lambda fmt: "12:00:00")
    events = []
    for ch, lid, who, t, cls, base in steps:
        evs = p.on_line(dec.Line(ch, lid, who, t, cls, base))
        events.append([ev_dict(e) for e in evs])
        for e in evs:
            if isinstance(e, pl.LineAdded) and e.pending:
                text = svc.sent[-1][1]
                n = e.line.id
                evs2 = p.on_translation(n, None if n % 11 == 0 else "번역: " + text, "boom" if n % 7 == 0 else None)
                events.append([ev_dict(x) for x in evs2])
    evs = p.on_translation(424242, "x", None)
    out.append(dict(name=name, cfg=cfg, windows=wins, steps=steps, events=events, sent=svc.sent))
# joiner through on_lines + tick, and the voice messages
cfg = dict(BASE)
svc = FakeService()
p = pl.Pipeline(lambda: cfg, svc, lambda: [], now=lambda fmt: "12:00:00")
pieces = [dec.Line("S", 1, "A", "first part " + "\x05"), dec.Line("S", 2, "A", "\x05second part"), dec.Line("S", 3, "B", "x\x05")]
evs = [ev_dict(e) for e in p.on_lines(pieces, 10.0)] + [ev_dict(e) for e in p.tick(10.5)] + [ev_dict(e) for e in p.tick(12.0)]
voice = [{"type": "partial", "text": "hel"}, {"type": "text", "text": "hello world"}, {"type": "partial", "text": ""}, {"type": "status", "state": "error", "msg": "not installed"},
         {"type": "status", "state": "error", "msg": "[timeout] slow"}, {"type": "status", "state": "ready"}, {"type": "warn", "msg": "w"}, {"type": "exit", "code": 3}, {"type": "level"}]
vev = [[ev_dict(e) for e in p.on_voice(m)] for m in voice]
json.dump(dict(runs=out, joined=evs, voice_in=voice, voice=vev), open(os.path.join(OUT, "pipeline.json"), "w", encoding="utf-8"), ensure_ascii=False)
print("pipeline golden:", len(CFGS), "configs x", len(steps), "lines")


# ---- window feeds: the events of the pipeline runs above go through a WindowFeed; the operations must be equal
import chatmodel as cm, windowfeed as wf, theme as th, fade as fd


def block_d(b):
    return dataclasses.asdict(b)


def ops_d(ops):
    out = []
    for op in ops:
        out.append([op[0]] + [block_d(x) if isinstance(x, cm.Block) else x for x in op[1:]])
    return out


feeds = []
for name, over, wins in CFGS[:1] + CFGS[3:4]:                      # default, and the one with extra windows
    for wid, swap, maxl in [(1, False, 10**6), (1, True, 10**6), (1, False, 30), (1, True, 25), (3, False, 40), (4, True, 12)]:
        if wid != 1 and not any(w["id"] == wid for w in wins):
            continue
        cfg = dict(BASE, **over, max_lines=maxl, swap_trans=False)
        conf = next((dict(w, max_lines=maxl, swap_trans=swap) for w in wins if w["id"] == wid), None)
        if wid == 1:
            cfg["swap_trans"] = swap
        svc = FakeService()
        p = pl.Pipeline(lambda: cfg, svc, lambda: wins, now=lambda fmt: "12:00:00")
        feed = wf.WindowFeed(wid, lambda: cfg, lambda: conf)
        log_ = []
        inject = [dec.Line("!XX", 1, "", "x")]
        for ch, lid, who, t, cls, base in steps[:400]:
            evs = p.on_line(dec.Line(ch, lid, who, t, cls, base))
            if lid % 37 == 0:
                evs.append(pl.Notice("system", "note %d" % lid, "12:00:00", False, "tag%d" % (lid % 3)))
            if lid % 53 == 0:
                evs.append(pl.Notice("remove", "", "", False, "tag%d" % (lid % 3)))
            for e in list(evs):
                if isinstance(e, pl.LineAdded) and e.pending:
                    n = e.line.id
                    evs += p.on_translation(n, None if n % 11 == 0 else "번역: " + svc.sent[-1][1], "boom" if n % 7 == 0 else None)
            for e in evs:
                log_.append([ev_dict(e), ops_d(feed.handle(e))])
        log_.append([{"type": "Translated", "id": 99999, "targets": [wid], "pieces": None, "error": None, "show_error": True}, ops_d(feed.handle(pl.Translated(99999, (wid,))))])
        feeds.append(dict(name=name, wid=wid, swap=swap, max_lines=maxl, cfg=cfg, conf=conf, windows=wins, log=log_,
                          blocks=[block_d(b) for b in feed.model.blocks], colors=[feed.model.color(b) for b in feed.model.blocks],
                          type_colors=feed.model.type_colors))
        feed.clear()
# theme and fade
tcases = []
for code in CH + ["C5", "CM", "RW", "BT", "I", "IL", "!ZZ", "ZZ", "trans", "error", "restricted", "system", "!PG"]:
    tcases.append(["channelTag", [code], th.channel_tag(code)])
    tcases.append(["defaultColor", [code], th.default_color(code)])
    for base in (-1, 0, 5, 20, 71, 999):
        tcases.append(["typeColor", [code, base], th.type_color(code, base)])
for q in (None, 3, 99, 51):
    for role, cls, text in [(None, None, "x"), ("sender", "A", "Bob"), ("sender", "Z", "Bob"), ("sender", None, "B"), ("guild", None, "<g>"), ("protmark", None, "⚠"), ("ping", None, "⚠"), ("ping", None, "x"), ("ping", None, "")]:
        pc = pl.Piece(text, q, (), role, cls)
        tcases.append(["pieceColor", [dataclasses.asdict(pc), "#123456"], th.piece_color(pc, "#123456")])
for tip in ([], ["plain"], ["\x0b3Blue name", "Head\x0cPlate", "a<b>&\"c'\x0b4purple"], ["x\x0cy\x0cz"]):
    tcases.append(["tipHtml", [tip], th.tip_html(tip)])
for age, sec, ms in [(0, 0, 500), (5, 10, 500), (10, 10, 500), (10.1, 10, 500), (10.25, 10, 500), (10.49, 10, 500), (10.5, 10, 500), (11, 10, 500), (30, 10, 0), (12, 10, 3000), (10.07, 10, 3000), (10.9, 10, 1000)]:
    tcases.append(["alpha", [age, sec, ms], fd.alpha(age, sec, ms)])
for i in range(0, 400):
    age = 10 + i * 0.013
    tcases.append(["alpha", [age, 10, 4000], fd.alpha(age, 10, 4000)])
json.dump(dict(feeds=feeds, theme=tcases), open(os.path.join(OUT, "feed.json"), "w", encoding="utf-8"), ensure_ascii=False)
print("feed golden:", len(feeds), "feeds,", len(tcases), "theme/fade cases")
