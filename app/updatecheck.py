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


def fetch_latest(url=None, timeout=5.0, major=None):
    """-> 'v1.8.2': the newest release tag OF THIS MAJOR VERSION (a 1.x program does not announce 2.0), validated. Drafts and
    pre-releases are skipped. Raises translator.TranslateError / ValueError."""
    major = version.MAJOR if major is None else major
    data = translator._http_json(url or version.LATEST_API, None, {"Accept": "application/vnd.github+json"}, timeout)
    items = data if isinstance(data, list) else [data]          # (one release object works too)
    best, seen = None, []
    for it in items:
        if not isinstance(it, dict) or it.get("draft") or it.get("prerelease"):
            continue
        tag = it.get("tag_name")
        v = parse(tag if isinstance(tag, str) else "")
        if not v:
            seen.append(str(tag)[:40])
            continue
        if v[0] == major and (best is None or v > best):
            best = v
    if best is None:
        raise ValueError("no release of version %d.x found (tags seen: %r)" % (major, seen[:3]))
    return fmt(best)
