"""ChatMatrix protocol v2 - colour-change tolerant pixel format (see PROTOCOL.md, "Protocol v2").

Instead of 256 levels per colour channel the addon uses L = 2, 4, 8 or 16 well separated levels, and every frame carries
a ramp of the levels it uses. The reader measures the ramp and classifies every data cell against it, so brightness,
gamma, contrast, colour filters and the like (anything that keeps the levels in order) do no harm.

This file holds the format constants, a reference ENCODER (used by the tests and as the model for the Lua addon),
the DECODER and the locator. Pure functions on numpy arrays (BGRA uint8, as returned by mss).
"""
from dataclasses import dataclass

import numpy as np

import decoder as v1

CELL = 4
COLS = 32                                 # default: 32 cells per row ...
COL_CHOICES = (32, 16)                    # ... or 16 (the addon's "narrow" shape: 64 px wide, twice as many rows)
WIDTH = COLS * CELL                       # 128 px, the same as v1
MIN_WIDTH = min(COL_CHOICES) * CELL       # the narrowest shape
PREAMBLE = [(1, 1, 1), (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0), (0, 0, 0), (1, 1, 1)]   # W K R G B Y K W
END = [(0, 0, 0), (1, 1, 1), (0, 0, 0), (1, 1, 1)]                                                     # K W K W
N_PRE, N_MODE, RAMP_START, N_END = 8, 4, 12, 4
LEVEL_MAX = 180                           # highest data level (headroom against brightening)
LEVEL_CODES = {2: 0, 4: 1, 8: 2, 16: 3}
CODE_LEVELS = {v: k for k, v in LEVEL_CODES.items()}
HEADER_BYTES = 9                          # seq(3) length(2) lines(1) checksum(3)
DEFAULT_BUDGET = 320                      # payload bytes the matrix size is made for (V2_BUDGET in the addon): one chat line of 255 bytes + its fields
VERSION = 2
MIN_CONTRAST = 40                         # white minus black (per channel) needed to trust the preamble


def bits_per_symbol(levels):
    return levels.bit_length() - 1


def level_values(levels):
    return [int(round(i * LEVEL_MAX / (levels - 1))) for i in range(levels)]


def rows_for(levels, budget=DEFAULT_BUDGET, cols=COLS):
    """Number of cell rows for a payload budget (fixed per mode, so the matrix never changes size)."""
    need_bits = 8 * (HEADER_BYTES + budget)
    data_cells = -(-need_bits // (3 * bits_per_symbol(levels)))
    return -(-(RAMP_START + levels + N_END + data_cells) // cols)


def size_px(levels, budget=DEFAULT_BUDGET, cols=COLS):
    return cols * CELL, rows_for(levels, budget, cols) * CELL


@dataclass
class Frame2:
    seq: int
    lines: list
    levels: int
    rows: int
    gain: float                           # how bright the screen shows the top level (1.0 = as sent); for the log
    cols: int = COLS                      # cells per row of the matrix this frame came from (32 or 16)


# ----------------------------------------------------------------------
# encoder (reference)
# ----------------------------------------------------------------------
def _mode_bits(levels, rows):
    bits = [0, 1, 0]                                              # version 2
    code = LEVEL_CODES[levels]
    bits += [code >> 1 & 1, code & 1]
    r = rows - 1
    bits += [(r >> k) & 1 for k in range(5, -1, -1)]
    bits.append(sum(bits) & 1)                                     # parity
    return bits


def encode(lines, seq, levels=8, budget=DEFAULT_BUDGET, cols=COLS):
    """-> list of (r, g, b) cell colours, row-major. `lines` are payload line strings (newest last)."""
    picked, total = [], 0
    for line in reversed(lines):
        n = len(line.encode("utf-8")) + (1 if picked else 0)
        if total + n > budget:
            break
        picked.insert(0, line)
        total += n
    payload = "\n".join(picked).encode("utf-8")
    rows = rows_for(levels, budget, cols)
    n_cells = rows * cols
    b = bits_per_symbol(levels)
    data_cells = n_cells - RAMP_START - levels - N_END
    data = (seq.to_bytes(3, "big") + len(payload).to_bytes(2, "big") + bytes([len(picked)])
            + v1.checksum(payload).to_bytes(3, "big") + payload)
    bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8))
    bits = np.concatenate([bits, np.zeros(data_cells * 3 * b - len(bits), dtype=np.uint8)])
    assert len(bits) == data_cells * 3 * b, "payload does not fit"
    weights = 1 << np.arange(b - 1, -1, -1)
    symbols = (bits.reshape(-1, b) * weights).sum(axis=1).reshape(data_cells, 3)
    lv = np.array(level_values(levels))
    cells = [tuple(255 * x for x in c) for c in PREAMBLE]
    mb = _mode_bits(levels, rows)
    cells += [tuple(255 * x for x in mb[i * 3:i * 3 + 3]) for i in range(N_MODE)]
    cells += [(int(v), int(v), int(v)) for v in lv]
    cells += [tuple(int(x) for x in lv[s]) for s in symbols]
    cells += [tuple(255 * x for x in c) for c in END]
    assert len(cells) == n_cells
    return cells


def draw(cells, cols=COLS):
    rows = len(cells) // cols
    img = np.zeros((rows * CELL, cols * CELL, 4), dtype=np.uint8)
    for i, (r, g, bl) in enumerate(cells):
        x, y = (i % cols) * CELL, (i // cols) * CELL
        img[y:y + CELL, x:x + CELL] = (bl, g, r, 255)
    return img


# ----------------------------------------------------------------------
# decoder
# ----------------------------------------------------------------------
def _centres(region, n_rows, cols=COLS):
    """RGB of every cell centre: (n_rows*cols, 3) int."""
    c = region[2:n_rows * CELL:CELL, 2:cols * CELL:CELL]            # (rows, cols, 4) BGRA
    return c[:, :, [2, 1, 0]].reshape(-1, 3).astype(np.int32)


def _to_lin(v):
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def _from_lin(v):
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)


def _gamut_fix(first):
    """Some screens/systems convert the colours to another colour space (macOS: sRGB -> Display P3), which mixes the
    channels: pure green (0,255,0) arrives as (117,251,76). The preamble holds pure red, green and blue (cells 2-4) plus
    black and white, so the mixing can be measured and undone. -> function(cells) or None if nothing needs undoing."""
    hi, lo = first[0].astype(np.float64), first[1].astype(np.float64)
    span = hi - lo
    if (span < MIN_CONTRAST).any():
        return None
    P = (first[2:5].astype(np.float64) - lo) / span              # rows: what pure R, G, B look like (0..1 per channel)
    off = P - np.diag(np.diag(P))
    if off.max() < 0.06 or np.diag(P).min() < 0.5:
        return None                                              # no noticeable mixing (or not primaries): leave as is
    M = _to_lin(P).T                                             # linear light: column j = what primary j became
    if np.linalg.cond(M) > 50:
        return None
    inv = np.linalg.inv(M)

    def fix(cells):
        lin = _to_lin((np.asarray(cells, dtype=np.float64) - lo) / span)
        return _from_lin(lin @ inv.T) * span + lo

    return fix


def decode(arr, x, y, cols=None):
    """Decode a v2 matrix whose top-left pixel is (x, y). cols = cells per row if known (32 or 16), else every shape is tried
    (the checksum tells which one is right). -> (Frame2, None) or (None, reason)."""
    if cols:
        return _decode_cols(arr, x, y, cols)
    why = "no preamble"
    for c in COL_CHOICES:
        frame, why = _decode_cols(arr, x, y, c)
        if frame is not None:
            return frame, None
    return None, why


def _decode_cols(arr, x, y, cols):
    h, w = arr.shape[:2]
    width = cols * CELL
    if x < 0 or y < 0 or x + width > w or y + CELL > h:
        return None, "outside"
    first = _centres(arr[y:y + CELL, x:x + width], 1, cols)
    hi, lo = first[0], first[1]
    if (hi - lo).min() < MIN_CONTRAST:
        return None, "no preamble"
    thr2 = hi + lo
    fix = _gamut_fix(first)
    if fix is not None:
        first = fix(first)
    bits = (2 * first[:RAMP_START] > thr2).astype(np.int32)
    if [tuple(r) for r in bits[:N_PRE].tolist()] != PREAMBLE:
        return None, "no preamble"
    mb = bits[N_PRE:RAMP_START].reshape(-1).tolist()
    if mb[:3] != [0, 1, 0] or (sum(mb[:11]) & 1) != mb[11]:
        return None, "bad mode"
    levels = CODE_LEVELS[mb[3] * 2 + mb[4]]
    rows = 1 + sum(bit << (5 - k) for k, bit in enumerate(mb[5:11]))
    if y + rows * CELL > h:
        return None, "outside"
    cells = _centres(arr[y:y + rows * CELL, x:x + width], rows, cols)
    if fix is not None:
        cells = fix(cells)
    n = rows * cols
    end = (2 * cells[n - N_END:] > thr2).astype(np.int32)
    if [tuple(r) for r in end.tolist()] != END:
        return None, "no end marker"
    ramp = cells[RAMP_START:RAMP_START + levels]
    if (np.diff(ramp, axis=0) <= 0).any():
        return None, "ramp merged"                      # two levels look the same: this mode is too weak for the screen
    data = cells[RAMP_START + levels:n - N_END]
    sym = np.empty(data.shape, dtype=np.int64)
    for c in range(3):
        mids = (ramp[:-1, c] + ramp[1:, c]) / 2.0
        sym[:, c] = np.searchsorted(mids, data[:, c])
    b = bits_per_symbol(levels)
    bits_all = ((sym.reshape(-1, 1) >> np.arange(b - 1, -1, -1)) & 1).astype(np.uint8).reshape(-1)
    raw = np.packbits(bits_all[:len(bits_all) // 8 * 8]).tobytes()
    seq = int.from_bytes(raw[0:3], "big")
    length = int.from_bytes(raw[3:5], "big")
    if length > len(raw) - HEADER_BYTES:
        return None, "bad length"
    payload = raw[HEADER_BYTES:HEADER_BYTES + length]
    if v1.checksum(payload) != int.from_bytes(raw[6:9], "big"):
        return None, "checksum mismatch"
    gain = float(ramp[-1].mean()) / level_values(levels)[-1] if level_values(levels)[-1] else 1.0
    return Frame2(seq, v1.parse_payload(payload), levels, rows, gain, cols), None


def find(arr, max_candidates=60):
    """Candidate top-left positions of v2 matrices in a screenshot (cheap checks only; decode() decides)."""
    h, w = arr.shape[:2]
    hh, ww = h - CELL + 1, w - MIN_WIDTH + 1
    if hh <= 0 or ww <= 0:
        return []
    A = arr[2:2 + hh, 2:2 + ww, :3].astype(np.int16)                 # cell 0 centres (white)
    Bv = arr[2:2 + hh, 6:6 + ww, :3].astype(np.int16)                # cell 1 centres (black)
    ok = ((A - Bv) >= MIN_CONTRAST).all(axis=2)
    ys, xs = np.nonzero(ok)
    if len(ys) == 0:
        return []
    hi = A[ys, xs][:, ::-1]                                          # -> RGB
    lo = Bv[ys, xs][:, ::-1]
    thr2 = hi + lo
    keep = np.ones(len(ys), dtype=bool)
    for i in range(2, N_PRE):
        px = arr[ys + 2, xs + 2 + CELL * i, :3][:, ::-1].astype(np.int16)
        want = np.array(PREAMBLE[i], dtype=bool)
        keep &= ((2 * px > thr2) == want).all(axis=1)
        if not keep.any():
            return []
    return list(zip(xs[keep].tolist(), ys[keep].tolist()))[:max_candidates]


def refine(arr, x, y, seq, cols=None):
    """A position up to 2 px off still decodes (the centre sample stays inside its cell); return the exact origin:
    the middle of the range of offsets that decode."""
    oks_x, oks_y = [], []
    for d in range(-3, 4):
        f, _ = decode(arr, x + d, y, cols)
        if f is not None and f.seq == seq:
            oks_x.append(d)
        f, _ = decode(arr, x, y + d, cols)
        if f is not None and f.seq == seq:
            oks_y.append(d)
    if not oks_x or not oks_y:
        return x, y
    return x + int(np.floor(np.mean(oks_x) + 0.5)), y + int(np.floor(np.mean(oks_y) + 0.5))


def find_and_decode(arr):
    """-> (x, y, Frame2) of the first valid v2 matrix in the screenshot, or None."""
    for x, y in find(arr):
        frame, _ = decode(arr, x, y)
        if frame is not None:
            x, y = refine(arr, x, y, frame.seq, frame.cols)
            frame, _ = decode(arr, x, y, frame.cols)
            if frame is not None:
                return x, y, frame
    return None
