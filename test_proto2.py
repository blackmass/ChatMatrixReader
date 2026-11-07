"""Self-test for proto2.py (protocol v2). Draws matrices the way the addon would, damages the colours like a screen
filter / brightness setting would, and checks that they still decode."""
import random
import time

import numpy as np

import decoder as v1
import proto2 as p

FS = "\x1f"
random.seed(7)
np.random.seed(7)


def mk(ch, i, who, text, cls=""):
    return FS.join([ch, str(i), who, text] + ([cls] if cls else []))


WORDS = "LFM tank healer mythic dungeon need inv pls WTS WTB gold Hello the quick brown fox jumps over lazy dog Thanks".split()


def rand_lines(korean=False):
    out = []
    for i in range(1, 6):
        t = " ".join(random.choice(WORDS) for _ in range(random.randint(3, 9)))
        if korean:
            t += " 한글 테스트 ñ é ü"
        out.append(mk(random.choice(["S", "P", "G", "C1"]), i, "Name%d" % i, t, random.choice(["", "A", "K", "M"])))
    return out


def distort(img, gamma=1.0, gain=1.0, offset=0.0, chan=(1.0, 1.0, 1.0), noise=1):
    """Colour damage on a BGRA image: out = clip(gain*chan*(v/255)^gamma*255 + offset) (+-noise)."""
    out = img.copy().astype(np.float64)
    for k, ch_gain in zip((2, 1, 0), chan):                       # BGRA index -> R, G, B
        v = img[:, :, k].astype(np.float64) / 255.0
        out[:, :, k] = 255.0 * np.minimum(1.0, gain * ch_gain * v ** gamma) + offset
    if noise:
        out[:, :, :3] += np.random.randint(-noise, noise + 1, size=out[:, :, :3].shape)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


# 1. sizes and plain round trip, every mode, ASCII and UTF-8, class field
sizes = {L: p.size_px(L) for L in (2, 4, 8, 16)}
assert sizes == {2: (128, 92), 4: (128, 48), 8: (128, 36), 16: (128, 28)}, sizes
for L in (2, 4, 8, 16):
    lines = rand_lines(korean=True)
    img = p.draw(p.encode(lines, 424242, L))
    assert img.shape[:2] == (sizes[L][1], 128)
    frame, why = p.decode(img, 0, 0)
    assert frame is not None, (L, why)
    assert frame.seq == 424242 and frame.levels == L and frame.rows == img.shape[0] // 4
    assert abs(frame.gain - 1.0) < 0.01
    got = [(l.channel, l.id, l.sender, l.text, l.cls) for l in frame.lines]
    want = []
    for s in lines[-len(got):]:
        f = s.split(FS)
        want.append((f[0], int(f[1]), f[2], f[3], f[4] if len(f) > 4 else ""))
    assert got == want, (L, got, want)
print("1 ok: round trip in all four modes, UTF-8, class letter, sizes", sizes)

# 2. budget: newest lines that fit
many = [mk("S", i, "Spammer", "x" * 60) for i in range(1, 12)]
frame, _ = p.decode(p.draw(p.encode(many, 1, 8)), 0, 0)
ids = [l.id for l in frame.lines]
assert ids == sorted(ids) and ids[-1] == 11 and 0 < len(ids) < 11, ids
print("2 ok: budget")

# 3. colour damage: success rates per mode (whole frame must decode, 30 random frames each)
def rate(L, n=30, **kw):
    ok = 0
    for _ in range(n):
        img = p.draw(p.encode(rand_lines(korean=random.random() < 0.5), random.randint(1, 10 ** 6), L))
        frame, _ = p.decode(distort(img, **kw), 0, 0)
        ok += frame is not None
    return ok / n


CASES = {
    "brighter (gain 1.2)": dict(gain=1.2),
    "darker (gain 0.6)": dict(gain=0.6),
    "gamma 0.7": dict(gamma=0.7),
    "gamma 1.5": dict(gamma=1.5),
    "gamma 1.3 + gain 1.15": dict(gamma=1.3, gain=1.15),
    "gamma 0.8 + gain 0.7": dict(gamma=0.8, gain=0.7),
    "black lift +25": dict(offset=25, gain=0.9),
    "night mode (B 0.6, G 0.85)": dict(chan=(1.0, 0.85, 0.6)),
    "no damage": dict(),
}
print("3 success rate by mode (2/4/8/16 levels):")
table = {}
for name, kw in CASES.items():
    table[name] = [rate(L, **kw) for L in (2, 4, 8, 16)]
    print("   %-28s %s" % (name, "  ".join("%4.0f%%" % (100 * r) for r in table[name])))
# the 8-level mode (the recommended one) must survive all of these; 2 and 4 levels are the sturdier ones
for name in CASES:
    assert table[name][2] == 1.0, ("8 levels failed", name, table[name])
    assert table[name][0] == 1.0 and table[name][1] == 1.0, ("2/4 levels failed", name, table[name])
assert table["no damage"] == [1.0] * 4
print("   8 levels (and fewer) survive every case above")

# 4. strong brightening clips the top levels: must be refused (not mis-decoded)
img = p.draw(p.encode(rand_lines(), 5, 8))
for gain in (1.6, 2.5):
    frame, why = p.decode(distort(img, gain=gain), 0, 0)
    assert frame is None or frame.seq == 5, "wrong frame accepted"
print("4 ok: hopeless damage is rejected, never mis-decoded")

# 5. locating: matrix pasted at a random place in a busy fake screen, damaged colours
def fake_screen(w=1920, h=1080):
    scr = np.random.randint(0, 256, size=(h, w, 4), dtype=np.uint8)
    scr[:, :, 3] = 255
    # flat UI-like blocks (these produce edges everywhere)
    for _ in range(300):
        x, y = random.randrange(0, w - 80), random.randrange(0, h - 60)
        scr[y:y + random.randint(8, 60), x:x + random.randint(8, 80), :3] = np.random.randint(0, 256, size=3)
    return scr


for L in (8, 4, 16, 2):
    lines = rand_lines()
    img = distort(p.draw(p.encode(lines, 99, L)), gamma=1.2, gain=1.1)
    scr = fake_screen()
    x0, y0 = random.randrange(0, 1920 - 128), random.randrange(0, 1080 - img.shape[0])
    scr[y0:y0 + img.shape[0], x0:x0 + 128] = img
    t = time.perf_counter()
    hit = p.find_and_decode(scr)
    dt = time.perf_counter() - t
    assert hit is not None and hit[:2] == (x0, y0) and hit[2].levels == L, (L, hit and hit[:2], (x0, y0))
    print("5 ok: located %2d levels at (%d,%d) in a busy 1920x1080 screen: %.0f ms" % (L, x0, y0, dt * 1000))

# 6. no false positives: random screens, and a v1 matrix is not mistaken for v2 (and vice versa)
for _ in range(5):
    assert p.find_and_decode(fake_screen()) is None
v1cells = []
ns = {}
exec(open("test_decoder.py", encoding="utf-8").read().split("lines = [mk")[0], ns)
v1img = ns["draw"](ns["encode"]([mk("S", 1, "A", "hello")], 3))
scr = fake_screen()
scr[100:100 + v1img.shape[0], 200:200 + 128] = v1img
assert p.find_and_decode(scr) is None
assert v1.find_matrix(scr) == (200, 100)
v2img = p.draw(p.encode([mk("S", 1, "A", "hello")], 3, 8))
scr = fake_screen()
scr[100:100 + v2img.shape[0], 200:200 + 128] = v2img
assert v1.find_matrix(scr) is None
print("6 ok: no false positives; v1 and v2 are told apart")

# 7. small corner search window like the reader uses (900x260) is quick
corner = fake_screen(900, 260)
t = time.perf_counter()
for _ in range(10):
    p.find_and_decode(corner)
print("7 ok: corner window search %.1f ms" % ((time.perf_counter() - t) * 100))
print("ALL v2 TESTS PASSED")
