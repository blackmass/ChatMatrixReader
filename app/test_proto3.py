"""Self-test for proto3.py (protocol v3, the stealth line): round trips in both orientations and both level counts, the
dynamic length, damaged colours, locating the line near every screen edge, things that must NOT decode."""
import random

import numpy as np

import proto2
import proto3 as p

FS = "\x1f"
random.seed(11)
np.random.seed(11)


def mk(ch, i, who, text, cls=""):
    return FS.join([ch, str(i), who, text] + ([cls] if cls else []))


def screen(w=1920, h=1080, bg=(30, 60, 20)):
    s = np.zeros((h, w, 4), np.uint8)
    s[:, :, 0], s[:, :, 1], s[:, :, 2], s[:, :, 3] = bg[2], bg[1], bg[0], 255
    return s


def put(scr, img, x, y):
    scr[y:y + img.shape[0], x:x + img.shape[1]] = img


def decode_at(scr, x, y, vertical, length=None):
    length = length or p._extent(scr, x, y, vertical)
    return p.decode(p.oriented(scr, x, y, vertical, length), vertical)


LINES = [mk("P", 1, "Anna", "안녕하세요 hello"), mk("G", 2, "Bob", "LFM tank for mythic, need inv pls"), mk("S", 3, "Çağrı", "ñ é ü ✓")]

# ---- round trips ------------------------------------------------------------------------------------------------------
for levels in p.LEVEL_CHOICES:
    for vertical in (False, True):
        cells = p.encode(LINES, 777, levels, vertical=vertical)
        img = p.draw(cells, vertical)
        scr = screen()
        put(scr, img, 100, 400)
        f, why = decode_at(scr, 100, 400, vertical)
        assert f is not None, (levels, vertical, why)
        assert f.seq == 777 and f.levels == levels and f.vertical == vertical and f.cells == len(cells)
        assert [(l.channel, l.id, l.sender, l.text) for l in f.lines] == [("P", 1, "Anna", "안녕하세요 hello"), ("G", 2, "Bob", "LFM tank for mythic, need inv pls"),
                                                                           ("S", 3, "Çağrı", "ñ é ü ✓")]
        # the wrong orientation is refused, a mismatch of the mode bits too
        f2, why2 = decode_at(scr, 100, 400, not vertical)
        assert f2 is None

# ---- the line is dark and its length follows the text ----------------------------------------------------------------
short = p.encode([mk("P", 1, "A", "hi")], 1, 4)
long_ = p.encode(LINES, 1, 4)
assert len(short) < len(long_) <= p.max_cells(4)
assert max(max(c) for c in long_) == p.LEVEL_MAX
assert p.cells_for(4, 0) >= p.RAMP_START + 4 + p.N_END + 1
assert p.max_cells(4) * p.CELL <= p.GRAB_MAX and p.max_cells(8) * p.CELL <= p.GRAB_MAX

# ---- a full-size frame (the longest chat line + fields) ---------------------------------------------------------------
big = [mk("W", 9, "Longname-Realm", "가" * 80, "K")]
assert len(big[0].encode()) < p.DEFAULT_BUDGET
for levels in p.LEVEL_CHOICES:
    cells = p.encode(big, 5, levels)
    assert len(cells) <= p.max_cells(levels)
    scr = screen()
    put(scr, p.draw(cells), 20, 1080 - p.CELL)
    f, why = decode_at(scr, 20, 1080 - p.CELL, False)
    assert f is not None and f.lines[0].text == "가" * 80, why

# ---- budget that fits a short screen edge -----------------------------------------------------------------------------
for levels in p.LEVEL_CHOICES:
    for length in (800, 1000, 1080, 1383, 3000):
        b = p.budget_that_fits(levels, length)
        assert 0 <= b <= p.DEFAULT_BUDGET
        if b:
            assert p.max_cells(levels, b) * p.CELL <= length, (levels, length, b)
        assert b == p.DEFAULT_BUDGET or p.max_cells(levels, b + 1) * p.CELL > length, (levels, length, b)
assert p.budget_that_fits(4, 10) == 0

# ---- colour damage (brightness, gamma, channel gains, a little noise): the ramp absorbs it ----------------------------------
def distort(img, gamma=1.0, gain=1.0, offset=0.0, chan=(1.0, 1.0, 1.0), noise=0):
    out = img.copy().astype(np.float64)
    for k, cg in zip((2, 1, 0), chan):
        v = img[:, :, k].astype(np.float64) / 255.0
        out[:, :, k] = 255.0 * np.minimum(1.0, gain * cg * v ** gamma) + offset
    if noise:
        out[:, :, :3] += np.random.randint(-noise, noise + 1, size=out[:, :, :3].shape)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


cells = p.encode(LINES, 4, 4)
base = p.draw(cells)
for kw in ({"gain": 1.5}, {"gain": 0.7}, {"gamma": 1.4}, {"gamma": 0.8}, {"chan": (1.0, 0.9, 1.15)}, {"offset": 6.0}, {"noise": 1}):
    scr = screen()
    put(scr, distort(base, **kw), 50, 1080 - p.CELL)
    f, why = decode_at(scr, 50, 1080 - p.CELL, False)
    assert f is not None and f.seq == 4, (kw, why)

# ---- locating: every edge, a window border / title bar offset, the position is exact -----------------------------------------
for vertical in (False, True):
    cells = p.encode(LINES, 99, 4, vertical=vertical)
    img = p.draw(cells, vertical)
    spots = [(x, y) for x in (0, 1, 640, 1919 - 2) for y in (0, 1, 5)]
    if vertical:
        spots = [(x, y) for x in (0, 1, 7, 1920 - p.CELL, 1920 - p.CELL - 1) for y in (0, 300, 1080 - img.shape[0])]
    else:
        spots = [(x, y) for x in (0, 3, 640, 1920 - img.shape[1]) for y in (0, 1, 30, 1080 - p.CELL, 1080 - p.CELL - 1)]
    for x, y in spots:
        scr = screen()
        put(scr, img, x, y)
        hit = p.find_and_decode(scr)
        assert hit is not None, (vertical, x, y)
        hx, hy, hv, extent, f = hit
        assert hv == vertical and f.seq == 99
        assert abs(hx - x) <= 1 and abs(hy - y) <= 1, ((x, y), (hx, hy))
# not near an edge (middle of the screen): not looked for
cells = p.encode(LINES, 99, 4)
scr = screen()
put(scr, p.draw(cells), 300, 500)
assert p.find_and_decode(scr) is None
# find() is cheap on a clean screen and on noise
assert p.find(screen()) == []
noise = np.random.randint(0, 255, size=(1080, 1920, 4), dtype=np.uint8)
assert p.find_and_decode(noise) is None

# ---- things that must not decode ----------------------------------------------------------------------------------------------
scr = screen()
assert decode_at(scr, 0, 1080 - p.CELL, False)[0] is None                          # nothing drawn (a hidden line)
img = p.draw(cells)
bad = img.copy(); bad[:, p.CELL * 30:p.CELL * 31, :3] = 255 - bad[:, p.CELL * 30:p.CELL * 31, :3]      # one damaged data cell
scr = screen(); put(scr, bad, 0, 1080 - p.CELL)
f, why = decode_at(scr, 0, 1080 - p.CELL, False)
assert f is None and why in ("checksum mismatch", "bad length", "no end marker"), why
cut = screen(); put(cut, img[:, :p.CELL * (len(cells) - 10)], 0, 1080 - p.CELL)                   # the line is cut short (covered by something)
assert decode_at(cut, 0, 1080 - p.CELL, False)[0] is None
v2cells = proto2.encode(LINES, 1, 8)
scr = screen(); put(scr, proto2.draw(v2cells), 0, 1000)
assert p.find_and_decode(scr) is None                                                # a v2 matrix is not a v3 line
v3_in_v2 = screen(); put(v3_in_v2, p.draw(cells), 0, 1080 - p.CELL)
assert proto2.find_and_decode(v3_in_v2) is None                                      # and the other way round

# ---- a frame at the very edge of a small window (the line must fit) -------------------------------------------------------------
small = screen(w=1280, h=720)
cells = p.encode([mk("P", 1, "A", "short")], 3, 4)
put(small, p.draw(cells), 0, 720 - p.CELL)
hit = p.find_and_decode(small)
assert hit is not None and 1270 <= hit[3] <= 1280

print("test_proto3 OK")
