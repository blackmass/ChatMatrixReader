"""Self-test for capture.py with a fake screen (mss is replaced by a stub, so this runs anywhere)."""
import queue
import sys
import time
import types

import numpy as np

SCREEN = {"arr": None}


class FakeShot:
    def __init__(self, a):
        self.bgra, self.height, self.width = a.tobytes(), a.shape[0], a.shape[1]


class FakeSct:
    monitors = [{"left": 0, "top": 0, "width": 1000, "height": 600}, {"left": 0, "top": 0, "width": 1000, "height": 600}]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def grab(self, area):
        s = SCREEN["arr"]
        y0, x0 = area["top"], area["left"]
        return FakeShot(np.ascontiguousarray(s[y0:y0 + area["height"], x0:x0 + area["width"]]))


sys.modules["mss"] = types.SimpleNamespace(mss=lambda: FakeSct())

import capture      # noqa: E402  (after the stub)
import decoder      # noqa: E402
import proto2       # noqa: E402
import proto3       # noqa: E402

FS = "\x1f"


def blank():
    a = np.random.randint(0, 256, size=(600, 1000, 4), dtype=np.uint8)
    a[:, :, 3] = 255
    return a


def put(img, x=20, y=450):
    s = blank()
    s[y:y + img.shape[0], x:x + img.shape[1]] = img
    SCREEN["arr"] = s


ns = {}
exec(open("test_decoder.py", encoding="utf-8").read().split("lines = [mk")[0], ns)


def v1_screen(i, text):
    put(ns["draw"](ns["encode"]([FS.join(["S", str(i), "Anna", text])], i)))


def v2_screen(i, text, gamma=1.2, gain=0.8):
    img = proto2.draw(proto2.encode([FS.join(["S", str(i), "Bob", text, "H"])], i, 8)).astype(np.float64)
    for k in (0, 1, 2):
        img[:, :, k] = 255 * np.minimum(1, gain * (img[:, :, k] / 255) ** gamma)
    put(np.rint(img).astype(np.uint8))


q = queue.Queue()
cfg = {"poll_hz": 60, "full_scan_sec": 5}
w = capture.CaptureWorker(q, lambda: cfg)


def drain(seconds, want_lines=1):
    got, status = [], None
    end = time.time() + seconds
    while time.time() < end and len(got) < want_lines:
        try:
            kind, payload = q.get(timeout=0.2)
        except queue.Empty:
            continue
        if kind == "lines":
            got += payload
        elif kind == "status":
            status = payload
    return got, status


v1_screen(1, "hello v1")
w.start()
lines, status = drain(10)
assert [(l.id, l.text) for l in lines] == [(1, "hello v1")], lines
print("1 ok: v1 matrix found and read")

v2_screen(2, "hello v2 한글")                      # the player switched the addon to protocol v2 / 8 levels
lines, status = drain(15)
assert [(l.id, l.sender, l.text, l.cls) for l in lines] == [(2, "Bob", "hello v2 한글", "H")], lines
print("2 ok: switched to v2 on its own; colour-damaged frame read; status:", status)

v2_screen(3, "second v2 line")
lines, status = drain(10)
assert [(l.id, l.text) for l in lines] == [(3, "second v2 line")] and "v2·8" in status, (lines, status)
print("3 ok: new v2 lines keep coming")

# a macOS-like screen: cells of 4.5 px and Display-P3 colour mixing (only v2 can be read)
P3 = np.array([[0.8224621, 0.1775380, 0.0], [0.0331941, 0.9668058, 0.0], [0.0170827, 0.0723974, 0.9105199]])


def scaled_screen(i, text, f=1.125):
    img = proto2.draw(proto2.encode([FS.join(["S", str(i), "Mac", text, "K"])], i, 8))
    lin = proto2._to_lin(img[:, :, [2, 1, 0]].astype(np.float64) / 255) @ P3.T
    img[:, :, [2, 1, 0]] = np.round(proto2._from_lin(lin) * 255).astype(np.uint8)
    h, w = img.shape[:2]
    nh, nw = int(h * f), int(w * f)
    ys, xs = np.linspace(0, h - 1, nh), np.linspace(0, w - 1, nw)
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    y1, x1 = np.minimum(y0 + 1, h - 1), np.minimum(x0 + 1, w - 1)
    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
    a = img.astype(np.float32)
    z = (a[y0][:, x0] * (1 - fx) * (1 - fy) + a[y0][:, x1] * fx * (1 - fy)
         + a[y1][:, x0] * (1 - fx) * fy + a[y1][:, x1] * fx * fy).astype(np.uint8)
    put(z, x=37, y=441)


scaled_screen(5, "hello from a retina screen")
lines, status = drain(20)
assert [(l.id, l.sender, l.text, l.cls) for l in lines] == [(5, "Mac", "hello from a retina screen", "K")], lines
print("4 ok: scaled matrix with mixed colours read; status:", status)
scaled_screen(6, "next one")
lines, status = drain(10)
assert [(l.id, l.text) for l in lines] == [(6, "next one")] and "v2·8" in status, (lines, status)
print("5 ok: scaled matrix keeps being tracked")

v1_screen(4, "and back to v1")
lines, status = drain(15)
assert [(l.id, l.text) for l in lines] == [(4, "and back to v1")], lines
print("6 ok: back to v1")

w.stop()
w.join(timeout=5)

# the last position is looked at every second, also when the matrix is NOT in the corner and the whole-screen search
# is far away: the matrix is missing at the start (loading screen), then shows up at the old place
SCREEN["arr"] = blank()
q2 = queue.Queue()
cfg2 = {"poll_hz": 60, "full_scan_sec": 600, "last_pos": [119, 20]}
w2 = capture.CaptureWorker(q2, lambda: cfg2)
w2.start()
time.sleep(2.5)                                    # first whole-screen search is over, the next one is 10 minutes away
put(ns["draw"](ns["encode"]([FS.join(["S", "9", "Anna", "back at the old place"])], 9)), x=119, y=20)
got, pos_msgs, end = [], [], time.time() + 6
while time.time() < end and not got:
    try:
        kind, payload = q2.get(timeout=0.2)
    except queue.Empty:
        continue
    if kind == "lines":
        got += payload
    elif kind == "pos":
        pos_msgs.append(payload)
w2.stop()
w2.join(timeout=5)
assert [(l.id, l.text) for l in got] == [(9, "back at the old place")], got
print("7 ok: found again at the remembered position within seconds (no whole-screen search needed)")

# a position found by the search is reported so that it can be saved
SCREEN["arr"] = blank()
put(ns["draw"](ns["encode"]([FS.join(["S", "10", "Anna", "x"])], 10)), x=300, y=400)
q3 = queue.Queue()
w3 = capture.CaptureWorker(q3, lambda: {"poll_hz": 60, "full_scan_sec": 5})
w3.start()
seen = []
end = time.time() + 8
while time.time() < end and not seen:
    try:
        kind, payload = q3.get(timeout=0.2)
    except queue.Empty:
        continue
    if kind == "pos":
        seen.append(payload)
w3.stop()
w3.join(timeout=5)
assert seen == [(300, 400)], seen
print("8 ok: the found position is reported")
# the search looks only into the game window when it is known (here: a window of 500x300 at 250,200 on a 1000x600 screen)
SCREEN["arr"] = blank()
put(ns["draw"](ns["encode"]([FS.join(["S", "11", "Anna", "in window"])], 11)), x=300, y=250)
grabbed = []
_orig = FakeSct.grab
FakeSct.grab = lambda self, area: (grabbed.append((area["width"], area["height"])), _orig(self, area))[1]
w4 = capture.CaptureWorker(queue.Queue(), lambda: {"poll_hz": 60}, lambda: (250, 200, 500, 300))
hit = w4._search(FakeSct())
assert hit[:4] == (300, 250, "v1", 0), hit
assert grabbed == [(500, 300)], grabbed                        # one grab of the window, not of the monitors
# a wrong window rectangle must not blind it: every 4th full search looks at the monitors
w5 = capture.CaptureWorker(queue.Queue(), lambda: {"poll_hz": 60}, lambda: (700, 10, 280, 150))
found = [w5._search(FakeSct()) for _ in range(4)]
assert [bool(f) for f in found] == [False, False, False, True], found
FakeSct.grab = _orig
print("9 ok: the game window is searched (not the monitors); a wrong window rectangle is corrected by the monitor search")

# ---- protocol v3: the thin line along a screen edge (hides when there is nothing to say) -------------------------------------
def v3_screen(i, text, vertical=False, levels=4, x=None, y=None):
    img = proto3.draw(proto3.encode([FS.join(["S", str(i), "Eve", text, "D"])], i, levels, vertical=vertical), vertical)
    if vertical:
        put(img, x=1000 - proto3.CELL if x is None else x, y=60 if y is None else y)
    else:
        put(img, x=100 if x is None else x, y=600 - proto3.CELL if y is None else y)


def hidden_screen():
    SCREEN["arr"] = blank()


def collect(qq, seconds, want=1):
    got, stats, end = [], [], time.time() + seconds
    while time.time() < end and len(got) < want:
        try:
            kind, payload = qq.get(timeout=0.2)
        except queue.Empty:
            continue
        if kind == "lines":
            got += payload
        elif kind == "status":
            stats.append(payload)
    return got, stats


hidden_screen()                                                # the addon is in v3 with idle-hide: nothing on the screen yet
q6 = queue.Queue()
w6 = capture.CaptureWorker(q6, lambda: {"poll_hz": 60, "full_scan_sec": 600})
w6.start()
time.sleep(1.5)                                                # the first whole-window search found nothing; the next one is far away
v3_screen(21, "hello v3")                                      # a message arrives: the line shows up
got, stats = collect(q6, 8)
assert [(l.id, l.sender, l.text, l.cls) for l in got] == [(21, "Eve", "hello v3", "D")], (got, stats)
print("10 ok: a hidden v3 line was found by the cheap edge-band search as soon as it showed up")

hidden_screen()                                                # idle: the line hides again - that is NOT a lost matrix
got, stats = collect(q6, 3.0, want=99)
assert not any("잃어버림" in t for t in stats), stats
assert any("v3" in t for t in stats), stats
v3_screen(22, "second v3 line", levels=8)                      # the addon changed to 8 levels: same place, read at once
got, stats = collect(q6, 5)
assert [(l.id, l.text) for l in got] == [(22, "second v3 line")], (got, stats)
stats = collect(q6, 0.6, want=99)[1]
assert "v3·8" in stats[-1], stats
print("11 ok: while hidden the matrix is kept (not lost); it is read again when the line returns")

v3_screen(23, "moved to the right edge", vertical=True)        # the player moved the line to the right edge: found by the long scan
cfg6 = {"poll_hz": 60, "full_scan_sec": 5}
w6.stop(); w6.join(timeout=5)
q7 = queue.Queue()
w7 = capture.CaptureWorker(q7, lambda: {"poll_hz": 60, "full_scan_sec": 5, "last_pos": [100, 590]})
w7.start()
time.sleep(1.0)
got, stats = collect(q7, 10)
assert [(l.id, l.text) for l in got] == [(23, "moved to the right edge")], (got, stats)
print("12 ok: a vertical v3 line at the right edge is found (the remembered position was elsewhere)")
v3_screen(24, "after the move", vertical=True)
got, stats = collect(q7, 5)
assert [(l.id, l.text) for l in got] == [(24, "after the move")], (got, stats)
w7.stop(); w7.join(timeout=5)

# the addon switches from a visible v3 line to hiding it and then to v1: the reader gives up v3 at the long scan
q8 = queue.Queue()
v3_screen(25, "v3 again")
w8 = capture.CaptureWorker(q8, lambda: {"poll_hz": 60, "full_scan_sec": 5})
w8.start()
got, stats = collect(q8, 8)
assert [(l.id, l.text) for l in got] == [(25, "v3 again")], (got, stats)
v1_screen(30, "switched back to v1")                           # the line is gone for good; after the long period everything is searched
got, stats = collect(q8, 14)
assert [(l.id, l.text) for l in got] == [(30, "switched back to v1")], (got, stats)
w8.stop(); w8.join(timeout=5)
print("13 ok: after the long scan period a switch from v3 to v1 is noticed")

# the band search grabs only thin strips, never the whole window
grabbed = []
_orig2 = FakeSct.grab
FakeSct.grab = lambda self, area: (grabbed.append((area["width"], area["height"])), _orig2(self, area))[1]
hidden_screen()
w9 = capture.CaptureWorker(queue.Queue(), lambda: {"poll_hz": 60}, lambda: (0, 0, 1000, 600))
assert w9._search_v3(FakeSct()) is None
assert len(grabbed) == 4 and all(min(g) <= proto3.BAND for g in grabbed), grabbed
FakeSct.grab = _orig2
# a grab is cut to its monitor
assert capture.CaptureWorker._clip(FakeSct(), 900, 10, 1500, 3) == {"left": 900, "top": 10, "width": 100, "height": 3}
print("14 ok: the edge-band search grabs 4 thin strips only")
print("capture ok")
