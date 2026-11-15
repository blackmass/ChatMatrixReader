"""Self-test for updatecheck.py (a local server plays GitHub)."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import updatecheck as u

assert u.parse("v1.2.0") == (1, 2, 0) and u.parse("1.2") == (1, 2, 0) and u.parse(" V10.0.3 ") == (10, 0, 3)
for bad in ("", None, "latest", "1", "v1.2.3.4", "1.2.0-beta", "v1.x", "<script>"):
    assert u.parse(bad) is None, bad
assert u.is_newer("v1.3.0", "1.2.0") and u.is_newer("1.10.0", "1.9.9") and u.is_newer("2.0", "1.99.99")
assert not u.is_newer("v1.2.0", "1.2.0") and not u.is_newer("v1.2.0", "1.3.0")      # equal / own build is newer
assert not u.is_newer("garbage", "1.2.0") and not u.is_newer("1.3.0", "garbage")

REPLY = {"body": {"tag_name": "v1.3.0"}, "code": 200}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps(REPLY["body"]).encode()
        self.send_response(REPLY["code"])
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/x"

assert u.fetch_latest(url, major=1) == "v1.3.0"
REPLY["body"] = {"tag_name": "1.4"}
assert u.fetch_latest(url, major=1) == "v1.4.0"                              # normalised
# a list of releases: only the program's own major version counts (a 1.x program does not announce 2.0 and the reverse), drafts / pre-releases are skipped
REPLY["body"] = [{"tag_name": "v2.0.0"}, {"tag_name": "v1.9.0", "prerelease": True}, {"tag_name": "v1.8.5"},
                 {"tag_name": "v1.9.9", "draft": True}, {"tag_name": "v1.8.2"}, {"tag_name": "junk"}]
assert u.fetch_latest(url) == "v2.0.0"                              # this program is 2.x
assert u.fetch_latest(url, major=1) == "v1.8.5"
REPLY["body"] = [{"tag_name": "v2.0.0"}, {"tag_name": "v2.1.0"}]
try:
    u.fetch_latest(url, major=1)                                    # only 2.x exists: nothing for a 1.x program
    raise SystemExit("expected error")
except ValueError:
    pass
assert u.version.MAJOR == 2 and u.version.LATEST_API.endswith("/releases?per_page=30")
for body in ({"tag_name": "evil <b>"}, {"name": "x"}, ["list"], {"tag_name": 5}, []):
    REPLY["body"] = body
    try:
        u.fetch_latest(url)
        raise SystemExit("expected error for %r" % (body,))
    except ValueError:
        pass
REPLY.update(body={"message": "rate limit"}, code=403)
try:
    u.fetch_latest(url)
    raise SystemExit("expected error")
except u.translator.TranslateError:
    pass
try:
    u.fetch_latest("http://127.0.0.1:9/none", timeout=1)             # nothing listens there
    raise SystemExit("expected error")
except u.translator.TranslateError:
    pass
print("updatecheck ok")
