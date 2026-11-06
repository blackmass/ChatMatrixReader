"""UI language support.

The Korean text in the source code IS the key (Korean is the built-in default language).
Other languages live in  locale/<code>.txt  (e.g. locale/en-US.txt), one entry per line:

    # comment
    @name = English (US)            <- optional: name shown in the language list
    항상 위에 표시 = Always on top
    번역 오류: {err} = Translation error: {err}      <- {placeholders} must be kept as they are
    첫 줄\\n둘째 줄 = Line 1\\nLine 2                     <- \\n = line break

Anyone can add a language by copying en-US.txt to e.g. ja-JP.txt and translating the right-hand side.
Text without an entry is shown in Korean.
"""
import ctypes
import locale
import logging
import os

APP_DIR = os.path.dirname(os.path.abspath(__file__))
LOCALE_DIR = os.path.join(APP_DIR, "locale")
DEFAULT_LANG = "ko-KR"           # built in, needs no file
AUTO = ""                        # config value meaning "use the system language"

log = logging.getLogger("cmr.i18n")
log.addHandler(logging.NullHandler())

_table = {}
_current = DEFAULT_LANG


def tr(text, /, **kw):
    """Translate `text` (Korean source text); `kw` fills {placeholders}."""
    s = _table.get(text, text)
    if kw:
        try:
            return s.format(**kw)
        except (KeyError, IndexError, ValueError):
            try:
                return text.format(**kw)
            except (KeyError, IndexError, ValueError):
                return s
    return s


def _unescape(s):
    return s.replace("\\n", "\n")


def parse_file(path):
    """-> (entries dict, display name or None)."""
    entries, name = {}, None
    for enc in ("utf-8-sig", "cp949"):
        try:
            with open(path, "r", encoding=enc) as f:
                lines = f.read().splitlines()
            break
        except UnicodeDecodeError:
            continue
        except OSError as e:
            log.warning("언어 파일을 읽지 못했습니다: %s (%s)", path, e)
            return {}, None
    else:
        return {}, None
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        key, sep, val = s.partition(" = ")
        if not sep:
            continue
        key, val = key.strip(), val.strip()
        if key == "@name":
            name = val
        elif key and val:
            entries[_unescape(key)] = _unescape(val)
    return entries, name


def available():
    """[(code, display name)] - Korean first, then every locale/*.txt."""
    out = [(DEFAULT_LANG, "한국어 (ko-KR)")]
    try:
        names = sorted(os.listdir(LOCALE_DIR))
    except OSError:
        names = []
    for fn in names:
        code, ext = os.path.splitext(fn)
        if ext.lower() != ".txt" or code.lower() == DEFAULT_LANG.lower():
            continue
        _, name = parse_file(os.path.join(LOCALE_DIR, fn))
        out.append((code, f"{name} ({code})" if name else code))
    return out


def system_locale():
    """e.g. 'ko-KR', 'en-US' ('' if unknown)."""
    try:
        buf = ctypes.create_unicode_buffer(85)
        if ctypes.windll.kernel32.GetUserDefaultLocaleName(buf, 85):
            return buf.value
    except Exception:
        pass
    try:
        loc = locale.getlocale()[0] or ""
        return loc.replace("_", "-")
    except Exception:
        return ""


def pick(preferred=AUTO):
    """Language code to use: the configured one if it exists, else the system language, else Korean."""
    codes = {c.lower(): c for c, _ in available()}
    if preferred and preferred.lower() in codes:
        return codes[preferred.lower()]
    sysloc = system_locale().lower()
    if sysloc in codes:
        return codes[sysloc]
    prim = sysloc.split("-")[0]
    if prim:
        if prim == DEFAULT_LANG.split("-")[0].lower():
            return DEFAULT_LANG
        for low, code in codes.items():            # e.g. en-GB -> en-US
            if low.split("-")[0] == prim:
                return code
    return DEFAULT_LANG


def set_language(code):
    """Load a language ('ko-KR' = built in). Returns the code actually in use."""
    global _table, _current
    if not code or code.lower() == DEFAULT_LANG.lower():
        _table, _current = {}, DEFAULT_LANG
        return _current
    path = os.path.join(LOCALE_DIR, code + ".txt")
    if not os.path.exists(path):
        for fn in os.listdir(LOCALE_DIR) if os.path.isdir(LOCALE_DIR) else []:
            if fn.lower() == (code + ".txt").lower():
                path = os.path.join(LOCALE_DIR, fn)
                break
    entries, _ = parse_file(path)
    if not entries:
        log.warning("언어 파일이 없거나 비어 있습니다: %s -> 한국어 사용", path)
        _table, _current = {}, DEFAULT_LANG
        return _current
    _table, _current = entries, code
    log.info("언어: %s (%d개 항목)", code, len(entries))
    return _current


def current():
    return _current


def init(preferred=AUTO):
    return set_language(pick(preferred))
