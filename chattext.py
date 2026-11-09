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
    0: "#9d9d9d", 1: "#ffffff", 2: "#1eff00", 3: "#0070dd", 4: "#a335ee",
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


def mask_links(text):
    """(text with every link replaced by a placeholder [L1] [L2] ..., [link names]).
    The translator sees  "[L1] Who needs this?"  instead of  "[센달 생존 전문가의 장화] Who needs this?": a link name in
    another language made Google guess the wrong source language and leave the sentence untouched. A line without
    other letters is left alone (nothing to gain)."""
    names = []

    def rep(m):
        names.append(_name(int(m.group(1)), m.group(2)))
        return "[L%d]" % len(names)

    masked = _STRAY.sub("", _MARK.sub(rep, text))
    if not names or not any(c.isalpha() for c in _PLACEHOLDER.sub("", masked)):
        return plain(text), []
    return masked, names


_PLACEHOLDER = re.compile(r"[\[\uff3b\u3010(\uff08]\s*[Ll]\s*(\d+)\s*[\]\uff3d\u3011)\uff09]")

PLACEHOLDER = _PLACEHOLDER


def link_qualities(text):
    """The quality digit of every link marker, in the order mask_links() numbers them ([L1] [L2] ...)."""
    return [int(m.group(1)) for m in _MARK.finditer(text)]


def split_translation(text, names, quals):
    """[(piece, quality or None)] of a translated text that still holds the placeholders [L1] [L2] ...: the links come back
    as pieces of their own (so the reader can colour them), the rest is plain text."""
    out, pos = [], 0
    for m in _PLACEHOLDER.finditer(text):
        i = int(m.group(1))
        if not (1 <= i <= len(names) and names[i - 1]):
            continue                                            # unknown placeholder: stays as the translator wrote it
        if m.start() > pos:
            out.append((text[pos:m.start()], None))
        out.append((names[i - 1], quals[i - 1] if i - 1 < len(quals) else None))
        pos = m.end()
    if pos < len(text):
        out.append((text[pos:], None))
    return [(p, q) for p, q in out if p]


def unmask_links(text, names):
    """Put the link names back where the translator left the placeholders (it may change the brackets or spacing)."""
    if not names:
        return text

    def rep(m):
        i = int(m.group(1))
        return names[i - 1] if 1 <= i <= len(names) and names[i - 1] else m.group(0)

    return _PLACEHOLDER.sub(rep, text)


def check_text(text):
    """The text the 'do not translate' checks (language detection, the user's regex) look at: the line without its links.
    A link name is a fixed word in the client's language (the addon renames links), so it says nothing about the
    language the speaker wrote in. A line that is nothing but links is checked as it is."""
    rest = _STRAY.sub("", _MARK.sub("", text))
    return rest if any(c.isalpha() for c in rest) else plain(text)


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
