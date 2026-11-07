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
cfg = {"poll_hz": 60}
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
print("capture ok")
