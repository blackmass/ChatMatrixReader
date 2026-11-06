"""Self-test for i18n.py, locale/*.txt and credits.py."""
import ast
import os
import re
import tempfile

import credits
import i18n
from i18n import tr

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = ["app.py", "options.py", "translator.py", "capture.py", "credits.py", "outgoing.py"]
EXTRA_KEYS = {"사용 안 함 (원문만)", "원문(번역)   예: LFM(구인)", "번역으로 치환   예: 구인"}   # shown through tr(variable)


def source_keys():
    keys = set()
    for fn in SOURCES:
        tree = ast.parse(open(os.path.join(HERE, fn), encoding="utf-8").read())
        for n in ast.walk(tree):
            if (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "tr"
                    and n.args and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str)):
                keys.add(n.args[0].value)
    return keys | EXTRA_KEYS


def fields(s):
    return sorted(re.findall(r"(?<!\{)\{(\w+)(?::[^}]*)?\}(?!\})", s))


# --- every UI text in the code has an English entry, and no entry is stale
entries, name = i18n.parse_file(os.path.join(i18n.LOCALE_DIR, "en-US.txt"))
keys = source_keys()
assert name == "English (US)", name
assert not (keys - set(entries)), "missing in en-US.txt: %r" % sorted(keys - set(entries))
assert not (set(entries) - keys), "stale in en-US.txt: %r" % sorted(set(entries) - keys)
for k, v in entries.items():
    assert " = " not in k, k
    assert fields(k) == fields(v), ("placeholders differ", k, v)
    assert not re.search("[가-힣]", v), ("Korean left in the English text", v)
print("1 ok: en-US.txt matches the source (%d entries)" % len(entries))

# --- translate / fallback / placeholders
i18n.set_language("ko-KR")
assert tr("항상 위에 표시") == "항상 위에 표시"
assert tr("번역 오류: {err}", err="x") == "번역 오류: x"
i18n.set_language("en-US")
assert i18n.current() == "en-US"
assert tr("항상 위에 표시") == "Always on top"
assert tr("번역 오류: {err}", err="boom") == "Translation error: boom"
assert tr("번역에 없는 문장") == "번역에 없는 문장"                      # missing entry -> Korean source
assert tr("{file} 의 최상위는 {{ }} 객체여야 합니다.", file="credit.json") == "The top level of credit.json must be a { } object."
assert tr("연결됨 @ {x},{y}", x=1, y=2).startswith(tr("연결됨"))          # capture status prefix checks
assert tr("캡처 오류: {e}", e="z").startswith(tr("캡처 오류"))
assert tr("매트릭스를 잃어버림 ({reason}) - 다시 찾는 중", reason="r").startswith(tr("매트릭스를 잃어버림"))
assert "\n" in tr("모델마다 끄는 방법이 다릅니다. 서버가 거부(400)하면 자동으로 빼고 다시 요청합니다.\nURL은 http://localhost:1234 처럼 써도 /v1 을 자동으로 붙입니다.")
i18n.set_language("ko-KR")
print("2 ok: translate, fallback, placeholders")

# --- language list and auto choice
codes = [c for c, _ in i18n.available()]
assert codes[0] == "ko-KR" and "en-US" in codes, codes
real = i18n.system_locale
try:
    for sysloc, want in [("en-US", "en-US"), ("en-GB", "en-US"), ("ko-KR", "ko-KR"), ("ko", "ko-KR"),
                         ("ja-JP", "ko-KR"), ("", "ko-KR")]:
        i18n.system_locale = lambda s=sysloc: s
        assert i18n.pick(i18n.AUTO) == want, (sysloc, i18n.pick(i18n.AUTO), want)
    i18n.system_locale = lambda: "ko-KR"
    assert i18n.pick("en-US") == "en-US" and i18n.pick("EN-us") == "en-US"          # explicit choice wins
    assert i18n.pick("xx-XX") == "ko-KR"                                            # unknown -> system/default
    i18n.system_locale = lambda: "en-US"
    assert i18n.init(i18n.AUTO) == "en-US" and tr("종료") == "Exit"
    assert i18n.init("ko-KR") == "ko-KR" and tr("종료") == "종료"
finally:
    i18n.system_locale = real
    i18n.set_language("ko-KR")
print("3 ok: language list and system-language selection")

# --- a user-added language file shows up and works
with tempfile.TemporaryDirectory() as d:
    old = i18n.LOCALE_DIR
    i18n.LOCALE_DIR = d
    try:
        with open(os.path.join(d, "ja-JP.txt"), "w", encoding="utf-8") as f:
            f.write("@name = 日本語\n# comment\n\n종료 = 終了\n잘못된 줄\n번역 오류: {err} = 翻訳エラー: {err}\n")
        assert ("ja-JP", "日本語 (ja-JP)") in i18n.available()
        assert i18n.set_language("ja-JP") == "ja-JP" and tr("종료") == "終了" and tr("번역 오류: {err}", err="x") == "翻訳エラー: x"
        assert i18n.set_language("zz-ZZ") == "ko-KR"                                # missing file -> Korean
        with open(os.path.join(d, "bad.txt"), "w", encoding="utf-8") as f:
            f.write("# only comments\n")
        assert i18n.set_language("bad") == "ko-KR"                                  # empty file -> Korean
    finally:
        i18n.LOCALE_DIR = old
        i18n.set_language("ko-KR")
print("4 ok: user language file")

# --- credits.py
with tempfile.TemporaryDirectory() as d:
    old = credits.PATH
    try:
        credits.PATH = os.path.join(d, "credit.json")
        items, err = credits.load()
        assert items == [] and "credit.json" in err
        with open(credits.PATH, "w", encoding="utf-8") as f:
            f.write('{"addon": "https://example.com/a", "github": "", "contact": "me@example.com", "n": 3, "x": null}')
        items, err = credits.load()
        assert err is None and items == [("addon", "https://example.com/a"), ("github", ""),
                                         ("contact", "me@example.com"), ("n", "3"), ("x", "")], items
        assert credits.is_url("https://a") and not credits.is_url("me@example.com") and not credits.is_url("")
        with open(credits.PATH, "w", encoding="utf-8") as f:
            f.write("{ broken")
        items, err = credits.load()
        assert items == [] and err
        with open(credits.PATH, "w", encoding="utf-8") as f:
            f.write('"text"')
        assert credits.load()[1]
    finally:
        credits.PATH = old
items, err = credits.load()                      # the file shipped with the program
assert err is None and items, (items, err)
print("5 ok: credit.json")
print("ALL I18N TESTS PASSED")
