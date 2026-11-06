"""Item-link markers inside chat text.

The addon turns a link into  \\x02 <quality 0-8> [Item Name] \\x03  (quality = item rarity: 0 grey, 1 white,
2 green, 3 blue, 4 purple, 5 orange, 6 artifact, 7 heirloom). The window colours the name; the translator
gets the same text without the markers.
"""
import re

_MARK = re.compile("\x02(\\d)(.*?)(?:\x03|$)", re.S)
_STRAY = re.compile("[\x02\x03]")

QUALITY_COLORS = {
    0: "#9d9d9d", 1: "#ffffff", 2: "#1eff00", 3: "#4a9eff", 4: "#c06bff",
    5: "#ff8000", 6: "#e6cc80", 7: "#00ccff", 8: "#00ccff",
}


def plain(text):
    """Text without markers (what gets translated / copied)."""
    return _STRAY.sub("", _MARK.sub(lambda m: m.group(2), text))


def segments(text):
    """[(piece, quality or None)] - quality is set for item-link pieces."""
    out, pos = [], 0
    for m in _MARK.finditer(text):
        if m.start() > pos:
            out.append((_STRAY.sub("", text[pos:m.start()]), None))
        out.append((m.group(2), int(m.group(1))))
        pos = m.end()
    if pos < len(text):
        out.append((_STRAY.sub("", text[pos:]), None))
    return [(p, q) for p, q in out if p]
