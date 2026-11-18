r"""Makes tests/fixtures/broken_font.ttf: a tiny font of our own (3 glyphs) with the two faults that old game fonts have and that the browser refuses:
    * a character map (cmap) whose glyph array points past the last glyph (the game's 2002.ttf)
    * a kerning table (kern) with a subtable that does not fit (the English client's ARIALN.TTF)
tests use it to prove the browser refuses the file as it is and takes the cleaned copy (app/core/sfnt.js cleanFont). Needs `pip install fonttools`.

    py tools\make_broken_font.py
"""
import os
import struct
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures", "broken_font.ttf")
SAVE = OUT + ".good"


def box(w, h):
    pen = TTGlyphPen(None)
    pen.moveTo((50, 0)); pen.lineTo((50, h)); pen.lineTo((w - 50, h)); pen.lineTo((w - 50, 0)); pen.closePath()
    return pen.glyph()


fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder([".notdef", "A", "ga"])
fb.setupCharacterMap({0x41: "A", 0xAC00: "ga"})
fb.setupGlyf({".notdef": box(500, 700), "A": box(600, 700), "ga": box(900, 800)})
fb.setupHorizontalMetrics({".notdef": (500, 50), "A": (600, 50), "ga": (900, 50)})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({"familyName": "Cmr Broken Test", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.save(SAVE)

# the same file with the two faults put in by hand (the tables are cut out and put back in raw)
raw = open(SAVE, "rb").read()
n = struct.unpack(">H", raw[4:6])[0]
tables = {}
for i in range(n):
    tag, _, off, ln = struct.unpack(">4sIII", raw[12 + i * 16:28 + i * 16])
    tables[tag.decode()] = raw[off:off + ln]
os.remove(SAVE)

# cmap: format 4, one segment 0x41..0x42 through the glyph array (entries: glyph 1, then 65535 = past the last glyph), one segment for 0xAC00 (glyph 2), the end mark
seg = 3
glyph_array = struct.pack(">HH", 1, 65535)
end_codes, start_codes = [0x42, 0xAC00, 0xFFFF], [0x41, 0xAC00, 0xFFFF]
deltas = [0, (2 - 0xAC00) & 0xFFFF, 1]
# idRangeOffset of segment 0: from its own place to the glyph array: (3 segments - 0) * 2 bytes = 6, segment 1 and 2: 0
range_offsets = [seg * 2, 0, 0]
body = struct.pack(">HHHH", seg * 2, 4, 1, 2)                       # segCountX2, searchRange, entrySelector, rangeShift
body += struct.pack(">3H", *end_codes) + struct.pack(">H", 0) + struct.pack(">3H", *start_codes) + struct.pack(">3H", *deltas) + struct.pack(">3H", *range_offsets) + glyph_array
sub = struct.pack(">HHH", 4, 6 + len(body), 0) + body
tables["cmap"] = struct.pack(">HH", 0, 1) + struct.pack(">HHI", 3, 1, 12) + sub

# kern: version 0, one subtable that says it is longer than the table
tables["kern"] = struct.pack(">HH", 0, 1) + struct.pack(">HHH", 0, 0xFFF0, 1) + struct.pack(">HHHH", 1, 8, 0, 0)

names = sorted(tables)
header = struct.pack(">IHHHH", 0x00010000, len(names), 16 * 8, 3, len(names) * 16 - 16 * 8 if len(names) * 16 > 128 else 0)
off = 12 + 16 * len(names)
recs, blobs = b"", b""
for t in names:
    data = tables[t]
    pad = (4 - len(data) % 4) % 4
    recs += struct.pack(">4sIII", t.encode(), 0, off, len(data))       # (the checksums are not looked at by the browser)
    blobs += data + b"\0" * pad
    off += len(data) + pad
open(OUT, "wb").write(header + recs + blobs)
print(OUT, os.path.getsize(OUT), "bytes;", ", ".join(names))
