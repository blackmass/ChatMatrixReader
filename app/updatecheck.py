"""Look up the newest GitHub release and compare version numbers. It only reads one small JSON document: nothing is
downloaded or installed, and nothing is sent except the ordinary web request."""
import re

import translator
import version

_TAG = re.compile(r"[vV]?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?")


def parse(tag):
    """'v1.2.0' / '1.2' -> (1, 2, 0); None if it does not look like a version number."""
    m = _TAG.fullmatch((tag or "").strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)


def fmt(v):
    return "v%d.%d.%d" % v


def is_newer(latest, current):
    a, b = parse(latest), parse(current)
    return bool(a and b and a > b)


def fetch_latest(url=None, timeout=5.0):
    """-> 'v1.3.0' (the newest release tag, validated). Raises translator.TranslateError / ValueError."""
    data = translator._http_json(url or version.LATEST_API, None, {"Accept": "application/vnd.github+json"}, timeout)
    tag = data.get("tag_name") if isinstance(data, dict) else None
    v = parse(tag if isinstance(tag, str) else "")
    if not v:
        raise ValueError("unexpected release tag: %r" % (str(tag)[:40],))
    return fmt(v)
