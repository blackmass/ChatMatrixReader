"""Item-link markers inside chat text.

The addon turns a link into  \\x02 <quality 0-8> [Item Name] \\x03  (quality = item rarity: 0 grey, 1 white,
2 green, 3 blue, 4 purple, 5 orange, 6 artifact, 7 heirloom). The window colours the name; the translator
gets the same text without the markers.
"""
import re

_MARK = re.compile("\x02(\\d)(.*?)(?:\x03|$)", re.S)
_STRAY = re.compile("[\x02\x03]")

CLASS_COLORS = {          # speaker class letter (PROTOCOL.md) -> the game's class colour
    "A": "#C69B6D", "B": "#F48CBA", "C": "#AAD372", "D": "#FFF468", "E": "#FFFFFF", "F": "#C41E3A", "G": "#0070DD",
    "H": "#3FC7EB", "I": "#8788EE", "J": "#00FF98", "K": "#FF7C0A", "L": "#A330C9", "M": "#33937F",
}
QUALITY_COLORS = {
    0: "#9d9d9d", 1: "#ffffff", 2: "#1eff00", 3: "#4a9eff", 4: "#c06bff",
    5: "#ff8000", 6: "#e6cc80", 7: "#00ccff", 8: "#00ccff",
    9: "#ffff00",             # 9 = quest link (yellow)
}

_QUEST_ID = re.compile(r"\s*\(\d+\)(\]?)$")
_JOSA = re.compile(r"\|1([^;|]*);([^;|]*);")


def _has_final_consonant(ch):
    if "\uac00" <= ch <= "\ud7a3":
        return (ord(ch) - 0xAC00) % 28 != 0
    return ch in "013678"                      # digits read in Korean: 영 일 삼 육 칠 팔 end in a consonant


def resolve_josa(text):
    """The Korean client leaves particles as  |1이;가;  in event texts (the game picks one when it draws the line):
    take the first form after a letter with a final consonant, else the second."""
    def pick(m):
        prev = text[m.start() - 1] if m.start() > 0 else ""
        first, second = m.group(1), m.group(2)
        if not prev or not _has_final_consonant(prev):
            return second
        if first.startswith("\uc73c") and "\uac00" <= prev <= "\ud7a3" and (ord(prev) - 0xAC00) % 28 == 8:
            return second                      # 으로 / 로: a final ㄹ takes 로
        return first
    return _JOSA.sub(pick, text)


def _name(q, name):
    return _QUEST_ID.sub(r"\1", name) if q == 9 else name        # a quest id some addon appended is not shown


def plain(text):
    """Text without markers (what gets translated / copied)."""
    return _STRAY.sub("", _MARK.sub(lambda m: _name(int(m.group(1)), m.group(2)), text))


def segments(text):
    """[(piece, quality or None)] - quality is set for item-link pieces."""
    out, pos = [], 0
    for m in _MARK.finditer(text):
        if m.start() > pos:
            out.append((_STRAY.sub("", text[pos:m.start()]), None))
        out.append((_name(int(m.group(1)), m.group(2)), int(m.group(1))))
        pos = m.end()
    if pos < len(text):
        out.append((_STRAY.sub("", text[pos:]), None))
    return [(p, q) for p, q in out if p]
