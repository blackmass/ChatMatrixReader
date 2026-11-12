"""External glossary file (default: Glossary.txt in the main folder).

File format, one entry per line:      term = meaning        ('#' or '//' starts a comment line)

Used in two ways:
  * Google: every glossary term in the chat line is rewritten before sending, e.g. "LFM dungeon" -> "LFM(구인) dungeon".
  * AI prompt: a placeholder such as {{Glossary.txt}} is replaced by the content of that file.

The file is re-read automatically whenever it changes on disk (no restart needed).
"""
import logging
import os
import re
import shutil
import threading

import paths

DATA_DIR = paths.ROOT                  # Glossary.txt and the sample live in the main folder (next to the launchers)
DEFAULT_NAME = "Glossary.txt"
SAMPLE_NAME = "Glossary.sample.txt"
GLOSSARY_STYLES = {
    "paren": "원문(번역)   예: LFM(구인)",
    "replace": "번역으로 치환   예: 구인",
}
PLACEHOLDER = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")

log = logging.getLogger("cmr.glossary")
log.addHandler(logging.NullHandler())

_lock = threading.Lock()
_cache = {}          # path -> (signature, entries, regex, lookup)
_warned = set()


def resolve(name):
    name = (name or DEFAULT_NAME).strip() or DEFAULT_NAME
    return name if os.path.isabs(name) else os.path.join(DATA_DIR, name)


def _safe_name(name):
    return bool(name) and not os.path.isabs(name) and os.path.basename(name) == name and ".." not in name


def _signature(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _read_text(path):
    with open(path, "rb") as f:
        raw = f.read()
    for enc in ("utf-8-sig", "cp949"):         # Notepad on older Windows saves Korean text as cp949
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _content_lines(text, headings=False):
    """The entry lines of a glossary file. A line starting with ## is a section heading: it is a comment for the
    translators that replace words (Google), and with headings=True it is kept for the AI prompt, so the AI can tell
    what kind of word a section holds (places, roles ...)."""
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if headings and line.startswith("##"):
            out.append(line)
        elif line and not line.startswith(("#", "//")):
            out.append(line)
    return out


_INLINE_NOTE = re.compile(r"\s+#(?:\s|$).*$")           # "b4 = before   # a note": whitespace, #, whitespace


def parse_rich(text):
    """[(term, meaning, note, section)]: the note is the text after " # " on the entry's line, the section the text of the
    last ## heading above it. The same term may appear several times (ATM = cash machine / ATM = at the moment)."""
    out, section = [], ""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("##"):
            section = line.lstrip("#").strip()
            continue
        if not line or line.startswith(("#", "//")):
            continue
        m = _INLINE_NOTE.search(line)
        note = ""
        if m:
            note = line[m.start():].strip().lstrip("#").strip()
            line = line[:m.start()]
        term, sep, meaning = line.partition("=")
        term, meaning = term.strip(), meaning.strip()
        if sep and term and meaning:
            out.append((term, meaning, note, section))
    return out


def parse(text):
    return [(t, m) for t, m, _, _ in parse_rich(text)]      # the notes are for the AI only


def _compile(entries):
    if not entries:
        return None, {}
    lookup = {}
    for term, meaning in entries:
        lookup.setdefault(term.lower(), meaning)
    parts = []
    for term in sorted(lookup, key=len, reverse=True):          # longest term first
        pre = r"(?<!\w)" if re.match(r"\w", term[0]) else ""    # whole words only ("inv" must not hit "invite")
        post = r"(?!\w)" if re.match(r"\w", term[-1]) else ""   # ...but "M+" may be followed by digits: M+12
        parts.append(pre + re.escape(term) + post)
    return re.compile("|".join(parts), re.IGNORECASE), lookup


def _load(name):
    path = resolve(name)
    sig = _signature(path)
    with _lock:
        hit = _cache.get(path)
        if hit and hit[0] == sig:
            return hit
    if sig is None:
        if path not in _warned:
            _warned.add(path)
            log.warning("단어장 파일이 없습니다: %s", path)
        data = (None, [], None, {}, {}, None, {})
    else:
        try:
            rich_list = parse_rich(_read_text(path))
        except OSError as e:
            log.warning("단어장을 읽지 못했습니다: %s", e)
            rich_list = []
        entries = [(t, m) for t, m, _, _ in rich_list]
        rich = {}
        for e in rich_list:
            rich.setdefault(e[0].lower(), []).append(e)
        regex, lookup = _compile(entries)
        # machine translators (Google ...) cannot pick a meaning by context: a term with several different meanings is left out
        single = [(t, m) for t, m in entries if len({e[1] for e in rich[t.lower()]}) == 1]
        mt_regex, mt_lookup = _compile(single)
        _warned.discard(path)
        log.info("단어장 불러옴: %s (%d개)", os.path.basename(path), len(entries))
        data = (sig, entries, regex, lookup, rich, mt_regex, mt_lookup)
    with _lock:
        _cache[path] = data
    return data


def entries(name=None):
    return list(_load(name)[1])


def apply_google(text, name=None, style="paren"):
    """(terms with several different meanings are skipped: a machine translator cannot choose)  'LFM dungeon' -> 'LFM(구인) dungeon'  (style paren)   or   '구인 dungeon'  (style replace)."""
    _, _, _, _, _, regex, lookup = _load(name)
    if regex is None:
        return text

    def rep(m):
        meaning = lookup.get(m.group(0).lower())
        if meaning is None:
            return m.group(0)
        return meaning if style == "replace" else f"{m.group(0)}({meaning})"

    return regex.sub(rep, text)


def apply_google_masked(text, name=None, style="paren", start=1):
    """Like apply_google, but each glossary term is replaced by a placeholder [L<start>], [L<start+1>] ... and the words
    that belong there are returned: (masked text, [words]). Google never sees the Korean meaning, so it cannot take the
    whole sentence for Korean (it then returns it untranslated); the words are put back after the translation."""
    _, _, _, _, _, regex, lookup = _load(name)
    if regex is None:
        return text, []
    words = []

    def rep(m):
        meaning = lookup.get(m.group(0).lower())
        if meaning is None:
            return m.group(0)
        words.append(meaning if style == "replace" else f"{m.group(0)}({meaning})")
        return "[L%d]" % (start + len(words) - 1)

    return regex.sub(rep, text), words


LIST_MAX = 20                          # at most this many entries are listed for one message
INLINE_MAX = 10                        # mixed mode: at most this many terms get their meaning in parentheses in one line


def _format_list(keys, rich, limit):
    sections, order, n = {}, [], 0
    for k in keys:
        for term, meaning, note, section in rich[k]:
            if n >= limit:
                break
            n += 1
            if section not in sections:
                sections[section] = []
                order.append(section)
            sections[section].append(f"{term} = {meaning}" + (f"    # {note}" if note else ""))
    lines = []
    for section in order:
        if section:
            lines.append("## " + section)
        lines += sections[section]
    return "\n".join(lines)


def matched_list(text, name=None, limit=LIST_MAX):
    """The glossary entries whose term occurs in `text`, in the glossary file's own format (## section headings, notes after
    " # " kept), for the AI to read right before the message. A term with several meanings lists all of them. "" = no hit."""
    _, _, regex, lookup, rich, _, _ = _load(name)
    if regex is None:
        return ""
    keys = []
    for m in regex.finditer(text):
        k = m.group(0).lower()
        if k in rich and k not in keys:
            keys.append(k)
    return _format_list(keys, rich, limit)


def apply_mixed(text, name=None, limit=LIST_MAX, inline_max=INLINE_MAX):
    """(text, list): a term with ONE meaning and no note gets that meaning right behind it, 'SFK' -> 'SFK(그림자 송곳니 성채)';
    every other term found (several meanings, a note, or beyond `inline_max`) stays as it is in the text and its entries are
    listed instead, in the format of matched_list (for the AI to read before the message). list "" = nothing to list."""
    _, _, regex, lookup, rich, _, _ = _load(name)
    if regex is None:
        return text, ""
    keys, n = [], [0]

    def rep(m):
        k = m.group(0).lower()
        found = rich.get(k)
        if not found:
            return m.group(0)
        if len({e[1] for e in found}) == 1 and not any(e[2] for e in found) and n[0] < inline_max:
            n[0] += 1
            return f"{m.group(0)}({found[0][1]})"
        if k not in keys:
            keys.append(k)
        return m.group(0)

    out = regex.sub(rep, text)
    return out, _format_list(keys, rich, limit)


MODES = ("full", "list", "mixed")
LIST_PLACEHOLDER = "(The glossary entries that apply to a message are given with that message.)"
MIXED_PLACEHOLDER = ("(The glossary meanings that apply to a message are given inside the message, in parentheses behind the term; "
                     "entries that need a choice or a note are listed before the message.)")


def mode(cfg):
    m = cfg.get("glossary_mode")
    if m == "inline":                      # the removed third way (meanings in parentheses): the nearest one left
        return "list"
    return m if m in MODES else "full"


def expand_placeholders(prompt, mode="full"):
    """Replace {{File.txt}} in a prompt by the file's lines (comments and blank lines removed; ## headings and notes after " # " are kept).
    mode "list" / "mixed": {{Glossary.txt}} gets a one-line hint (the matching entries travel with the chat line)."""
    def repl(m):
        name = m.group(1).strip()
        if mode != "full" and name.lower() == SAMPLE_NAME.replace(".sample", "").lower():
            return MIXED_PLACEHOLDER if mode == "mixed" else LIST_PLACEHOLDER
        if not _safe_name(name):
            log.warning("프롬프트의 {{%s}}: 앱 폴더 안의 파일 이름만 쓸 수 있습니다", name)
            return ""
        path = os.path.join(DATA_DIR, name)
        if _signature(path) is None:
            if path not in _warned:
                _warned.add(path)
                log.warning("프롬프트의 {{%s}} 파일이 없습니다: %s", name, path)
            return ""
        try:
            return "\n".join(_content_lines(_read_text(path), headings=True))
        except OSError as e:
            log.warning("{{%s}} 읽기 실패: %s", name, e)
            return ""
    return PLACEHOLDER.sub(repl, prompt or "")


def cache_key(cfg):
    """Changes whenever a file that influences the translation changes (so cached translations are not reused)."""
    names = sorted({n.strip() for n in PLACEHOLDER.findall(cfg.get("prompt") or "") if _safe_name(n.strip()) and n.strip() != "extra_prompt"})
    google = (_signature(resolve(cfg.get("glossary_file"))), cfg.get("glossary_style")) if cfg.get("glossary_google", True) else None
    m = mode(cfg)
    own = _signature(resolve(cfg.get("glossary_file"))) if m != "full" else None     # the file's content is part of what is sent
    return (google, m, own, tuple(_signature(os.path.join(DATA_DIR, n)) for n in names))


def ensure_default(name=None):
    """Create Glossary.txt from the sample on first start (an existing file is never touched)."""
    path = resolve(name)
    sample = os.path.join(DATA_DIR, SAMPLE_NAME)
    if not os.path.exists(path) and os.path.exists(sample):
        try:
            shutil.copyfile(sample, path)
            log.info("단어장을 새로 만들었습니다: %s", path)
        except OSError as e:
            log.warning("단어장을 만들지 못했습니다: %s", e)
