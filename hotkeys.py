"""Hotkey text ("Shift+Enter") <-> (modifiers, virtual-key) for the send box."""

MODS = ("Ctrl", "Alt", "Shift")
_NAMED = {
    "Enter": 0x0D, "Space": 0x20, "Tab": 0x09, "Backspace": 0x08, "Insert": 0x2D, "Delete": 0x2E,
    "Home": 0x24, "End": 0x23, "PageUp": 0x21, "PageDown": 0x22,
    "Left": 0x25, "Up": 0x26, "Right": 0x27, "Down": 0x28, "`": 0xC0,
}
_KEYS = dict(_NAMED)
_KEYS.update({f"F{i}": 0x6F + i for i in range(1, 13)})
_KEYS.update({chr(c): c for c in range(ord("A"), ord("Z") + 1)})
_KEYS.update({str(d): 0x30 + d for d in range(10)})
_ALIASES = {"RETURN": "Enter", "ESC": None, "CONTROL": "Ctrl", "CTL": "Ctrl", "PGUP": "PageUp", "PGDN": "PageDown",
            "DEL": "Delete", "INS": "Insert", "BACKSPACE": "Backspace", "SPACEBAR": "Space"}
DEFAULT = "Shift+Enter"


def parse(text):
    """'shift + enter' -> ({'Shift'}, 0x0D). Raises ValueError for anything unusable."""
    mods, key = set(), None
    for raw in str(text or "").replace(" ", "").split("+"):
        if not raw:
            continue
        up = raw.upper()
        name = _ALIASES.get(up, raw)
        if name is None:
            raise ValueError("Esc cannot be a hotkey")
        if name.capitalize() in MODS or up in ("SHIFT", "ALT", "CTRL"):
            mods.add(name.capitalize() if name.capitalize() in MODS else {"SHIFT": "Shift", "ALT": "Alt", "CTRL": "Ctrl"}[up])
            continue
        found = next((k for k in _KEYS if k.upper() == name.upper()), None)
        if found is None or key is not None:
            raise ValueError(f"unknown key: {raw}")
        key = found
    if key is None:
        raise ValueError("no key")
    return frozenset(mods), _KEYS[key]


def format_combo(mods, key_name):
    return "+".join([m for m in MODS if m in mods] + [key_name])


def normalize(text):
    """Canonical spelling ('ctrl+return' -> 'Ctrl+Enter'); raises ValueError if unusable."""
    mods, vk = parse(text)
    name = next(k for k, v in _KEYS.items() if v == vk)
    return format_combo(mods, name)


# --- Tk key names (for the "press the keys" dialog)
_TK_MODS = {"Shift_L": "Shift", "Shift_R": "Shift", "Control_L": "Ctrl", "Control_R": "Ctrl",
            "Alt_L": "Alt", "Alt_R": "Alt", "Meta_L": "Alt", "Meta_R": "Alt"}
_TK_KEYS = {"Return": "Enter", "KP_Enter": "Enter", "space": "Space", "Tab": "Tab", "BackSpace": "Backspace",
            "Insert": "Insert", "Delete": "Delete", "Home": "Home", "End": "End", "Prior": "PageUp", "Next": "PageDown",
            "Left": "Left", "Up": "Up", "Right": "Right", "Down": "Down", "grave": "`"}


def mod_of_keysym(keysym):
    return _TK_MODS.get(keysym)


def key_of_keysym(keysym):
    if keysym in _TK_KEYS:
        return _TK_KEYS[keysym]
    if len(keysym) == 1 and keysym.upper() in _KEYS:
        return keysym.upper()
    if keysym in _KEYS:                                   # F1..F12
        return keysym
    return None
