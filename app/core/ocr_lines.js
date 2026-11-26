// OCR assist: finding the lines of text in a picture of the chat by the picture alone (no model, no letters read). The rows that hold text have many sharp
// changes of brightness from one pixel to the next (the edges of the letters); the rows between two chat lines have few. A group of such rows is a line.
// Input: the pixels as RGBA bytes (width w, height h). Output: the lines from the top to the bottom, each { top, bottom, core: [top, bottom], cutTop, cutBottom } (rows, bottom included; left: where its letters begin;
// cutTop / cutBottom: the line touches the edge of the picture, so it may be cut and is better not read).
export const EDGE = 40;               // a change of brightness this big between two neighbours is the edge of a letter
const MIN_ROW_FRACTION = 0.012; // a row is "text" when this part of its width (at least 3 pixels) is edge
const VALLEY = 0.25;           // a row is a gap when it has less than this part of the edges of a busy row
const EDGE_NEAR = 0.6;         // a first / last line whose middle is nearer to the edge than this many pitches is cut
const MIN_HEIGHT = 5;          // rows: a group shorter than this is a speck, not a line
const JOIN_GAP = 2;            // rows: groups closer than this are one line (the outline, the parts of a letter, the dots of a Korean letter)

export function lumaOf(rgba, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  return out;
}

// where the letters of a line begin (the first column with the strokes of a letter in it; skip: the columns to leave out, e.g. the buttons at the left of the chat)
function leftOf(rgba, w, top, bottom, skip) {
  const need = Math.max(2, Math.round((bottom - top + 1) * 0.15)), count = new Int32Array(w);
  for (let x = Math.max(1, skip); x < w; x++) {
    let n = 0;
    for (let y = top; y <= bottom; y++) {
      const p = (y * w + x) * 4;
      if (Math.max(Math.abs(rgba[p + 4] - rgba[p]), Math.abs(rgba[p + 5] - rgba[p + 1]), Math.abs(rgba[p + 6] - rgba[p + 2])) >= EDGE) n++;
    }
    count[x] = n;
  }
  for (let x = Math.max(1, skip); x < w - 8; x++) {                                    // (a letter, not a speck: strokes in 3 of the next 8 columns)
    if (count[x] < need) continue;
    let more = 0; for (let k = 1; k <= 8; k++) if (count[x + k] >= need) more++;
    if (more >= 2) return x + 1;                                                     // (the change is between x and x + 1: the letter begins at x + 1)
  }
  return -1;
}

const INDENT = 0.45;           // a row that begins further right than the first letters of the others by this part of its height (at least 7 pixels) is a rest: half of the indent of the game, so the first letter of a line (a "k" begins a few pixels right of a "C") does not count

// The lines of the picture -> the chat lines. A chat line that is too long for the window goes on in the next row, and the game (also what other addons print) always indents that row; so
// a row whose letters do not begin where the others begin is the rest of the chat line above it. -> [{ top, bottom, coreTop, coreBottom (the rows with letters in them: the same wherever the line is), lines: [rows], cutTop, cutBottom, continued }]
// `continued`: the first row of the picture is a rest: its beginning is above the picture (read already, or not to be read). opts.baseX: where the beginning of a chat line is (from
// earlier pictures: when every row of this picture is a rest, the others cannot tell); opts.indent: the part of the height.
export function groupLines(lines, opts = {}) {
  if (!lines.length) return [];
  const lefts = lines.map(l => l.left).filter(x => x >= 0);
  const base = opts.baseX ?? (lefts.length ? Math.min(...lefts) : 0);
  const heights = lines.map(l => l.core[1] - l.core[0] + 1).sort((a, b) => a - b), median = heights[Math.floor(heights.length / 2)];
  const tol = Math.max(7, Math.round(median * (opts.indent ?? INDENT)));
  const msgs = [];
  for (const l of lines) {
    const rest = l.left >= 0 && l.left > base + tol;
    const last = msgs[msgs.length - 1];
    if (rest && last) { last.lines.push(l); last.bottom = l.bottom; last.coreBottom = l.core[1]; last.cutBottom = l.cutBottom; }
    else msgs.push({ top: l.top, bottom: l.bottom, coreTop: l.core[0], coreBottom: l.core[1], lines: [l], cutTop: l.cutTop, cutBottom: l.cutBottom, continued: rest });
  }
  return msgs;
}

// how many edge pixels each row has: the colour changes by EDGE or more (in the strongest of red, green, blue) from one pixel to the next. The colour, not only the
// brightness: dark green or dark red letters on a dark scene hardly change the brightness
export function edgeRows(rgba, w, h) {
  const rows = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0, p = y * w * 4;
    for (let x = 1; x < w; x++, p += 4) {
      const d = Math.max(Math.abs(rgba[p + 4] - rgba[p]), Math.abs(rgba[p + 5] - rgba[p + 1]), Math.abs(rgba[p + 6] - rgba[p + 2]));
      if (d >= EDGE) n++;
    }
    rows[y] = n;
  }
  return rows;
}

export function findLines(rgba, w, h, opts = {}) {
  const rows = edgeRows(rgba, w, h);
  // the bar between "text" and "gap" follows the picture: a part of the busiest rows (a line over a bright scene has edges everywhere, but fewer between the lines)
  const sorted = [...rows].sort((a, b) => a - b), peak = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const need = Math.max(3, Math.round(w * (opts.minRow ?? MIN_ROW_FRACTION)), Math.round(peak * (opts.valley ?? VALLEY)));
  const minH = opts.minHeight ?? MIN_HEIGHT, gap = opts.joinGap ?? JOIN_GAP;
  const runs = [];
  for (let y = 0; y < h; y++) {
    if (rows[y] < need) continue;
    const last = runs[runs.length - 1];
    if (last && y - last.bottom <= gap) last.bottom = y; else runs.push({ top: y, bottom: y });
  }
  const cores = runs.filter(r => r.bottom - r.top + 1 >= minH);
  if (!cores.length) return [];
  // the line is wider than its core: out to the middle of the gap to the next one (the top of a tall letter, the tail of a "g" and the outline are in it)
  const mid = (a, b) => Math.floor((a.bottom + b.top) / 2);
  const out = cores.map((c, i) => ({
    top: i === 0 ? Math.max(0, c.top - 3) : mid(cores[i - 1], c) + 1,
    bottom: i === cores.length - 1 ? Math.min(h - 1, c.bottom + 3) : mid(c, cores[i + 1]),
    core: [c.top, c.bottom],
  }));
  // a line at the edge of the picture may be cut: it touches the edge, or it is too near to it for a whole line (the lines have one pitch)
  const centers = cores.map(c => (c.top + c.bottom) / 2);
  const pitches = centers.slice(1).map((c, i) => c - centers[i]).sort((a, b) => a - b);
  const pitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0;
  const near = pitch * (opts.edgeNear ?? EDGE_NEAR);
  for (const [i, l] of out.entries()) {
    l.cutTop = i === 0 && (l.core[0] <= 0 || centers[i] < near);
    l.cutBottom = i === out.length - 1 && (l.core[1] >= h - 1 || h - 1 - centers[i] < near);
  }
  for (const l of out) l.left = leftOf(rgba, w, l.core[0], l.core[1], opts.skipLeft ?? 0);
  return out;
}
