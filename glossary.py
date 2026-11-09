"""External glossary file (default: Glossary.txt next to the app).

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

APP_DIR = os.path.dirname(os.path.abspath(__file__))
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
    return name if os.path.isabs(name) else os.path.join(APP_DIR, name)


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


def _content_lines(text):
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if line and not line.startswith(("#", "//")):
            out.append(line)
    return out


def parse(text):
    entries = []
    for line in _content_lines(text):
        term, sep, meaning = line.partition("=")
        term, meaning = term.strip(), meaning.strip()
        if sep and term and meaning:
            entries.append((term, meaning))
    return entries


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
        data = (None, [], None, {})
    else:
        try:
            entries = parse(_read_text(path))
        except OSError as e:
            log.warning("단어장을 읽지 못했습니다: %s", e)
            entries = []
        regex, lookup = _compile(entries)
        _warned.discard(path)
        log.info("단어장 불러옴: %s (%d개)", os.path.basename(path), len(entries))
        data = (sig, entries, regex, lookup)
    with _lock:
        _cache[path] = data
    return data


def entries(name=None):
    return list(_load(name)[1])


def apply_google(text, name=None, style="paren"):
    """'LFM dungeon' -> 'LFM(구인) dungeon'  (style paren)   or   '구인 dungeon'  (style replace)."""
    _, _, regex, lookup = _load(name)
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
    _, _, regex, lookup = _load(name)
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


def expand_placeholders(prompt):
    """Replace {{File.txt}} in a prompt by the file's lines (comments and blank lines removed)."""
    def repl(m):
        name = m.group(1).strip()
        if not _safe_name(name):
            log.warning("프롬프트의 {{%s}}: 앱 폴더 안의 파일 이름만 쓸 수 있습니다", name)
            return ""
        path = os.path.join(APP_DIR, name)
        if _signature(path) is None:
            if path not in _warned:
                _warned.add(path)
                log.warning("프롬프트의 {{%s}} 파일이 없습니다: %s", name, path)
            return ""
        try:
            return "\n".join(_content_lines(_read_text(path)))
        except OSError as e:
            log.warning("{{%s}} 읽기 실패: %s", name, e)
            return ""
    return PLACEHOLDER.sub(repl, prompt or "")


def cache_key(cfg):
    """Changes whenever a file that influences the translation changes (so cached translations are not reused)."""
    names = sorted({n.strip() for n in PLACEHOLDER.findall(cfg.get("prompt") or "") if _safe_name(n.strip())})
    google = (_signature(resolve(cfg.get("glossary_file"))), cfg.get("glossary_style")) if cfg.get("glossary_google", True) else None
    return (google, tuple(_signature(os.path.join(APP_DIR, n)) for n in names))


def ensure_default(name=None):
    """Create Glossary.txt from the sample on first start (an existing file is never touched)."""
    path = resolve(name)
    sample = os.path.join(APP_DIR, SAMPLE_NAME)
    if not os.path.exists(path) and os.path.exists(sample):
        try:
            shutil.copyfile(sample, path)
            log.info("단어장을 새로 만들었습니다: %s", path)
        except OSError as e:
            log.warning("단어장을 만들지 못했습니다: %s", e)
