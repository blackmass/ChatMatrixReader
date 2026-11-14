"""ChatMatrix protocol v3 - the "stealth line" (see PROTOCOL.md, "Protocol v3").

The same idea as v2 (a few well separated levels per colour channel plus a ramp of the levels the frame uses, so the reader
measures the levels instead of assuming them), but

  * one single row of cells (4 x 4 px each, like v1 / v2) along a screen edge, horizontal (read left -> right) or vertical (read top -> bottom),
  * dark colours only: the highest level (and "white" of the preamble) is LEVEL_MAX = 96 of 255, so the line is hardly visible,
  * the number of cells is written into the frame and changes with the amount of text: a short message is a short line,
  * the addon may hide the line completely when there is nothing to say.

v1 and v2 are not touched; a v3 frame starts with the version bits 0 1 1 (v2: 0 1 0), so the formats never get mixed up.
This file holds the format constants, a reference ENCODER (used by the tests and as the model for the Lua addon), the DECODER and
the locator. Pure functions on numpy arrays (BGRA uint8, as returned by mss).
"""
from dataclasses import dataclass

import numpy as np

import decoder as v1
import proto2

CELL = 4                                  # physical pixels per cell, the same as v1 / v2 (the line is CELL px thick)
PREAMBLE = proto2.PREAMBLE                # W K R G B Y K W, "white" = LEVEL_MAX
END = proto2.END                          # K W K W
N_PRE, N_MODE, RAMP_START, N_END = 8, 6, 14, 4
LEVEL_MAX = 96                            # highest level (and "white" of preamble / end marker)
LEVEL_CHOICES = (4, 8)
LEVEL_CODES = proto2.LEVEL_CODES
CODE_LEVELS = proto2.CODE_LEVELS
HEADER_BYTES = 9                          # seq(3) length(2) lines(1) checksum(3)
DEFAULT_BUDGET = 320                      # payload bytes a frame may carry at most (V3_BUDGET in the addon)
MAX_CELLS = 2047                          # 11 bits in the mode cells
MIN_CONTRAST = 40                         # white minus black (per channel) needed to trust the preamble
BAND = 48                                 # how far from a screen edge the locator looks for a line (window borders, title bar ...)
GRAB_MAX = 2048                           # most pixels along the line a reader has to grab (a frame is at most ~470 cells = 1880 px)

PLACES = ("bottomleft", "bottom", "bottomright", "topleft", "top", "topright",
          "lefttop", "left", "leftbottom", "righttop", "right", "rightbottom")
VERTICAL = {"lefttop", "left", "leftbottom", "righttop", "right", "rightbottom"}


def bits_per_symbol(levels):
    return levels.bit_length() - 1


def level_values(levels):
    return [int(round(i * LEVEL_MAX / (levels - 1))) for i in range(levels)]


def data_cells_for(levels, payload_len):
    return -(-8 * (HEADER_BYTES + payload_len) // (3 * bits_per_symbol(levels)))


def cells_for(levels, payload_len):
    """Number of cells of a frame that carries `payload_len` payload bytes."""
    return N_PRE + N_MODE + levels + data_cells_for(levels, payload_len) + N_END


def max_cells(levels, budget=DEFAULT_BUDGET):
    return cells_for(levels, budget)


def budget_that_fits(levels, length_px, budget=DEFAULT_BUDGET):
    """The payload budget (<= `budget`) whose longest frame still fits into `length_px` pixels."""
    cells = length_px // CELL
    data = cells - (N_PRE + N_MODE + levels + N_END)
    if data <= 0:
        return 0
    return max(0, min(budget, data * 3 * bits_per_symbol(levels) // 8 - HEADER_BYTES))


@dataclass
class Frame3:
    seq: int
    lines: list
    levels: int
    cells: int                            # number of cells of the frame
    gain: float                           # how bright the screen shows the top level (1.0 = as sent); for the log
    vertical: bool = False


# ----------------------------------------------------------------------
# encoder (reference)
# ----------------------------------------------------------------------
def _mode_bits(levels, vertical, n):
    bits = [0, 1, 1]                                              # version 3
    code = LEVEL_CODES[levels]
    bits += [code >> 1 & 1, code & 1, 1 if vertical else 0]
    bits += [(n >> k) & 1 for k in range(10, -1, -1)]
    bits.append(sum(bits) & 1)                                    # parity
    return bits


def encode(lines, seq, levels=4, budget=DEFAULT_BUDGET, vertical=False):
    """-> list of (r, g, b) cell colours, in reading order. `lines` are payload line strings (newest last)."""
    picked, total = [], 0
    for line in reversed(lines):
        n = len(line.encode("utf-8")) + (1 if picked else 0)
        if total + n > budget:
            break
        picked.insert(0, line)
        total += n
    payload = "\n".join(picked).encode("utf-8")
    n = cells_for(levels, len(payload))
    b = bits_per_symbol(levels)
    data_cells = n - N_PRE - N_MODE - levels - N_END
    data = (seq.to_bytes(3, "big") + len(payload).to_bytes(2, "big") + bytes([len(picked) % 256])
            + v1.checksum(payload).to_bytes(3, "big") + payload)
    bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8))
    bits = np.concatenate([bits, np.zeros(data_cells * 3 * b - len(bits), dtype=np.uint8)])
    weights = 1 << np.arange(b - 1, -1, -1)
    symbols = (bits.reshape(-1, b) * weights).sum(axis=1).reshape(data_cells, 3)
    lv = np.array(level_values(levels))
    cells = [tuple(LEVEL_MAX * x for x in c) for c in PREAMBLE]
    mb = _mode_bits(levels, vertical, n)
    cells += [tuple(LEVEL_MAX * x for x in mb[i * 3:i * 3 + 3]) for i in range(N_MODE)]
    cells += [(int(v), int(v), int(v)) for v in lv]
    cells += [tuple(int(x) for x in lv[s]) for s in symbols]
    cells += [tuple(LEVEL_MAX * x for x in c) for c in END]
    assert len(cells) == n
    return cells


def draw(cells, vertical=False, thickness=CELL):
    """The picture (BGRA) of a frame: CELL px thick, horizontal or vertical."""
    n = len(cells)
    img = np.zeros((thickness, n * CELL, 4), dtype=np.uint8)
    for i, (r, g, bl) in enumerate(cells):
        img[:, i * CELL:(i + 1) * CELL] = (bl, g, r, 255)
    if vertical:
        img = np.ascontiguousarray(np.transpose(img, (1, 0, 2)))
    return img


# ----------------------------------------------------------------------
# decoder
# ----------------------------------------------------------------------
MID = CELL // 2                           # offset of a cell's centre pixel


def _centres(row, n):
    """RGB of the centres of the first n cells of a horizontal line picture (>= CELL rows): (n, 3) int."""
    c = row[MID, MID:n * CELL:CELL]
    return c[:, [2, 1, 0]].astype(np.int32)


def oriented(arr, x, y, vertical, length):
    """The line whose first cell starts at (x, y), as a horizontal picture (CELL rows): vertical lines are turned."""
    if vertical:
        return np.transpose(arr[y:y + length, x:x + CELL], (1, 0, 2))
    return arr[y:y + CELL, x:x + length]


def decode(row, vertical=None):
    """Decode a horizontal line picture (CELL rows, as many columns as are available) whose first cell is at column 0.
    `vertical`: the orientation the caller found it in (None = do not check). -> (Frame3, None) or (None, reason)."""
    if row.shape[0] < CELL or row.shape[1] < RAMP_START * CELL:
        return None, "outside"
    first = _centres(row, RAMP_START)
    hi, lo = first[0], first[1]
    if (hi - lo).min() < MIN_CONTRAST:
        return None, "no preamble"
    thr2 = hi + lo
    fix = proto2._gamut_fix(first)
    if fix is not None:
        first = fix(first)
    bits = (2 * first > thr2).astype(np.int32)
    if [tuple(r) for r in bits[:N_PRE].tolist()] != PREAMBLE:
        return None, "no preamble"
    mb = bits[N_PRE:RAMP_START].reshape(-1).tolist()
    if mb[:3] != [0, 1, 1] or (sum(mb[:17]) & 1) != mb[17]:
        return None, "bad mode"
    levels = CODE_LEVELS[mb[3] * 2 + mb[4]]
    if levels not in LEVEL_CHOICES:
        return None, "bad mode"
    is_vertical = bool(mb[5])
    n = sum(bit << (10 - k) for k, bit in enumerate(mb[6:17]))
    if vertical is not None and is_vertical != vertical:
        return None, "wrong orientation"
    if n < RAMP_START + levels + N_END + 1:
        return None, "bad mode"
    if n * CELL > row.shape[1]:
        return None, "outside"
    cells = _centres(row, n)
    if fix is not None:
        cells = fix(cells)
    end = (2 * cells[n - N_END:] > thr2).astype(np.int32)
    if [tuple(r) for r in end.tolist()] != END:
        return None, "no end marker"
    ramp = cells[RAMP_START:RAMP_START + levels]
    if (np.diff(ramp, axis=0) <= 0).any():
        return None, "ramp merged"                      # two levels look the same: the screen shows the line too weakly
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
    top = level_values(levels)[-1]
    gain = float(ramp[-1].mean()) / top if top else 1.0
    return Frame3(seq, v1.parse_payload(payload), levels, n, gain, is_vertical), None


def _candidates(h_arr, max_candidates):
    """Positions (x, y) in a horizontal-form picture where a preamble starts (cheap checks only)."""
    h, w = h_arr.shape[:2]
    hh, ww = h - CELL + 1, w - RAMP_START * CELL + 1
    if hh <= 0 or ww <= 0:
        return []
    A = h_arr[MID:MID + hh, MID:MID + ww, :3].astype(np.int16)                 # cell 0 centres (white)
    Bv = h_arr[MID:MID + hh, MID + CELL:MID + CELL + ww, :3].astype(np.int16)  # cell 1 centres (black)
    ok = ((A - Bv) >= MIN_CONTRAST).all(axis=2)
    ys, xs = np.nonzero(ok)
    if len(ys) == 0:
        return []
    hi = A[ys, xs][:, ::-1]
    lo = Bv[ys, xs][:, ::-1]
    thr2 = hi + lo
    keep = np.ones(len(ys), dtype=bool)
    for i in range(2, N_PRE):
        px = h_arr[ys + MID, xs + MID + CELL * i, :3][:, ::-1].astype(np.int16)
        want = np.array(PREAMBLE[i], dtype=bool)
        keep &= ((2 * px > thr2) == want).all(axis=1)
        if not keep.any():
            return []
    return list(zip(xs[keep].tolist(), ys[keep].tolist()))[:max_candidates]


def find(arr, band=BAND, max_candidates=40):
    """Candidate lines near the four edges of a screenshot: [(x, y, vertical)] (top-left pixel of the first cell)."""
    h, w = arr.shape[:2]
    out = []
    b = min(band, h // 2)
    for y0 in (0, h - b):                                               # top and bottom bands: horizontal lines
        for x, y in _candidates(arr[y0:y0 + b], max_candidates):
            out.append((x, y0 + y, False))
    b = min(band, w // 2)
    for x0 in (0, w - b):                                               # left and right bands: vertical lines (turned)
        t = np.transpose(arr[:, x0:x0 + b], (1, 0, 2))
        for xt, yt in _candidates(t, max_candidates):
            out.append((x0 + yt, xt, True))                             # turned coordinates: (along, across) -> (x = across, y = along)
    return out


def _extent(arr, x, y, vertical):
    h, w = arr.shape[:2]
    return min(GRAB_MAX, (h - y) if vertical else (w - x))


def refine(arr, x, y, vertical, seq):
    """The exact origin: the middle of the offsets (+-2 px along the line and across it) that still decode to the same frame."""
    def ok(dx, dy):
        xx, yy = x + dx, y + dy
        if xx < 0 or yy < 0:
            return False
        f, _ = decode(oriented(arr, xx, yy, vertical, _extent(arr, xx, yy, vertical)), vertical)
        return f is not None and f.seq == seq

    def mid(offsets):
        return int(np.floor(np.mean(offsets) + 0.5)) if offsets else 0

    if vertical:                                       # the line runs along y, its thickness is across x
        along = mid([d for d in range(-2, 3) if ok(0, d)])
        across = mid([d for d in range(-2, 3) if ok(d, 0)])
    else:
        along = mid([d for d in range(-2, 3) if ok(d, 0)])
        across = mid([d for d in range(-2, 3) if ok(0, d)])
    return (x + across, y + along) if vertical else (x + along, y + across)


def find_and_decode(arr):
    """-> (x, y, vertical, extent, Frame3) of the first valid v3 line in the screenshot, or None."""
    for x, y, vertical in find(arr):
        frame, _ = decode(oriented(arr, x, y, vertical, _extent(arr, x, y, vertical)), vertical)
        if frame is not None:
            x, y = refine(arr, x, y, vertical, frame.seq)
            frame, _ = decode(oriented(arr, x, y, vertical, _extent(arr, x, y, vertical)), vertical)
            if frame is not None:
                return x, y, vertical, _extent(arr, x, y, vertical), frame
    return None


def find_in_band(band_arr, vertical):
    """Look for a line inside a band of the screen that was grabbed on its own: the top / bottom band (vertical=False, the whole
    width) or the left / right band (vertical=True, the whole height). -> (x, y, extent, Frame3) in the coordinates of
    `band_arr`, or None."""
    cands = _candidates(np.transpose(band_arr, (1, 0, 2)) if vertical else band_arr, 40)
    for a, c in cands:
        x, y = (c, a) if vertical else (a, c)                       # (along, across) of a turned band -> (x = across, y = along)
        ext = _extent(band_arr, x, y, vertical)
        frame, _ = decode(oriented(band_arr, x, y, vertical, ext), vertical)
        if frame is not None:
            x, y = refine(band_arr, x, y, vertical, frame.seq)
            ext = _extent(band_arr, x, y, vertical)
            frame, _ = decode(oriented(band_arr, x, y, vertical, ext), vertical)
            if frame is not None:
                return x, y, ext, frame
    return None
