"""Second step: which difference between the plain request (works) and the app's request (429)?  Run: python diag_google2.py"""
import time, urllib.error, urllib.parse, urllib.request
import translator as T

BASE = T.GOOGLE_GTX_URL
def get(label, params, headers):
    url = BASE + "?" + urllib.parse.urlencode(params)
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=8)
        print(f"  {label:48s} -> {r.status}")
    except urllib.error.HTTPError as e:
        print(f"  {label:48s} -> HTTP {e.code}")
    except Exception as e:
        print(f"  {label:48s} -> {e}")
    time.sleep(2)

P = {"client": "gtx", "sl": "en", "tl": "ko", "dt": "t", "q": "hello"}
UA = {"User-Agent": "ChatMatrixReader/1.0"}
print("URL base:", BASE)
get("plain (sl=en q=hello)", P, UA)
get("+ sl=auto", {**P, "sl": "auto"}, UA)
get("+ q='test msg'", {**P, "q": "test msg"}, UA)
get("+ sl=auto + q='test msg'", {**P, "sl": "auto", "q": "test msg"}, UA)
get("+ Accept: application/json", P, {**UA, "Accept": "application/json"})
get("all of the app's parameters and headers", {**P, "sl": "auto", "q": "test msg"}, {**UA, "Accept": "application/json"})
print("\nThe app's own function:")
try:
    print("  translate_google ->", T.translate_google({"target_lang": "한국어", "glossary_google": False}, "test msg"))
except Exception as e:
    print("  translate_google ->", e)
