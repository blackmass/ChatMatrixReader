"""Turns what the player typed into the text that goes to the clipboard (and from there into the game chat box).

  * A leading chat command is kept:   "/w Name 안녕"  ->  "/w Name Hello"      (only the sentence is translated)
  * Any other command ("/dance") is copied untouched - it is a command, not a sentence.
  * The result is one line, never starts with "/", has "|" doubled (WoW's escape character) and must fit the
    255 bytes of a chat message.
"""
import re

import translator
from i18n import tr

MAX_BYTES = 255

# commands followed by a player name, then the message
_NAMED = {"w", "whisper", "t", "tell", "send"}
# commands followed directly by the message
_CHAT = {"r", "reply", "s", "say", "y", "yell", "p", "party", "raid", "ra", "rw", "g", "guild", "o", "officer",
         "i", "instance", "bg", "battleground", "e", "em", "emote", "me"}

_CMD = re.compile(r"^/(\S+)\s*(.*)$", re.S)
_LABEL = re.compile(r"^\s*(translation|translated|번역)\s*[:：]\s*", re.I)
_QUOTES = [('"', '"'), ("'", "'"), ("“", "”"), ("‘", "’"), ("「", "」"), ("『", "』"), ("«", "»")]


class OutgoingError(Exception):
    pass


class Prepared:
    def __init__(self, text, translated, note=None):
        self.text = text              # exactly what goes to the clipboard
        self.translated = translated
        self.note = note              # something to tell the user in the log, or None


def split_command(text):
    """-> (prefix, body, kind); kind: 'plain' | 'chat' (prefix kept, body translated) | 'other' (copy as is)."""
    m = _CMD.match(text)
    if not m:
        return "", text, "plain"
    cmd, rest = m.group(1), m.group(2)
    low = cmd.lower()
    if low in _NAMED:
        m2 = re.match(r"(\S+)\s*(.*)$", rest, re.S)
        if not m2:
            return f"/{cmd} ", "", "chat"
        return f"/{cmd} {m2.group(1)} ", m2.group(2), "chat"
    if low in _CHAT or low.isdigit():
        return f"/{cmd} ", rest, "chat"
    return "", text, "other"


def _unquote(s):
    for a, b in _QUOTES:
        if len(s) >= 2 and s[0] == a and s[-1] == b:
            return s[1:-1].strip()
    return s


def clean_translation(out):
    s = re.sub(r"\s*[\r\n]+\s*", " ", (out or "").strip()).strip()
    s = _unquote(s)
    s = _unquote(_LABEL.sub("", s).strip())              # "Translation: ..." label, with or without quotes around it
    return s.lstrip("/ ").strip()                        # a translation must never turn into a game command


def escape_pipes(s):
    return s.replace("|", "||")


def fit(text):
    n = len(text.encode("utf-8"))
    if n > MAX_BYTES:
        raise OutgoingError(tr("번역문이 너무 깁니다 ({n}/{max}바이트). 줄여서 다시 입력하세요: {preview}",
                               n=n, max=MAX_BYTES, preview=_short(text)))


def _short(text, n=70):
    return text if len(text) <= n else text[:n] + "…"


def prepare(cfg, raw, translate_fn=None):
    """Raises OutgoingError (with a message for the user) or returns Prepared."""
    translate_fn = translate_fn or translator.translate_outgoing
    raw = (raw or "").strip()
    if not raw:
        raise OutgoingError(tr("보낼 내용이 비어 있습니다"))
    prefix, body, kind = split_command(raw)
    if kind == "other":
        text = escape_pipes(raw)
        fit(text)
        return Prepared(text, False, tr("명령어는 번역하지 않고 그대로 복사했습니다"))
    body = body.strip()
    if not body:
        raise OutgoingError(tr("명령어 뒤에 번역할 내용이 없습니다"))
    if not any(c.isalpha() for c in body):          # numbers / symbols only: nothing to translate
        out, translated = body, False
    else:
        try:
            out = clean_translation(translate_fn(cfg, body))
        except translator.TranslateError as e:
            raise OutgoingError(tr("번역 실패: {err}", err=e)) from None
        translated = True
    if not out:
        raise OutgoingError(tr("번역 결과가 비어 있습니다"))
    text = prefix + escape_pipes(out)
    fit(text)
    return Prepared(text, translated)
