"""Self-test for decoder.py. Builds a fake screen the same way the Lua addon would draw it."""
import numpy as np
import decoder as d

FS = "\x1f"


def encode(lines, seq, budget=255):
    """Python re-implementation of the addon's Render() (newest lines that fit the budget)."""
    picked, total = [], 0
    for line in reversed(lines):
        n = len(line.encode("utf-8")) + (1 if picked else 0)
        if total + n > budget:
            break
        picked.insert(0, line)
        total += n
    payload = "\n".join(picked).encode("utf-8")
    cells = [(0x43, 0x4D, 1),
             tuple(seq.to_bytes(3, "big")),
             (len(payload) >> 8 & 255, len(payload) & 255, len(picked)),
             tuple(d.checksum(payload).to_bytes(3, "big"))]
    padded = payload + bytes(d.PAYLOAD_CELLS * 3 - len(payload))
    for i in range(d.PAYLOAD_CELLS):
        cells.append(tuple(padded[i * 3:i * 3 + 3]))
    cells.append(d.END_MARKER)
    assert len(cells) == d.NUM_CELLS
    return cells


def draw(cells):
    img = np.zeros((d.HEIGHT, d.WIDTH, 4), dtype=np.uint8)
    for i, (r, g, b) in enumerate(cells):
        x, y = (i % d.COLS) * d.CELL, (i // d.COLS) * d.CELL
        img[y:y + d.CELL, x:x + d.CELL] = (b, g, r, 255)       # BGRA
    return img


def mk(ch, i, who, text):
    return f"{ch}{FS}{i}{FS}{who}{FS}{text}"


lines = [mk("P", 1, "Alpha", "LFM mythic+ need healer, inv pls"),
         mk("G", 2, "Bravo", "anyone want to run dungeons?"),
         mk("S", 3, "Charlie", "Hello world! 한글 테스트 (UTF-8)"),
         mk("C1", 4, "Delta", "WTS [Some Item] 10k, whisper me")]

# 1. plain decode
frame, why = d.decode_region(draw(encode(lines, 12345)))
assert frame is not None, why
assert frame.seq == 12345
assert [(l.channel, l.id, l.sender) for l in frame.lines] == [("P", 1, "Alpha"), ("G", 2, "Bravo"),
                                                              ("S", 3, "Charlie"), ("C1", 4, "Delta")]
assert frame.lines[2].text == "Hello world! 한글 테스트 (UTF-8)"
print("1 ok: decode, UTF-8, seq")

# 2. budget: only the newest lines that fit are present, in order
many = [mk("S", i, "Spammer", "x" * 60) for i in range(1, 11)]
frame, why = d.decode_region(draw(encode(many, 1)))
ids = [l.id for l in frame.lines]
assert ids == sorted(ids) and ids[-1] == 10 and len(ids) < 10, ids
print("2 ok: budget keeps newest lines", ids)

# 3. torn / damaged frame is rejected
cells = encode(lines, 7)
cells[10] = (cells[10][0] ^ 0x20, cells[10][1], cells[10][2])
frame, why = d.decode_region(draw(cells))
assert frame is None and why == "checksum mismatch", why
print("3 ok: damaged frame rejected:", why)

# 4. find the matrix inside a noisy 'screen' (also with fake marker-colored distractors)
rng = np.random.default_rng(0)
screen = rng.integers(0, 255, size=(1080, 1920, 4), dtype=np.uint8)
screen[..., 3] = 255
screen[100:104, 200:204] = (1, 0x4D, 0x43, 255)                  # looks like a marker, but no matrix
screen[700:716, 500:628] = draw(encode(lines, 999))             # the real matrix
pos = d.find_matrix(screen)
assert pos == (500, 700), pos
frame, _ = d.decode_region(screen[pos[1]:pos[1] + 16, pos[0]:pos[0] + 128])
assert frame.seq == 999
print("4 ok: found matrix at", pos)

# 5. matrix at the very bottom-left corner of the screen
screen = np.zeros((1080, 1920, 4), dtype=np.uint8)
screen[1080 - 16 - 2:1080 - 2, 2:130] = draw(encode(lines, 5))
assert d.find_matrix(screen) == (2, 1080 - 18)
print("5 ok: corner position")

# 6. nothing on screen
assert d.find_matrix(np.zeros((300, 300, 4), dtype=np.uint8)) is None
print("6 ok: empty screen -> None")

# 7. empty payload (no chat yet)
frame, why = d.decode_region(draw(encode([], 1)))
assert frame is not None and frame.lines == []
print("7 ok: empty history")

print("ALL TESTS PASSED")
