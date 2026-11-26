// OCR assist: from a picture to chat lines. The pieces (finding the lines, grouping them into chat lines, reading with a model) are in the files of their own; this joins them.
// It needs no canvas and no network: how a picture is encoded and who reads it are given (the hub gives the real ones, the tests fake ones).
import { findLines, groupLines } from './ocr_lines.js';
import { sub } from './image.js';
import { regionFor } from './ocr.js';

const MIN_SEEN = 0.7;                // a cut line is read when at least this part of its height is seen

// pic: { px (BGRA), width, height }. opts: { read(image, geometry) -> text, encode(pic) -> { mime, base64 }, onlyNew: skip the chat lines before this index of the picture (no use yet), skipLeft, baseX,
//  keepCut: read also the chat lines that may be cut (a region the user picked: a list that fills the region; default false) }
// -> { lines: [text], skipped: { continued, cut, unreadable }, rows: n }  (lines from the top to the bottom)
export async function readPicture(pic, opts) {
  const { read, encode } = opts;
  const rows = findLines(pic.px, pic.width, pic.height, { skipLeft: opts.skipLeft || 0 });
  const msgs = groupLines(rows, { baseX: opts.baseX });
  const skipped = { continued: 0, cut: 0, unreadable: 0 };
  const heights = rows.map(l => l.core[1] - l.core[0] + 1).sort((a, b) => a - b), typical = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  // how much of its row is seen: a line at the edge of the picture that shows less than this is only the beginning (or the end) of its letters, and a model makes things up from it
  const seen = (l, cut) => (cut && typical ? (l.core[1] - l.core[0] + 1) / typical : 1);
  const lines = [];
  for (const m of msgs) {
    if (m.continued) { skipped.continued++; continue; }                          // its beginning is above the picture: read before, or not to be read
    if ((m.cutTop || m.cutBottom) && !opts.keepCut) { skipped.cut++; continue; } // cut by the edge of the picture: it would be half a line
    if ((seen(m.lines[0], m.cutTop) < MIN_SEEN) || (seen(m.lines[m.lines.length - 1], m.cutBottom) < MIN_SEEN)) { skipped.cut++; continue; }          // (also in a region the user picked: a sliver of a line is not read)
    const part = sub(pic, 0, m.top, pic.width, m.bottom - m.top + 1);
    const heights = m.lines.map(l => l.core[1] - l.core[0] + 1), lineH = Math.max(...heights);
    const text = await read(encode(part), { w: pic.width, rows: m.lines.length, lineH });
    if (text) lines.push(text); else skipped.unreadable++;
  }
  return { lines, skipped, rows: rows.length };
}

// the region the user picked (kept relative to the game window) for the game window as it is now -> [x, y, w, h] to read in the game window, or null
export function regionNow(region, game) {
  if (!region || !game) return null;
  const r = regionFor(region, game.width, game.height);
  if (!r) return null;
  const x = Math.min(r.x, game.width - 8), y = Math.min(r.y, game.height - 8);
  return [x, y, Math.min(r.w, game.width - x), Math.min(r.h, game.height - y)];
}
