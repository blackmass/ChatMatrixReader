"""Per-channel translation method (option "channel translation"): route_for / apply_route / TranslationService.submit."""
import queue
import time

import translator as t

cfg = {"translator": "openai", "target_lang": "한국어", "google_api_key": "SECRET", "max_pending": 50,
       "channel_route": {"S": "google_free", "C2": "off", "W": "default", "P": "bogus"}}
assert t.route_for(cfg, "S") == "google_free" and t.route_for(cfg, "C2") == "off"
assert t.route_for(cfg, "W") is None and t.route_for(cfg, "P") is None and t.route_for(cfg, "G") is None
assert t.route_for({}, "S") is None and t.route_for({"channel_route": None}, "S") is None
out = t.apply_route(cfg, "google_free")
assert out["translator"] == "google" and out["google_api_key"] == "" and cfg["translator"] == "openai" and cfg["google_api_key"] == "SECRET"
assert t.apply_route(cfg, None) is cfg
print("1 ok: route_for / apply_route (the key is ignored only for the free Google route, the settings are not changed)")

seen = []
orig = t.translate
t.translate = lambda c, text: (seen.append((c["translator"], c["google_api_key"], text)), "번역:" + text)[1]
try:
    q = queue.Queue()
    svc = t.TranslationService(q, lambda: cfg, workers=1)
    assert svc.submit(1, "hello a")
    assert svc.submit(2, "hello b", "google_free")
    deadline = time.time() + 5
    while len(seen) < 2 and time.time() < deadline:
        time.sleep(0.02)
    svc.shutdown()
finally:
    t.translate = orig
assert ("openai", "SECRET", "hello a") in seen and ("google", "", "hello b") in seen, seen
print("2 ok: a request with the free Google route is translated by Google without the key, the others as set")

import config
assert config.DEFAULTS["channel_route"] == {}
print("ALL ROUTE TESTS PASSED")
