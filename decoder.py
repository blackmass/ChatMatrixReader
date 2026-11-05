"""Decoder for the ChatMatrix pixel protocol (see PROTOCOL.md).

Pure functions on numpy arrays, no GUI / capture dependencies, so it can be tested alone.
Arrays are BGRA uint8 with shape (height, width, 4), as returned by mss.
"""
from dataclasses import dataclass
import numpy as np

CELL = 4
COLS, ROWS = 32, 4
NUM_CELLS = COLS * ROWS
HEADER_CELLS = 4
PAYLOAD_CELLS = NUM_CELLS - HEADER_CELLS - 1
MAX_PAYLOAD = PAYLOAD_CELLS * 3
WIDTH, HEIGHT = COLS * CELL, ROWS * CELL      # 128 x 16
VERSION = 1
MARKER = (0x43, 0x4D, VERSION)                 # RGB of cell 0
END_MARKER = (0x4D, 0x58, 0x45)                # RGB of cell 127
FS = "\x1f"


@dataclass
class Line:
    channel: str
    id: int
    sender: str
    text: str


@dataclass
class Frame:
    seq: int
    lines: list


def checksum(data: bytes) -> int:
    s1 = s2 = 0
    for b in data:
        s1 = (s1 + b) % 4095
        s2 = (s2 + s1) % 4095
    return s2 * 4096 + s1


def parse_payload(payload: bytes) -> list:
    text = payload.decode("utf-8", errors="replace")
    lines = []
    if not text:
        return lines
    for raw in text.split("\n"):
        parts = raw.split(FS, 3)
        if len(parts) < 4:
            continue            # truncated / damaged line
        ch, id_str, sender, msg = parts
        try:
            line_id = int(id_str)
        except ValueError:
            continue
        lines.append(Line(ch, line_id, sender, msg))
    return lines


def cells_to_bytes(region: np.ndarray) -> bytes:
    """Sample the center of every 4x4 cell and return the 384 RGB bytes."""
    cy = np.arange(ROWS) * CELL + CELL // 2
    cx = np.arange(COLS) * CELL + CELL // 2
    grid = region[np.ix_(cy, cx)]               # (ROWS, COLS, 4) BGRA
    rgb = grid[:, :, [2, 1, 0]]                  # -> RGB
    return rgb.reshape(-1).astype(np.uint8).tobytes()


def decode_region(region: np.ndarray):
    """Decode a 16x128 BGRA region. Returns (Frame, None) or (None, reason)."""
    if region is None or region.shape[0] < HEIGHT or region.shape[1] < WIDTH:
        return None, "region too small"
    flat = cells_to_bytes(region[:HEIGHT, :WIDTH])
    if tuple(flat[0:3]) != MARKER:
        return None, "no marker"
    if tuple(flat[381:384]) != END_MARKER:
        return None, "no end marker"
    seq = int.from_bytes(flat[3:6], "big")
    length = int.from_bytes(flat[6:8], "big")
    if length > MAX_PAYLOAD:
        return None, "bad length"
    chk = int.from_bytes(flat[9:12], "big")
    payload = flat[12:12 + length]
    if checksum(payload) != chk:
        return None, "checksum mismatch"
    return Frame(seq, parse_payload(payload)), None


def find_matrix(arr: np.ndarray, max_candidates: int = 4000):
    """Search a screenshot for the matrix. Returns (x, y) of its top-left pixel or None."""
    h, w = arr.shape[:2]
    mask = (arr[:, :, 2] == MARKER[0]) & (arr[:, :, 1] == MARKER[1]) & (arr[:, :, 0] == MARKER[2])
    ys, xs = np.nonzero(mask)
    for n, (y, x) in enumerate(zip(ys.tolist(), xs.tolist())):
        if n >= max_candidates:
            break
        if y + HEIGHT > h or x + WIDTH > w:
            continue
        frame, _ = decode_region(arr[y:y + HEIGHT, x:x + WIDTH])
        if frame is not None:
            return x, y
    return None
