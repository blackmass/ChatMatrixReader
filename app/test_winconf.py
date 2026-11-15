"""Self-test: child window settings (winconf.py): channel keys, normalising the saved list, filters."""
import os
import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import winconf as c
assert c.chan_key("!MS") == "!NPC" and c.chan_key("!BW") == "!NPC" and c.chan_key("C3") == "C3" and c.chan_key("C11") == c.ETC
assert c.chan_key("!VC") == "!VC" and c.chan_key("!AD") == c.ETC and c.chan_key("S") == "S" and c.chan_key("CM") == "CM"
# empty / broken settings -> window 2 exists, voice channel only, switched off
n = c.normalize([])
assert [d["id"] for d in n] == [2] and n[0]["channels"] == ["!VC"] and n[0]["open_mode"] == "never"
assert c.normalize(None)[0]["id"] == 2 and c.normalize("x")[0]["id"] == 2
n = c.normalize([{"id": 5, "enabled": 1, "channels": ["S", 7], "opacity": "x"}, {"id": 5}, {"id": 1}, {"id": "a"}, 3,
                 {"id": 3, "name": "N", "font_size": "12", "opacity": 5}, {"id": 6, "opacity": 0.5}])
assert [d["id"] for d in n] == [2, 3, 5, 6], n
assert n[3]["bg_opacity"] == 0.5 and n[3]["text_opacity"] == 0.5          # the old single opacity
d5 = n[2]
assert d5["open_mode"] == "always" and d5["channels"] == ["S"] and d5["bg_opacity"] == 1.0 and d5["text_opacity"] == 1.0 and d5["font_size"] == 0
d3 = n[1]
assert d3["name"] == "N" and d3["font_size"] == 12 and d3["bg_opacity"] == 1.0 and d3["text_opacity"] == 1.0
assert set(d3) == set(c.KEYS)
# a saved window 2 keeps its choices
n = c.normalize([{"id": 2, "open_mode": "voice", "channels": ["!VC", "S"]}])
assert len(n) == 1 and n[0]["open_mode"] == "voice" and n[0]["channels"] == ["!VC", "S"]
n = c.normalize([{"id": 3, "open_mode": "voice"}, {"id": 4, "open_mode": "bogus"}, {"id": 5, "open_mode": "always"}])
assert [d["open_mode"] for d in n] == ["never", "never", "never", "always"], n         # "voice" only for window 2
assert c.next_id(c.normalize([])) == 3 and c.next_id(c.normalize([{"id": 9}])) == 10
# window order / mouse options: defaults, and "only above the game" excludes "always on top"
d = c.normalize([])[0]
assert d["topmost"] is True and d["topmost_wow_only"] is False and d["click_through"] is False and d["hover_clear"] is False
d = c.normalize([{"id": 2, "topmost": True, "topmost_wow_only": True, "click_through": 1}])[0]
assert d["topmost"] is False and d["topmost_wow_only"] is True and d["click_through"] is True
# filters
assert c.accepts({"channels": ["!VC"]}, "!VC") and not c.accepts({"channels": ["!VC"]}, "S") and not c.accepts({"channels": []}, "S")
assert c.accepts({"channels": ["!NPC"]}, "!MY") and c.accepts({"channels": [c.ETC]}, "!SY")
assert c.parent_shows({}, "S") and c.parent_shows({"win1_off": []}, "!VC") and not c.parent_shows({"win1_off": ["!VC"]}, "!VC")
assert not c.parent_shows({"win1_off": [c.ETC]}, "!AD") and c.parent_shows({"win1_off": [c.ETC]}, "S")
assert c.valid_geometry("420x260+10+20") and c.valid_geometry("420x260") and c.valid_geometry("420x260+-5+-8") and not c.valid_geometry("x")
# config.load keeps the list valid
import config
cfg = config.load()
assert cfg["child_windows"][0]["id"] == 2 and cfg["win1_off"] == []
print("winconf ok")

# --- "line head" setting
import winconf as _cw
assert _cw.head_mode({}) == "basic" and _cw.head_mode({"channel_detail": True}) == "detail"
assert _cw.head_mode({"head_mode": "body", "channel_detail": True}) == "body" and _cw.head_mode({"head_mode": "x"}) == "basic"
assert all(c["head_mode"] == "basic" for c in _cw.normalize([{"id": 3, "head_mode": "zzz"}]))
assert _cw.normalize([{"id": 3, "head_mode": "nochan"}])[-1]["head_mode"] == "nochan"
print("head mode ok")
assert _cw.normalize([{"id": 3, "align": "center"}])[-1]["align"] == "center" and _cw.normalize([{"id": 3, "align": "x"}])[-1]["align"] == "left"
print("align ok")
assert _cw.normalize([{"id": 3, "bottom": 1}])[-1]["bottom"] is True and _cw.normalize([{"id": 3}])[-1]["bottom"] is False
print("bottom ok")
n = _cw.normalize([{"id": 3, "max_lines": 99999, "show_time": 0, "swap_trans": 1, "line_spacing": "x"}])[-1]
assert n["max_lines"] == 5000 and n["show_time"] is False and n["swap_trans"] is True and "line_spacing" not in n and "class_colors" not in n
assert _cw.opt({}, {"max_lines": 500}, "max_lines") == 500 and _cw.opt({"max_lines": 100}, {"max_lines": 500}, "max_lines") == 100
assert _cw.opt({"show_time": False}, {"show_time": True}, "show_time") is False
print("own settings ok")
