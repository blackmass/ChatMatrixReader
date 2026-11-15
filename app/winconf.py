"""Settings of the chat windows (no window code, no Qt): which channels a window shows, how its lines are headed and aligned,
and the clean-up of the saved list. The same rules hold for the main window and for every extra window.

Window 1 is the main window (its settings live at the top level of the config); the extra windows are a list. Window 2 (voice
recognition) always exists and cannot be deleted, it is only switched on or off. A setting an extra window does not have of
its own is taken from window 1 (opt()).
"""
import re


SPEECH_CODES = ("!MS", "!MY", "!ME", "!MW", "!MP", "!BE", "!BW")
ETC = "!ETC"                                   # everything that has no row of its own (loot, system, other codes ...)
KNOWN = ("S", "Y", "E", "P", "PL", "R", "RL", "RW", "I", "IL", "G", "O", "W", "B", "WT", "BT", "CM",
         *[f"C{n}" for n in range(1, 11)], "!NPC", "!VC")
VOICE_ID = 2                                   # the window that cannot be deleted
ALIGNS = ("left", "center", "right")           # where the text of the lines sits in the window
HEADS = ("detail", "basic", "nochan", "body")   # what stands before a line: channel code too | as the game | no channel mark | only the text
MODES = ("always", "voice", "never")         # when the window is open: always | only while the voice recognition runs (window 2) | never (opened by hand)
KEYS = {"id": 0, "name": "", "open_mode": "never", "channels": [], "geometry": "", "font_family": "", "font_size": 0,
        "bg_opacity": 1.0, "text_opacity": 1.0, "topmost": True, "topmost_wow_only": False, "click_through": False, "hover_clear": False, "head_mode": "basic", "align": "left", "bottom": False}


def chan_key(code: str) -> str:
    """The row of the channel lists a line belongs to."""
    if code in SPEECH_CODES:
        return "!NPC"
    return code if code in KNOWN else ETC


def new_conf(wid: int, channels=()):
    d = dict(KEYS)
    d.update(id=int(wid), channels=list(channels))
    return d


def normalize(items):
    """The saved list -> a clean list: dicts with every key, unique ids, window 2 present (first)."""
    out, seen = [], set()
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        try:
            wid = int(it.get("id"))
        except (TypeError, ValueError):
            continue
        if wid < 2 or wid in seen:
            continue
        seen.add(wid)
        d = new_conf(wid)
        d.update({k: it[k] for k in KEYS if k in it and k != "id"})
        if "open_mode" not in it and it.get("enabled"):          # (the first prototype had a "use" check box)
            d["open_mode"] = "always"
        if d["open_mode"] not in MODES or (d["open_mode"] == "voice" and wid != VOICE_ID):
            d["open_mode"] = "never"
        d["channels"] = [c for c in d["channels"] if isinstance(c, str)] if isinstance(d["channels"], list) else []
        if "opacity" in it and "bg_opacity" not in it and "text_opacity" not in it:      # (the first prototype had one opacity)
            d["bg_opacity"] = d["text_opacity"] = it["opacity"]
        try:
            d["bg_opacity"] = min(1.0, max(0.03, float(d["bg_opacity"])))
            d["text_opacity"] = min(1.0, max(0.2, float(d["text_opacity"])))
            d["font_size"] = int(d["font_size"])
        except (TypeError, ValueError):
            d["bg_opacity"] = d["text_opacity"] = 1.0
            d["font_size"] = 0
        for k in ("topmost", "topmost_wow_only", "click_through", "hover_clear", "bottom"):
            d[k] = bool(d[k])
        if d["align"] not in ALIGNS:
            d["align"] = "left"
        if d["head_mode"] not in HEADS:
            d["head_mode"] = "basic"
        for k, (lo, hi) in OPT_NUM.items():                      # (only those the window has: the others follow the main window)
            if k in it:
                try:
                    d[k] = max(lo, min(hi, int(it[k])))
                except (TypeError, ValueError):
                    pass
        for k in OPT_BOOL:
            if k in it:
                d[k] = bool(it[k])
        if d["topmost_wow_only"]:
            d["topmost"] = False                                 # the two modes exclude each other (like the main window's options)
        d["name"] = d["name"] if isinstance(d["name"], str) else ""
        out.append(d)
    if VOICE_ID not in seen:
        out.append(new_conf(VOICE_ID, ["!VC"]))
    out.sort(key=lambda d: d["id"])
    return out


def next_id(items) -> int:
    return max([VOICE_ID] + [d["id"] for d in items]) + 1


# Settings an extra window may have of its own; one it does not have (yet) is taken from the main window.
OPT_NUM = {"max_lines": (50, 5000), "trans_font_size": (0, 32), "line_spacing": (0, 40), "group_spacing": (0, 60)}
OPT_BOOL = ("show_time", "class_colors", "swap_trans")


def opt(conf, cfg, key, default=None):
    """The value of a setting for the window `conf`: its own when it has one, else the main window's (`cfg`)."""
    v = conf.get(key)
    return cfg.get(key, default) if v is None else v


def head_mode(conf) -> str:
    """The "line head" setting of a window (the main window: the settings; the old option "channel codes in detail" counts)."""
    m = conf.get("head_mode")
    if m in HEADS:
        return m
    return "detail" if conf.get("channel_detail") else "basic"


def accepts(conf, code: str) -> bool:
    return chan_key(code) in set(conf.get("channels") or ())


def parent_shows(cfg, code: str) -> bool:
    """The main window: every channel unless unticked (a new kind of line is on by default)."""
    return chan_key(code) not in set(cfg.get("win1_off") or ())


def valid_geometry(g) -> bool:
    return bool(re.fullmatch(r"\d+x\d+([+-]-?\d+[+-]-?\d+)?", g or ""))
