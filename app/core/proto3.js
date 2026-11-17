// ChatMatrix protocol v3 (the "stealth line": one row of dark cells along a screen edge). Decoder and locator, port of proto3.py.
import { PREAMBLE, END, N_PRE, CODE_LEVELS, HEADER_BYTES, MIN_CONTRAST, gamutFix, symbolsToBytes, parseFrameBytes } from './proto2.js';
import { sub, transpose } from './image.js';

export const CELL = 4;
export const N_MODE = 6, RAMP_START = 14, N_END = 4;
export const LEVEL_MAX = 96;
export const LEVEL_CHOICES = [4, 8];
export const BAND = 48;
export const GRAB_MAX = 2048;
const MID = CELL / 2;

export const levelValues = levels => Array.from({ length: levels }, (_, i) => Math.round(i * LEVEL_MAX / (levels - 1)));

// the line whose first cell starts at (x, y), as a horizontal picture (CELL rows); vertical lines are turned
export function oriented(img, x, y, vertical, length) {
  if (vertical) return transpose(sub(img, x, y, CELL, length));
  return sub(img, x, y, length, CELL);
}

function centres(row, n) {
  const out = [];
  for (let c = 0; c < n; c++) {
    const i = (MID * row.width + MID + c * CELL) * 4;
    out.push([row.px[i + 2], row.px[i + 1], row.px[i]]);
  }
  return out;
}

const bitsOf = (cell, thr2) => cell.map((v, c) => (2 * v > thr2[c] ? 1 : 0));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// row: horizontal picture whose first cell is at column 0. vertical: orientation the caller found it in (null = do not check)
export function decode(row, vertical = null) {
  if (row.height < CELL || row.width < RAMP_START * CELL) return { frame: null, why: 'outside' };
  let first = centres(row, RAMP_START);
  const hi = first[0], lo = first[1];
  if (Math.min(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < MIN_CONTRAST) return { frame: null, why: 'no preamble' };
  const thr2 = [0, 1, 2].map(c => hi[c] + lo[c]);
  const fix = gamutFix(first);
  if (fix) first = fix(first);
  const bits = first.map(c => bitsOf(c, thr2));
  if (!PREAMBLE.every((p, i) => same(bits[i], p))) return { frame: null, why: 'no preamble' };
  const mb = bits.slice(N_PRE, RAMP_START).flat();
  if (!same(mb.slice(0, 3), [0, 1, 1]) || (mb.slice(0, 17).reduce((a, b) => a + b, 0) & 1) !== mb[17]) return { frame: null, why: 'bad mode' };
  const levels = CODE_LEVELS[mb[3] * 2 + mb[4]];
  if (!LEVEL_CHOICES.includes(levels)) return { frame: null, why: 'bad mode' };
  const isVertical = !!mb[5];
  let n = 0;
  for (let k = 0; k < 11; k++) n += mb[6 + k] << (10 - k);
  if (vertical !== null && isVertical !== vertical) return { frame: null, why: 'wrong orientation' };
  if (n < RAMP_START + levels + N_END + 1) return { frame: null, why: 'bad mode' };
  if (n * CELL > row.width) return { frame: null, why: 'outside' };
  let cells = centres(row, n);
  if (fix) cells = fix(cells);
  const end = cells.slice(n - N_END).map(c => bitsOf(c, thr2));
  if (!END.every((p, i) => same(end[i], p))) return { frame: null, why: 'no end marker' };
  const ramp = cells.slice(RAMP_START, RAMP_START + levels);
  for (let i = 1; i < ramp.length; i++) for (let c = 0; c < 3; c++) if (ramp[i][c] - ramp[i - 1][c] <= 0) return { frame: null, why: 'ramp merged' };
  const data = cells.slice(RAMP_START + levels, n - N_END);
  const r = parseFrameBytes(symbolsToBytes(data, ramp, levels));
  if (r.why) return { frame: null, why: r.why };
  const top = levelValues(levels).at(-1);
  const gain = top ? (ramp.at(-1).reduce((a, b) => a + b, 0) / 3) / top : 1;
  return { frame: { seq: r.seq, lines: r.lines, levels, cells: n, gain, vertical: isVertical }, why: null };
}

// positions in a horizontal-form picture where a preamble starts (cheap checks only) -> [[x, y]]
export function candidates(img, maxCandidates = 40) {
  const { width: w, height: h, px } = img;
  const out = [];
  const hh = h - CELL + 1, ww = w - RAMP_START * CELL + 1;
  if (hh <= 0 || ww <= 0) return out;
  for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) {
    const a = ((y + MID) * w + x + MID) * 4, b = a + 4 * CELL;
    if (px[a] - px[b] < MIN_CONTRAST || px[a + 1] - px[b + 1] < MIN_CONTRAST || px[a + 2] - px[b + 2] < MIN_CONTRAST) continue;
    const t2 = [px[a + 2] + px[b + 2], px[a + 1] + px[b + 1], px[a] + px[b]];
    let ok = true;
    for (let i = 2; i < N_PRE && ok; i++) {
      const p = a + 4 * CELL * i;
      const v = [px[p + 2], px[p + 1], px[p]];
      for (let c = 0; c < 3; c++) if ((2 * v[c] > t2[c] ? 1 : 0) !== PREAMBLE[i][c]) { ok = false; break; }
    }
    if (ok) { out.push([x, y]); if (out.length >= maxCandidates) return out; }
  }
  return out;
}

// candidate lines near the four edges: [[x, y, vertical]]
export function find(img, band = BAND, maxCandidates = 40) {
  const { width: w, height: h } = img;
  const out = [];
  let b = Math.min(band, h >> 1);
  for (const y0 of [0, h - b]) for (const [x, y] of candidates(sub(img, 0, y0, w, b), maxCandidates)) out.push([x, y0 + y, false]);
  b = Math.min(band, w >> 1);
  for (const x0 of [0, w - b]) for (const [xt, yt] of candidates(transpose(sub(img, x0, 0, b, h)), maxCandidates)) out.push([x0 + yt, xt, true]);
  return out;
}

export const extent = (img, x, y, vertical) => Math.min(GRAB_MAX, vertical ? img.height - y : img.width - x);

export function refine(img, x, y, vertical, seq) {
  const ok = (dx, dy) => {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0) return false;
    const { frame } = decode(oriented(img, xx, yy, vertical, extent(img, xx, yy, vertical)), vertical);
    return !!frame && frame.seq === seq;
  };
  const mid = offs => offs.length ? Math.floor(offs.reduce((s, v) => s + v, 0) / offs.length + 0.5) : 0;
  const range = [-2, -1, 0, 1, 2];
  let along, across;
  if (vertical) { along = mid(range.filter(d => ok(0, d))); across = mid(range.filter(d => ok(d, 0))); }
  else { along = mid(range.filter(d => ok(d, 0))); across = mid(range.filter(d => ok(0, d))); }
  return vertical ? [x + across, y + along] : [x + along, y + across];
}

// -> {x, y, vertical, extent, frame} or null
export function findAndDecode(img) {
  for (let [x, y, vertical] of find(img)) {
    let { frame } = decode(oriented(img, x, y, vertical, extent(img, x, y, vertical)), vertical);
    if (!frame) continue;
    [x, y] = refine(img, x, y, vertical, frame.seq);
    ({ frame } = decode(oriented(img, x, y, vertical, extent(img, x, y, vertical)), vertical));
    if (frame) return { x, y, vertical, extent: extent(img, x, y, vertical), frame };
  }
  return null;
}

// a band grabbed on its own (top/bottom: the whole width, left/right: the whole height). -> {x, y, extent, frame} in band coordinates
export function findInBand(band, vertical) {
  for (const [a, c] of candidates(vertical ? transpose(band) : band, 40)) {
    let [x, y] = vertical ? [c, a] : [a, c];
    let ext = extent(band, x, y, vertical);
    let { frame } = decode(oriented(band, x, y, vertical, ext), vertical);
    if (!frame) continue;
    [x, y] = refine(band, x, y, vertical, frame.seq);
    ext = extent(band, x, y, vertical);
    ({ frame } = decode(oriented(band, x, y, vertical, ext), vertical));
    if (frame) return { x, y, extent: ext, frame };
  }
  return null;
}
