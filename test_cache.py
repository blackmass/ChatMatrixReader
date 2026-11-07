import os, queue, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import translator as T

calls = []
gate = threading.Event(); gate.set()
def fake(cfg, text):
    calls.append(text); gate.wait(5); return "T:" + text
T.translate = fake

q = queue.Queue()
tr = T.TranslationService(q, lambda: {"translator": "google", "target_lang": "한국어", "max_pending": 50}, workers=2)
tr.SHORT_MAX, tr.LONG_MAX = 5, 2

def ask(text, token=None):
    tr.submit(token or text, text)
    t0 = time.time()
    while q.empty() and time.time() - t0 < 3: time.sleep(0.01)
    return q.get()

assert ask("a")[1][1] == "T:a" and calls == ["a"]
assert ask("a")[1][1] == "T:a" and calls == ["a"]          # short-term hit (promoted to long)
assert "a" in [k[-1] for k in tr.long] and not tr.cache.keys() - {k for k in tr.cache}
for w in "bcdefgh": ask(w)                                  # fill and overflow the short-term memory
assert len(tr.cache) == 5
n = len(calls)
assert ask("a")[1][1] == "T:a" and len(calls) == n          # still in long-term although long gone from short-term
# long-term capacity 2: promote b-latest and c-latest
ask("g"); ask("h"); assert len(tr.long) == 2
# in-flight dedupe: identical lines while one request is running -> one call
gate.clear(); n = len(calls)
tr.submit("x1", "same"); tr.submit("x2", "same"); tr.submit("x3", "same")
time.sleep(0.2); gate.set()
got = sorted(q.get(timeout=3)[1][0] for _ in range(3))
assert got == ["x1", "x2", "x3"] and len(calls) == n + 1, (got, len(calls) - n)
print("cache ok")
