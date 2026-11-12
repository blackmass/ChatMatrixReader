"""Item-link markers inside chat text.

The addon turns a link into  \\x02 <code> [Item Name] \\x03 . The code is one byte, the character chr(48 + n):
  n 0-9    item quality: 0 grey, 1 white, 2 green, 3 blue, 4 purple, 5 orange, 6 artifact, 7 heirloom
  n 10-19  other game links and money: 10 yellow (quest, achievement, map pin), 11 light blue (spell, talent, mount), 12 gold (profession, gold coins), 13 transmog purple, 14 silver coins, 15 copper coins
  n 20     a whole message that is gibberish to the player's character (a language it does not know): not translated, shown dim
  n 21-29  reserved
The window colours the name; the translator gets the same text without the markers. A code without a colour here is
shown without colour.
"""
import re

_MARK = re.compile("\x02([\x30-\x7e])(.*?)(?:\x03|$)", re.S)
YELLOW, LIGHT_BLUE, UNINTELLIGIBLE = 10, 11, 20


_GUILD = re.compile(r"<+[^<>\n]{1,40}>+")


GUILD_QUALITY = 2                           # the colour code of a guild name: the same green as before (QUALITY_COLORS[2], also the "guild" tag)


def mark_guilds(text):
    """A <Guild Name> written inside a chat message becomes an item-link marker of colour 2 (green, the colour a guild name always had). So it is shown
    green, it is not translated (the translator sees a placeholder [L1] like for an item link), and it comes back in the
    translation unchanged. Text inside existing link markers is left alone; "<3" and the like (no letter inside) is not a guild."""
    def rep(m):
        inner = m.group(0).strip("<>")
        if not re.search(r"[^\W\d_]", inner):
            return m.group(0)
        return "\x02" + chr(48 + GUILD_QUALITY) + m.group(0) + "\x03"

    out, pos = [], 0
    for m in _MARK.finditer(text):
        out.append(_GUILD.sub(rep, text[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(_GUILD.sub(rep, text[pos:]))
    return "".join(out)


def split_guild(text):
    """[(piece, is_guild)]: a <Guild Name> (the game writes guild names in angle brackets) is a piece of its own."""
    out, pos = [], 0
    for m in _GUILD.finditer(text):
        if m.start() > pos:
            out.append((text[pos:m.start()], False))
        out.append((m.group(0), True))
        pos = m.end()
    if pos < len(text):
        out.append((text[pos:], False))
    return out or [(text, False)]


def _code(m):
    return ord(m.group(1)) - 48
_STRAY = re.compile("[\x02\x03]")

CLASS_COLORS = {          # speaker class letter (PROTOCOL.md) -> the game's class colour
    "A": "#C69B6D", "B": "#F48CBA", "C": "#AAD372", "D": "#FFF468", "E": "#FFFFFF", "F": "#C41E3A", "G": "#0070DD",
    "H": "#3FC7EB", "I": "#8788EE", "J": "#00FF98", "K": "#FF7C0A", "L": "#A330C9", "M": "#33937F",
}
QUALITY_COLORS = {
    0: "#9d9d9d", 1: "#ffffff", 2: "#1eff00", 3: "#0070dd", 4: "#a335ee",
    5: "#ff8000", 6: "#e6cc80", 7: "#00ccff",
    10: "#ffff00",            # quest, achievement, profession, map pin
    11: "#71d5ff",            # spell, talent, mount (the game's light blue)
    12: "#ffd100",            # profession recipe (the game's gold)
    13: "#e86bd0",            # the item name of "appearance added to your collection"
    14: "#c7c7cf",            # silver coins (money lines: "1g 20s 97c")
    15: "#eda55f",            # copper coins
    20: "#8c8c8c",            # unintelligible message (see UNINTELLIGIBLE)
    30: "#c41e3a",            # class colour: Death Knight
    31: "#a330c9",            # class colour: Demon Hunter
    32: "#ff7c0a",            # class colour: Druid
    33: "#33937f",            # class colour: Evoker
    34: "#aad372",            # class colour: Hunter
    35: "#3fc7eb",            # class colour: Mage
    36: "#00ff98",            # class colour: Monk
    37: "#f48cba",            # class colour: Paladin
    38: "#ffffff",            # class colour: Priest
    39: "#fff468",            # class colour: Rogue
    40: "#0070dd",            # class colour: Shaman
    41: "#8788ee",            # class colour: Warlock
    42: "#c69b6d",            # class colour: Warrior
    50: "#0000ff",            # resource colour: Mana
    51: "#ff0000",            # resource colour: Rage
    52: "#ff8040",            # resource colour: Focus
    53: "#ffff00",            # resource colour: Energy
    54: "#fff569",            # resource colour: Combo Points
    55: "#808080",            # resource colour: Runes
    56: "#00d1ff",            # resource colour: Runic Power
    57: "#80528c",            # resource colour: Soul Shards
    58: "#4d85e6",            # resource colour: Astral Power
    59: "#f2e699",            # resource colour: Holy Power
    60: "#0080ff",            # resource colour: Maelstrom
    61: "#6600cc",            # resource colour: Insanity
    62: "#b5ffeb",            # resource colour: Chi
    63: "#1a1afa",            # resource colour: Arcane Charges
    64: "#c942fd",            # resource colour: Fury
    65: "#ff9c00",            # resource colour: Pain
    66: "#cc9900",            # resource colour: Ammo
    67: "#008c80",            # resource colour: Fuel
    68: "#85ff85",            # resource colour: Stagger light
    69: "#fffab8",            # resource colour: Stagger medium
    70: "#ff6b6b",            # resource colour: Stagger heavy
    71: "#40ff40",            # chat colour: guild
    72: "#40bf40",            # chat colour: officer
    73: "#aaaaff",            # chat colour: party
    74: "#75c7ff",            # chat colour: party leader
    75: "#ff80ff",            # chat colour: whisper
    76: "#ff4040",            # chat colour: yell
    77: "#ffc0c0",            # chat colour: numbered channel
    78: "#ff480a",            # chat colour: raid leader
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
    return _QUEST_ID.sub(r"\1", name) if q == YELLOW else name        # a quest id some addon appended is not shown


def plain(text):
    """Text without markers (what gets translated / copied)."""
    return _STRAY.sub("", _MARK.sub(lambda m: _name(_code(m), m.group(2)), text))


def mask_links(text):
    """(text with every link replaced by a placeholder [L1] [L2] ..., [link names]).
    The translator sees  "[L1] Who needs this?"  instead of  "[센달 생존 전문가의 장화] Who needs this?": a link name in
    another language made Google guess the wrong source language and leave the sentence untouched. A line without
    other letters is left alone (nothing to gain)."""
    names = []

    def rep(m):
        names.append(_name(_code(m), m.group(2)))
        return "[L%d]" % len(names)

    masked = _STRAY.sub("", _MARK.sub(rep, text))
    if not names or not any(c.isalpha() for c in _PLACEHOLDER.sub("", masked)):
        return plain(text), []
    return masked, names


_PLACEHOLDER = re.compile(r"[\[\uff3b\u3010(\uff08]\s*[Ll]\s*(\d+)\s*[\]\uff3d\u3011)\uff09]")

PLACEHOLDER = _PLACEHOLDER


def is_unintelligible(text):
    """Is the message marked by the addon as gibberish (a language this character does not know)?"""
    return any(_code(m) == UNINTELLIGIBLE for m in _MARK.finditer(text))


def link_qualities(text):
    """The quality digit of every link marker, in the order mask_links() numbers them ([L1] [L2] ...)."""
    return [_code(m) for m in _MARK.finditer(text)]


def ensure_links(text, names):
    """(text, [numbers of the links the translator lost]): a placeholder [Ln] missing from the translation is put back at
    the end, so the item name is not lost (its place in the sentence is not known)."""
    present = {int(m.group(1)) for m in _PLACEHOLDER.finditer(text)}
    missing = [i for i, n in enumerate(names, 1) if n and i not in present]
    if missing:
        text = text.rstrip() + " " + " ".join("[L%d]" % i for i in missing)
    return text, missing


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


_BRACKETED = re.compile(r"\[[^\[\]]*\]")


_PROTECTED = re.compile(r"\|K[^|]*\|k")


def hide_protected(text: str):
    """The game hands an addon some texts as a protected token  |Kx2|k  (the game's own chat window shows the real text, an addon
    never gets it). Returns (text, whole): a message that is only such a token comes back empty with whole=True (the caller shows
    a notice); a token inside a longer text becomes "???" like in the game's own fallback."""
    if _PROTECTED.fullmatch(text.strip()):
        return "", True
    return _PROTECTED.sub("???", text), False


COMMAND_PREFIX = "@"


def is_command(channel: str) -> bool:
    """A line whose channel code starts with "@" is an instruction from the addon to the reader, never text to show."""
    return channel.startswith(COMMAND_PREFIX)


def color_brackets(text, quals):
    """[(piece, quality or None)] of the translation of a line that is only links ("[Faction Banner]"): such a line is
    translated as it is (no [L1] placeholders), so the translated names are found by their brackets and coloured with the
    quality of the link at the same place. When the numbers of brackets and links differ, one common quality is used if
    there is one, else nothing is coloured."""
    spans = list(_BRACKETED.finditer(text))
    if not spans or not quals:
        return [(text, None)]
    if len(spans) == len(quals):
        qs = list(quals)
    elif len(set(quals)) == 1:
        qs = [quals[0]] * len(spans)
    else:
        return [(text, None)]
    out, pos = [], 0
    for m, q in zip(spans, qs):
        if m.start() > pos:
            out.append((text[pos:m.start()], None))
        out.append((m.group(0), q))
        pos = m.end()
    if pos < len(text):
        out.append((text[pos:], None))
    return out


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
        out.append((_name(_code(m), m.group(2)), _code(m)))
        pos = m.end()
    if pos < len(text):
        out.append((_STRAY.sub("", text[pos:]), None))
    return [(p, q) for p, q in out if p]
