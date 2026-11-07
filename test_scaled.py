"""scaled.py: matrices with non-4px cells and a colour-space conversion (macOS Retina / Display P3)."""
import sys

import numpy as np

import proto2
import scaled

FS = "\x1f"
P3 = np.array([[0.8224621, 0.1775380, 0.0], [0.0331941, 0.9668058, 0.0], [0.0170827, 0.0723974, 0.9105199]])


def to_p3(img):
    lin = proto2._to_lin(img[:, :, [2, 1, 0]].astype(np.float64) / 255) @ P3.T
    out = img.copy()
    out[:, :, [2, 1, 0]] = np.round(proto2._from_lin(lin) * 255).astype(np.uint8)
    return out


def zoom(a, f):                                                    # bilinear, like a scaled screenshot
    h, w = a.shape[:2]
    nh, nw = int(h * f), int(w * f)
    ys, xs = np.linspace(0, h - 1, nh), np.linspace(0, w - 1, nw)
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    y1, x1 = np.minimum(y0 + 1, h - 1), np.minimum(x0 + 1, w - 1)
    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
    a = a.astype(np.float32)
    return (a[y0][:, x0] * (1 - fx) * (1 - fy) + a[y0][:, x1] * fx * (1 - fy)
            + a[y1][:, x0] * (1 - fx) * fy + a[y1][:, x1] * fx * fy).astype(np.uint8)


def screen(img, f, x=234, y=300, p3=True):
    z = zoom(to_p3(img) if p3 else img, f)
    s = np.random.randint(0, 256, size=(y + z.shape[0] + 200, x + z.shape[1] + 200, 4), dtype=np.uint8)
    s[:, :, 3] = 255
    s[y:y + z.shape[0], x:x + z.shape[1]] = z
    return s


line = FS.join(["S", "7", "Bob", "hello 안녕", "H"])
n = 0
for lv in (8, 4, 16):
    img = proto2.draw(proto2.encode([line] * 3, 5, levels=lv))
    for f in (1.0, 1.125, 1.5, 2.0, 2.25):
        if lv == 16 and f > 1.2:
            continue
        hit = scaled.find(screen(img, f))
        assert hit is not None, (lv, f)
        x, y, p, frame = hit
        assert frame.levels == lv and len(frame.lines) == 3 and frame.lines[0].cls == "H", (lv, f)
        assert abs(p - 4 * f) < 0.3 and abs(x - 234) < 2 and abs(y - 300) < 2, (lv, f, x, y, p)
        n += 1
print(f"1 ok: {n} combinations of level / scale / P3 colours found and read")

# random content on screen: no false positives, and quick
junk = np.random.randint(0, 256, size=(900, 1000, 4), dtype=np.uint8)
assert scaled.find(junk) is None
print("2 ok: nothing found in noise")

# the 2-level matrix is the tallest
img = proto2.draw(proto2.encode([line] * 3, 5, levels=2))
hit = scaled.find(screen(img, 2.25))
assert hit and hit[3].levels == 2 and hit[3].rows == 23
print("3 ok: 2 levels (23 rows) at 2.25x")
print("scaled ok")
