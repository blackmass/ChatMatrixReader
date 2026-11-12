"""Reading a v2 matrix whose cells are NOT 4x4 screen pixels (any real-number cell size) and whose colours may have been
mixed by a colour-space conversion (macOS: sRGB -> Display P3; undone in proto2.decode from the preamble).

Cells of any size occur when the screen is scaled: Windows display scaling with a wrong capture, macOS Retina modes
(the game draws 4 "physical" pixels, the capture has 4.5 of them), ... Everything here works on BGRA uint8 arrays.
v1 (exact colours) cannot be read this way; the addon must be set to 16/8/4/2 levels.
"""
import numpy as np

import proto2

# colour classes: 0 other, 1 white, 2 black, 3 red, 4 green, 5 blue, 6 yellow
PRE = [1, 2, 3, 4, 5, 6, 2, 1]                      # the v2 preamble: W K R G B Y K W
MAX_ROWS = 65                                       # the tallest matrix (2 levels, narrow shape) has 56 cell rows; 64 is the most the mode field can say


def classify(arr):
    """Rough colour class per pixel, tolerant of colour shifts."""
    b, g, r = (arr[:, :, i].astype(np.int16) for i in range(3))
    out = np.zeros(r.shape, np.uint8)
    out[(np.minimum(np.minimum(r, g), b) > 140)] = 1
    out[(np.maximum(np.maximum(r, g), b) < 80)] = 2
    out[(r > g + 70) & (r > b + 70)] = 3
    out[(g > r + 50) & (g > b + 60)] = 4
    out[(b > r + 70) & (b > g + 70)] = 5
    out[(r > b + 70) & (g > b + 70) & (np.abs(r - g) < 80)] = 6
    return out


def locate(arr, cls=None):
    """Find the preamble at ANY cell size. -> [(x0, y0, pitch)]: left/top edge of the matrix and the cell size (floats)."""
    if cls is None:
        cls = classify(arr)
    hits = []
    for y in range(0, cls.shape[0], 2):
        row = cls[y]
        change = np.flatnonzero(np.diff(row.astype(np.int16)) != 0) + 1
        starts = np.concatenate(([0], change))
        ends = np.concatenate((change, [len(row)]))
        vals, lens = row[starts], ends - starts
        keep = lens > 2                                         # 1-2 px runs are blurred cell edges, not cells
        starts, ends, vals, lens = starts[keep], ends[keep], vals[keep], lens[keep]
        for i in range(len(vals) - 7):
            if list(vals[i:i + 8]) != PRE:
                continue
            w = lens[i + 1:i + 7]
            if w.min() < 2 or w.max() - w.min() > max(3, int(0.35 * w.mean())):
                continue
            centre = lambda k: (starts[i + k] + ends[i + k]) / 2.0
            pitch = float((centre(6) - centre(1)) / 5.0)         # cell 1 (black) .. cell 6 (black)
            x0 = float(centre(1) - 1.5 * pitch)
            xr = int(centre(3))                                  # inside the red cell: walk up to the top of the matrix
            top = y
            while top > 0 and cls[top - 1, xr] == 3:
                top -= 1
            hits.append((x0, float(top), pitch))
    return hits


def sample(arr, x, y, pitch, rows, cols=proto2.COLS):
    """Cell centres of a matrix with cell size `pitch` -> a clean image with 4x4-pixel cells (what proto2 reads)."""
    ys = np.clip((y + (np.arange(rows) + 0.5) * pitch).astype(int), 0, arr.shape[0] - 1)
    xs = np.clip((x + (np.arange(cols) + 0.5) * pitch).astype(int), 0, arr.shape[1] - 1)
    cells = arr[np.ix_(ys, xs)]                                  # (rows, cols, 4)
    return np.repeat(np.repeat(cells, proto2.CELL, axis=0), proto2.CELL, axis=1)


def decode(arr, x, y, pitch, rows, cols=None):
    """-> (Frame2, None) or (None, reason). `rows` = number of cell rows to sample (at least the matrix height);
    cols = cells per row if known (32 or 16), else every shape is tried."""
    if cols:
        return proto2.decode(sample(arr, x, y, pitch, rows, cols), 0, 0, cols)
    why = "no preamble"
    for c in proto2.COL_CHOICES:
        frame, why = proto2.decode(sample(arr, x, y, pitch, rows, c), 0, 0, c)
        if frame is not None:
            return frame, None
    return None, why


def fit(arr, x, y, pitch):
    """The preamble gives position and cell size only to a fraction of a pixel, which adds up over 32 cells: try small
    variations until one decodes (the checksum is the judge). -> (Frame2, x, y, pitch) or (None, reason)."""
    rows = int(min(MAX_ROWS, (arr.shape[0] - y) // pitch))
    if rows < 7:
        return None, "outside"
    first, good, cols = None, [], None                           # cols: the shape, known after the first success
    step = pitch / 2.0
    for dp in np.linspace(-0.03, 0.03, 13):
        for dx in (-0.5, 0.0, 0.5):
            for dy in (-0.5, 0.0, 0.5):
                xx, yy, pp = x + dx * step, y + dy * step, pitch * (1 + dp)
                frame, reason = decode(arr, xx, yy, pp, rows, cols)
                if frame is not None:
                    cols = frame.cols
                    good.append((xx, yy, pp, frame))
                first = first or reason
    if not good:
        return None, first
    # sampling slightly off still decodes; take the middle of everything that does, so that small drift later is harmless
    mx, my, mp = (float(np.median([g[k] for g in good])) for k in range(3))
    frame, _ = decode(arr, mx, my, mp, rows, cols)
    if frame is not None:
        return frame, mx, my, mp
    return good[0][3], good[0][0], good[0][1], good[0][2]


def find(arr, max_tries=4):
    """-> (x, y, pitch, Frame2) of the first matrix that really decodes, or None."""
    cls = classify(arr)
    tried = []
    for x0, y0, pitch in locate(arr, cls):
        if any(abs(x0 - tx) < 3 and abs(y0 - ty) < 2 * pitch for tx, ty in tried):
            continue
        tried.append((x0, y0))
        res = fit(arr, x0, y0, pitch)
        if res[0] is not None:
            frame, x, y, p = res
            return x, y, p, frame
        if len(tried) >= max_tries:
            break
    return None
