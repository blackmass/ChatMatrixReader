"""Reads credit.json (in the app folder) for the "기타" tab: every key/value pair is listed as is,
so links and contact info can be changed by editing the json only.

    {
      "addon":   "https://...",
      "github":  "https://...",
      "blog":    "",
      "contact": "me@example.com"
    }
"""
import json
import logging
import os
import webbrowser

from i18n import tr

APP_DIR = os.path.dirname(os.path.abspath(__file__))
FILE_NAME = "credit.json"
PATH = os.path.join(APP_DIR, FILE_NAME)

log = logging.getLogger("cmr.credits")
log.addHandler(logging.NullHandler())


def load():
    """-> ([(key, value_text)], error_text or None). Re-reads the file every time."""
    try:
        with open(PATH, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except FileNotFoundError:
        return [], tr("{file} 파일이 없습니다.", file=FILE_NAME)
    except (OSError, ValueError) as e:
        log.warning("credit.json 읽기 실패: %s", e)
        return [], tr("{file} 을(를) 읽지 못했습니다: {e}", file=FILE_NAME, e=e)
    if isinstance(data, dict):
        pairs = list(data.items())
    elif isinstance(data, list):
        pairs = list(enumerate(data, 1))
    else:
        return [], tr("{file} 의 최상위는 {{ }} 객체여야 합니다.", file=FILE_NAME)
    out = []
    for k, v in pairs:
        if v is None:
            text = ""
        elif isinstance(v, str):
            text = v.strip()
        else:
            text = json.dumps(v, ensure_ascii=False)
        out.append((str(k), text))
    return out, None


def is_url(text):
    return text.lower().startswith(("http://", "https://"))


def open_url(text):
    if is_url(text):
        try:
            webbrowser.open(text)
        except Exception:
            log.exception("링크 열기 실패")
