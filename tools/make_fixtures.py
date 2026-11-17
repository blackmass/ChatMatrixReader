"""Draws matrices with the 2.0 reference encoders (Python) and writes them as raw BGRA files plus tests/fixtures/manifest.json.
The JS decoders (app/core) must read them back to the same lines. Run it from anywhere:  python tools/make_fixtures.py <path to ChatMatrixReader2/app>"""
import json, os, random, sys
import numpy as np

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "ChatMatrixReader2", "app")
sys.path.insert(0, SRC)
import decoder as v1, proto2 as p2, proto3 as p3
ns = {}
exec(open(os.path.join(SRC, "test_decoder.py"), encoding="utf-8").read().split("lines = [mk")[0], ns)   # v1 encoder/draw

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")
os.makedirs(OUT, exist_ok=True)
random.seed(11); np.random.seed(11)
FS = "\x1f"
mk = lambda ch, i, who, text, cls="": FS.join([ch, str(i), who, text] + ([cls] if cls else []))
LINES = [mk("P", 1, "Anna", "안녕하세요 hello", "A"), mk("G", 2, "Bob", "LFM tank for mythic, need inv pls", "K"),
         mk("S", 3, "Çağrı", "ñ é ü ✓", "M"), mk("C1", 4, "", "server announcement")]
manifest = []


def parse(lines):
    out = []
    for s in lines:
        f = s.split(FS)
        out.append([f[0], int(f[1]), f[2], f[3], f[4] if len(f) > 4 else ""])
    return out


def distort(img, gamma=1.0, gain=1.0, offset=0.0, chan=(1.0, 1.0, 1.0), noise=1):
    out = img.copy().astype(np.float64)
    for k, cg in zip((2, 1, 0), chan):
        v = img[:, :, k].astype(np.float64) / 255.0
        out[:, :, k] = 255.0 * np.minimum(1.0, gain * cg * v ** gamma) + offset
    if noise:
        out[:, :, :3] += np.random.randint(-noise, noise + 1, size=out[:, :, :3].shape)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def to_p3(img):
    m = np.array([[0.8224621, 0.1775380, 0.0], [0.0331941, 0.9668058, 0.0], [0.0170827, 0.0723974, 0.9105199]])
    lin = p2._to_lin(img[:, :, [2, 1, 0]].astype(np.float64) / 255) @ m.T
    out = img.copy()
    out[:, :, [2, 1, 0]] = np.round(p2._from_lin(lin) * 255).astype(np.uint8)
    return out


def save(name, kind, img, expect, **extra):
    img = np.ascontiguousarray(img)
    with open(os.path.join(OUT, name + ".bin"), "wb") as f:
        f.write(img.tobytes())
    manifest.append(dict(name=name, kind=kind, width=int(img.shape[1]), height=int(img.shape[0]), expect=expect, **extra))


# v1
for cols in (32, 16):
    cells = ns["encode"](LINES, 12345)
    img = ns["draw"](cells, cols)
    save(f"v1_cols{cols}", "v1", img, dict(seq=12345, cols=cols, lines=parse(LINES)))

# v2
DAMAGE = {"plain": dict(noise=0), "bright": dict(gain=1.2), "dark": dict(gain=0.6), "gamma": dict(gamma=1.3, gain=1.15), "night": dict(chan=(1.0, 0.85, 0.6))}
for L in (2, 4, 8, 16):
    for cols in (32, 16):
        for dn, kw in DAMAGE.items():
            if dn not in ("plain", "gamma") and not (cols == 32 and L in (4, 8)):
                continue
            img = p2.draw(p2.encode(LINES, 424242, L, cols=cols), cols=cols)
            save(f"v2_L{L}_c{cols}_{dn}", "v2", distort(img, **kw), dict(seq=424242, levels=L, cols=cols, rows=img.shape[0] // 4, lines=parse(LINES)))
    img = p2.draw(p2.encode(LINES, 9, L))
    save(f"v2_L{L}_p3", "v2", to_p3(img), dict(seq=9, levels=L, cols=32, rows=img.shape[0] // 4, lines=parse(LINES)))
big = [mk("S", 77, "Averylongcharactername-Someserver", "x" * 255, "W")]
save("v2_L8_longline", "v2", p2.draw(p2.encode(big, 99, 8)), dict(seq=99, levels=8, cols=32, rows=p2.rows_for(8), lines=parse(big)))
img = p2.draw(p2.encode(LINES, 5, 8))
save("v2_L8_clipped", "v2_reject", distort(img, gain=2.5), dict(seq=5))

# v3
for L in (4, 8):
    for vertical in (False, True):
        cells = p3.encode(LINES, 777, L, vertical=vertical)
        img = p3.draw(cells, vertical)
        save(f"v3_L{L}_{'v' if vertical else 'h'}", "v3", img, dict(seq=777, levels=L, cells=len(cells), vertical=vertical, lines=parse(LINES)), vertical=vertical)
        if L == 4:
            for dn, kw in (("gain", dict(gain=1.5)), ("dark", dict(gain=0.7)), ("gamma", dict(gamma=1.4)), ("night", dict(chan=(1.0, 0.9, 1.15)))):
                save(f"v3_L{L}_{'v' if vertical else 'h'}_{dn}", "v3", distort(img, **kw), dict(seq=777, levels=L, cells=len(cells), vertical=vertical, lines=parse(LINES)), vertical=vertical)
cells = p3.encode(LINES, 9, 4)
img = p3.draw(cells)
save("v3_L4_p3", "v3", to_p3(img), dict(seq=9, levels=4, cells=len(cells), vertical=False, lines=parse(LINES)), vertical=False)
cells = p3.encode(big, 5, 8)
save("v3_L8_longline", "v3", p3.draw(cells), dict(seq=5, levels=8, cells=len(cells), vertical=False, lines=parse(big)), vertical=False)
cells = p3.encode([mk("P", 1, "A", "short")], 3, 4)
save("v3_L4_short", "v3", p3.draw(cells), dict(seq=3, levels=4, cells=len(cells), vertical=False, lines=parse([mk("P", 1, "A", "short")])), vertical=False)
# a line cut short and one with a damaged cell (must NOT decode)
cells = p3.encode(LINES, 4, 4)
img = p3.draw(cells)
bad = img.copy(); bad[:, 4 * 30:4 * 31, :3] = 255 - bad[:, 4 * 30:4 * 31, :3]
save("v3_bad_cell", "v3_reject", bad, dict(), vertical=False)
save("v3_cut", "v3_reject", img[:, :4 * (len(cells) - 10)], dict(), vertical=False)

json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print(len(manifest), "fixtures,", sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) // 1024, "KB")
