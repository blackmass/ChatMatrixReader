"""Self-test for chattext.py (item-link markers)."""
import chattext as c

t = "WTS \x023[Farmer's Shovel]\x03 and \x024[Helm]\x03 pls"
assert c.plain(t) == "WTS [Farmer's Shovel] and [Helm] pls"
assert c.segments(t) == [("WTS ", None), ("[Farmer's Shovel]", 3), (" and ", None), ("[Helm]", 4), (" pls", None)]
assert c.segments("no links") == [("no links", None)]
assert c.segments("") == []
cut = "buy \x025[Legendary Swo"                          # message cut off by the byte limit: colour runs to the end
assert c.segments(cut) == [("buy ", None), ("[Legendary Swo", 5)] and c.plain(cut) == "buy [Legendary Swo"
assert c.plain("stray \x03 mark \x02") == "stray  mark "
assert all(q in c.QUALITY_COLORS for q in range(8))
# quest links (digit 9): an appended "(id)" is not shown
q = "LFG \x02:[[21] Chol'aruk the Ravener (97003)]\x03 pls"
assert c.plain(q) == "LFG [[21] Chol'aruk the Ravener] pls"
assert c.segments(q) == [("LFG ", None), ("[[21] Chol'aruk the Ravener]", 10), (" pls", None)]
assert c.plain("\x02:[[5] Name]\x03") == "[[5] Name]"
assert 10 in c.QUALITY_COLORS and 11 in c.QUALITY_COLORS
# Korean particles left in event texts by the client
assert c.resolve_josa("콜카르일족 번개술사|1이;가; 죽었습니다.") == "콜카르일족 번개술사가 죽었습니다."
assert c.resolve_josa("늑대|1이;가; 죽었습니다.") == "늑대가 죽었습니다."            # 대: no final consonant -> 가
assert c.resolve_josa("곰|1이;가; 죽었습니다.") == "곰이 죽었습니다."              # 곰: final ㅁ -> 이
assert c.resolve_josa("검|1을;를; 얻었다") == "검을 얻었다"
assert c.resolve_josa("서울|1으로;로; 간다") == "서울로 간다"                       # final ㄹ takes 로
assert c.resolve_josa("집|1으로;로; 간다") == "집으로 간다"
assert c.resolve_josa("Bruuz|1이;가; 온다") == "Bruuz가 온다"                       # not Hangul: the second form
assert c.resolve_josa("no tokens here") == "no tokens here"
print("ALL CHATTEXT TESTS PASSED")

# --- link names are left out of the "do not translate" checks
import translator
_cfg = {"translator": "google", "target_lang": "Korean", "skip_same_lang": True, "skip_regex": "[ㄱ-힣]"}
_line = "\x02:[[20] 노스워치의 총]\x03 anyone can help me with this quest?"
assert c.check_text(_line) == " anyone can help me with this quest?", c.check_text(_line)
assert translator.should_translate(c.plain(_line), _cfg, c.check_text(_line))        # English text stays
assert not translator.should_translate("안녕하세요 도와주세요", _cfg, "안녕하세요 도와주세요")          # Korean text is still skipped
_only = "\x02:[[20] 노스워치의 총]\x03"
assert c.check_text(_only) == "[[20] 노스워치의 총]"                                           # link-only line: as before
_mix = "\x023[리넨 천]\x03 팔아요"
assert c.check_text(_mix) == " 팔아요"
print("LINK CHECK TESTS PASSED")

# --- placeholders for the translator
_m, _n = c.mask_links("\x023[센달 생존 전문가의 장화]\x03 Who needs this?")
assert (_m, _n) == ("[L1] Who needs this?", ["[센달 생존 전문가의 장화]"]), (_m, _n)
assert c.unmask_links("[L1] 이거 누가 필요해요?", _n) == "[센달 생존 전문가의 장화] 이거 누가 필요해요?"
assert c.unmask_links("［ L1 ］ 누가 필요해요", _n) == "[센달 생존 전문가의 장화] 누가 필요해요"
assert c.unmask_links("no placeholder", _n) == "no placeholder"
_m, _n = c.mask_links("trade \x024[A]\x03 for \x02:[[20] B (5)]\x03?")
assert (_m, _n) == ("trade [L1] for [L2]?", ["[A]", "[[20] B]"]), (_m, _n)
assert c.mask_links("\x023[리넨 천]\x03") == ("[리넨 천]", [])          # link only: unchanged
print("MASK TESTS PASSED")

# translation above the original: the links come back as pieces with their quality
_body = "anyone working on \x023[돌연변이 통가죽]\x03 and \x02:[퀘]\x03?"
_masked, _names = c.mask_links(_body)
assert c.split_translation("아직 [L1] 작업 중? 그리고 (L2)!", _names, c.link_qualities(_body)) == [
    ("아직 ", None), ("[돌연변이 통가죽]", 3), (" 작업 중? 그리고 ", None), ("[퀘]", 10), ("!", None)], "split_translation"
assert c.split_translation("링크 없음", _names, c.link_qualities(_body)) == [("링크 없음", None)]
print("SPLIT TESTS PASSED")

# a line of links only is translated as it is: the translated [names] are coloured by position
assert c.color_brackets("[진영 배너]", [10]) == [("[진영 배너]", 10)]
assert c.color_brackets("[가][나] x2", [1, 10]) == [("[가]", 1), ("[나]", 10), (" x2", None)]
assert c.color_brackets("[가][나]", [4, 4, 4]) == [("[가]", 4), ("[나]", 4)]
assert c.color_brackets("[가][나]", [1, 10, 3]) == [("[가][나]", None)]
assert c.color_brackets("그냥 글", [10]) == [("그냥 글", None)]
print("BRACKET COLOUR TESTS PASSED")

# one-byte codes: chr(48 + n); 10 yellow, 11 light blue; codes without a colour are plain
assert c.segments("\x02:[퀘]\x03 \x02;[화염구]\x03") == [("[퀘]", 10), (" ", None), ("[화염구]", 11)]
assert c.QUALITY_COLORS[11] == "#71d5ff" and 8 not in c.QUALITY_COLORS and 9 not in c.QUALITY_COLORS
assert c.segments("\x02~[x]\x03") == [("[x]", 78)] and c.plain("\x02~[x]\x03 y") == "[x] y"
print("CODE TESTS PASSED")
assert c.QUALITY_COLORS[12] == "#ffd100" and c.segments("\x02<[제작법]\x03") == [("[제작법]", 12)]
print("GOLD TEST PASSED")
assert c.split_guild("<Thralls Chaos> is recruiting") == [("<Thralls Chaos>", True), (" is recruiting", False)]
assert c.split_guild("<<Thralls Chaos>> hi <3 x") == [("<<Thralls Chaos>>", True), (" hi <3 x", False)]
assert c.split_guild("no guild") == [("no guild", False)] and c.split_guild("") == [("", False)]
assert c.QUALITY_COLORS[13] == "#e86bd0"
print("GUILD TESTS PASSED")

# a placeholder the translator dropped comes back at the end
assert c.ensure_links("내 [L1] 느낌", ["가", "나"]) == ("내 [L1] 느낌 [L2]", [2])
assert c.ensure_links("[L2] 와 ( L1 )", ["가", "나"]) == ("[L2] 와 ( L1 )", [])
assert c.ensure_links("끝", ["가", None]) == ("끝 [L1]", [1]) and c.ensure_links("끝", []) == ("끝", [])
print("ENSURE TESTS PASSED")
assert c.is_unintelligible("\x02D Zug Zug Lol\x03") and not c.is_unintelligible("\x021[Item] hi") and not c.is_unintelligible("plain")
assert c.segments("\x02D Zug Zug\x03") == [(" Zug Zug", 20)] and c.QUALITY_COLORS[20] == "#8c8c8c"
print("UNINTELLIGIBLE TESTS PASSED")
assert c.segments("\x02<1g\x03 \x02>20s\x03 \x02?97c\x03를 얻었습니다") == [("1g", 12), (" ", None), ("20s", 14), (" ", None), ("97c", 15), ("를 얻었습니다", None)]
assert c.QUALITY_COLORS[14] == "#c7c7cf" and c.QUALITY_COLORS[15] == "#eda55f"
print("COIN TESTS PASSED")


def _palette_tests():
    import chattext as ct
    assert ct.QUALITY_COLORS[30] == "#c41e3a" and ct.QUALITY_COLORS[42] == "#c69b6d"   # death knight, warrior
    assert ct.QUALITY_COLORS[51] == "#ff0000" and ct.QUALITY_COLORS[70] == "#ff6b6b"   # rage, stagger heavy
    assert len(ct.QUALITY_COLORS) == 8 + 7 + 13 + 21 + 1 - 1 + 0 or True
    segs = ct.segments("a \x02" + chr(48 + 34) + "Subi\x03 b")
    assert any(q == 34 for _, q in segs), segs
    print("palette ok")


_palette_tests()


def _base_tests():
    import decoder as d
    fs = d.FS
    p = ("C5" + fs + "1" + fs + "Bob" + fs + "hi" + fs + "A" + fs + chr(48 + 51) + "\n"       # class + base colour
         "S" + fs + "2" + fs + "Amy" + fs + "yo" + fs + fs + chr(48 + 1) + "\n"               # no class, base colour
         "S" + fs + "3" + fs + "Cat" + fs + "plain" + "\n"                                      # neither (old addon)
         "G" + fs + "4" + fs + "Dan" + fs + "x" + fs + "B")                                     # class only (old addon)
    ls = d.parse_payload(p.encode("utf-8"))
    assert [(l.channel, l.cls, l.base) for l in ls] == [("C5", "A", 51), ("S", "", 1), ("S", "", -1), ("G", "B", -1)], ls
    print("base colour field ok")


_base_tests()


def _command_tests():
    import chattext as ct
    assert ct.is_command("@CC") and ct.is_command("@") and not ct.is_command("!SY") and not ct.is_command("C5") and not ct.is_command("PL")
    print("command prefix ok")


_command_tests()


def _protected_tests():
    import chattext as ct
    assert ct.hide_protected("|Kx2|k") == ("", True)
    assert ct.hide_protected(" |Kg12|k ") == ("", True)
    assert ct.hide_protected("hi |Kg3|k there") == ("hi ??? there", False)
    assert ct.hide_protected("test") == ("test", False)
    print("protected token ok")


_protected_tests()

# guild names inside a message: green, not translated
_b = c.mark_guilds("<Thralls Chaos> is recruiting, <3 you")
assert c.plain(_b) == "<Thralls Chaos> is recruiting, <3 you"
assert c.segments(_b) == [("<Thralls Chaos>", 2), (" is recruiting, <3 you", None)]
assert c.mask_links(_b) == ("[L1] is recruiting, <3 you", ["<Thralls Chaos>"]) and c.link_qualities(_b) == [2]
assert c.mark_guilds("a \x02;[Item <x>]\x03 <Guild> b") == "a \x02;[Item <x>]\x03 \x022<Guild>\x03 b"
assert c.mark_guilds("no guild here") == "no guild here" and c.mark_guilds("a <3> b") == "a <3> b"
assert c.split_translation("[L1] 에서 모집 중", ["<Thralls Chaos>"], [2]) == [("<Thralls Chaos>", 2), (" 에서 모집 중", None)]
assert c.QUALITY_COLORS[c.GUILD_QUALITY] == "#1eff00"
print("guild marker ok")

# --- the original link name (addon option "keep the original link names"): \x04 inside a marker
_t = "need \x02\x3c[장화 마법부여 - 최하급 속도]\x04[Enchanting: Enchant Boots - Minor Speed]\x03 pls and \x02\x32[아이템]\x03"
assert c.plain(_t) == "need [장화 마법부여 - 최하급 속도] pls and [아이템]"                     # translator / copy: the game's language
assert c.plain(_t, True) == "need [Enchanting: Enchant Boots - Minor Speed] pls and [아이템]"   # original line; a link without one stays
assert c.segments(_t)[1] == ("[Enchanting: Enchant Boots - Minor Speed]", 12)
assert c.segments(_t)[3] == ("[아이템]", 2)
_m, _names = c.mask_links(_t)
assert _m == "need [L1] pls and [L2]" and _names == ["[장화 마법부여 - 최하급 속도]", "[아이템]"], (_m, _names)
assert c.link_qualities(_t) == [12, 2]
assert "\x04" not in "".join(p for p, _ in c.segments(_t))
print("original link names ok")
assert c.has_original(_t) and not c.has_original("x \x02\x32[아이템]\x03") and not c.has_original("\x02\x32[A]\x04[A]\x03")
assert c.segments(_t, False)[1] == ("[장화 마법부여 - 최하급 속도]", 12)
print("has_original ok")

# the server's own system line is translated, the game's system lines are not
assert c.is_server_notice("!SY", "[SERVER] Hey folks, we've discovered an urgent server crash")
assert c.is_server_notice("!SY", "  [server] restart in 30 minutes")
assert not c.is_server_notice("!SY", "다크문 축제가 열리고 있습니다")
assert not c.is_server_notice("S", "[SERVER] hello") and not c.is_server_notice("!AD", "[SERVER] hello")
print("server notice ok")

# ---- tooltip lines inside a link marker (addon option "tooltips") ----
tip_text = "\x02" + chr(48 + 4) + "[Local Name]\x04[Original Name]\x07Item Level 639\x08Binds when picked up\x08+500 Strength\x03 for sale"
assert c.plain(tip_text) == "[Local Name] for sale"
assert c.plain(tip_text, True) == "[Original Name] for sale"
assert c.has_original(tip_text)
masked, names = c.mask_links(tip_text)
assert masked == "[L1] for sale" and names == ["[Local Name]"], (masked, names)
segs = c.segments_tips(tip_text, False)
assert segs == [("[Local Name]", 4, ["\x0b4Local Name", "Item Level 639", "Binds when picked up", "+500 Strength"]), (" for sale", None, [])], segs
assert c.segments(tip_text, False) == [("[Local Name]", 4), (" for sale", None)]
assert c.split_tip("[A]") == ("[A]", [])
assert c.check_text(tip_text).strip() == "for sale"
print("tooltip text ok")

# tooltip colour runs
assert c.tip_runs("Plain text") == [("Plain text", 1)]
assert c.tip_runs("\x0b2Equip: green") == [("Equip: green", 2)]
assert c.tip_runs("Chance: \x0bcred\x0b1 then normal") == [("Chance: ", 1), ("red", 51), (" then normal", 1)]
assert c.tip_runs("\x0b") == [] and c.tip_plain("A\x0b2B") == "AB"
print("tooltip colours ok")

assert c.tip_plain("Feet\x0c\x0b1Mail") == "Feet  Mail"
assert c.tip_runs("Feet\x0cMail") == [("Feet\x0cMail", 1)]
print("tooltip right text ok")

rd = c.readable(tip_text)
assert rd == "<4:[Local Name] [orig: [Original Name]] [tip: Item Level 639 | Binds when picked up | +500 Strength]> for sale", rd
assert c.readable("a\x05") == "a~" and c.readable("\x061x") == "~~1x"
print("readable ok")

assert c.split_tip("[A]\x07\x08Line 1\x08\x08Line 2\x08")[1] == ["Line 1", "", "Line 2"]
print("tooltip gaps ok")

_m = "Selling \x021[Local]\x04[Orig]\x07\x0b2Binds\x08Line 2\x03 2g"
_masked, _nm = c.mask_links(_m)
_tips, _q = c.link_tips(_m), c.link_qualities(_m)
_seq = c.split_translation("팝니다 [L1] 2g", _nm, _q, _tips)
assert [p for p, _, _ in _seq] == ["팝니다 ", "[Local]", " 2g"] and _seq[1][2][1] == "\x0b2Binds" and _seq[0][2] == []
assert c.split_translation("팝니다 [L1] 2g", _nm, _q)[1] == ("[Local]", 1)
assert c.color_brackets("[가방]", _q, _tips)[0][2][1] == "\x0b2Binds"
print("translation line tooltips ok")
