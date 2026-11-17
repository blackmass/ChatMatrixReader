// ChatMatrix protocol v2 (colour-change tolerant), decoder and locator. Port of proto2.py (the reference encoder stays in Python;
// tests/fixtures hold pictures it drew).
import { checksum, parsePayload } from './decoder.js';
import { sub } from './image.js';

export const CELL = 4;
export const COLS = 32;
export const COL_CHOICES = [32, 16];
export const MIN_WIDTH = 16 * CELL;
export const PREAMBLE = [[1, 1, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 0, 0], [1, 1, 1]];
export const END = [[0, 0, 0], [1, 1, 1], [0, 0, 0], [1, 1, 1]];
export const N_PRE = 8, N_MODE = 4, RAMP_START = 12, N_END = 4;
export const LEVEL_MAX = 180;
export const CODE_LEVELS = { 0: 2, 1: 4, 2: 8, 3: 16 };
export const HEADER_BYTES = 9;
export const MIN_CONTRAST = 40;

export const bitsPerSymbol = levels => Math.floor(Math.log2(levels));
export const levelValues = levels => Array.from({ length: levels }, (_, i) => Math.round(i * LEVEL_MAX / (levels - 1)));

// ---- colour-space repair (macOS: sRGB -> Display P3 mixes the channels; measured from the preamble and undone)
const toLin1 = v => { v = Math.min(1, Math.max(0, v)); return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const fromLin1 = v => { v = Math.min(1, Math.max(0, v)); return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };

function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}

// 2-norm condition number of a 3x3 matrix (sqrt of the eigenvalue ratio of M^T M, Jacobi iteration)
function cond3(m) {
  const s = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) s[i][j] += m[k][i] * m[k][j];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      off += s[p][q] * s[p][q];
      if (Math.abs(s[p][q]) < 1e-18) continue;
      const th = (s[q][q] - s[p][p]) / (2 * s[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < 3; k++) { const a = s[k][p], b = s[k][q]; s[k][p] = c * a - sn * b; s[k][q] = sn * a + c * b; }
      for (let k = 0; k < 3; k++) { const a = s[p][k], b = s[q][k]; s[p][k] = c * a - sn * b; s[q][k] = sn * a + c * b; }
    }
    if (off < 1e-24) break;
  }
  const ev = [s[0][0], s[1][1], s[2][2]];
  const lo = Math.min(...ev);
  return lo <= 0 ? Infinity : Math.sqrt(Math.max(...ev) / lo);
}

// -> function(cells: [[r,g,b]...]) -> fixed cells, or null when nothing needs undoing
export function gamutFix(first) {
  const hi = first[0], lo = first[1];
  const span = [0, 1, 2].map(c => hi[c] - lo[c]);
  if (span.some(v => v < MIN_CONTRAST)) return null;
  const P = [2, 3, 4].map(r => [0, 1, 2].map(c => (first[r][c] - lo[c]) / span[c]));
  let off = 0, dmin = Infinity;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    if (r === c) dmin = Math.min(dmin, P[r][c]); else off = Math.max(off, P[r][c]);
  }
  if (off < 0.06 || dmin < 0.5) return null;
  const M = [0, 1, 2].map(r => [0, 1, 2].map(c => toLin1(P[c][r])));         // M = toLin(P).T
  if (cond3(M) > 50) return null;
  const inv = inv3(M);
  if (!inv) return null;
  return cells => cells.map(cell => {
    const lin = [0, 1, 2].map(c => toLin1((cell[c] - lo[c]) / span[c]));
    return [0, 1, 2].map(r => fromLin1(inv[r][0] * lin[0] + inv[r][1] * lin[1] + inv[r][2] * lin[2]) * span[r] + lo[r]);
  });
}

// ---- decoding
function centres(img, nRows, cols) {
  const out = [];
  for (let r = 0; r < nRows; r++) for (let c = 0; c < cols; c++) {
    const i = ((r * CELL + 2) * img.width + c * CELL + 2) * 4;
    out.push([img.px[i + 2], img.px[i + 1], img.px[i]]);
  }
  return out;
}

const bitsOf = (cell, thr2) => cell.map((v, c) => (2 * v > thr2[c] ? 1 : 0));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// the symbols of the data cells -> bytes (shared by v2 and v3)
export function symbolsToBytes(data, ramp, levels) {
  const mids = [0, 1, 2].map(c => ramp.slice(0, -1).map((v, i) => (v[c] + ramp[i + 1][c]) / 2));
  const b = bitsPerSymbol(levels);
  const bits = [];
  for (const cell of data) for (let c = 0; c < 3; c++) {
    let sym = 0;
    for (const m of mids[c]) if (m < cell[c]) sym++;                  // numpy searchsorted(side=left)
    for (let k = b - 1; k >= 0; k--) bits.push((sym >> k) & 1);
  }
  const bytes = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < bytes.length; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k];
    bytes[i] = v;
  }
  return bytes;
}

export function parseFrameBytes(raw) {
  const seq = (raw[0] << 16) | (raw[1] << 8) | raw[2];
  const length = (raw[3] << 8) | raw[4];
  if (length > raw.length - HEADER_BYTES) return { why: 'bad length' };
  const payload = raw.subarray(HEADER_BYTES, HEADER_BYTES + length);
  if (checksum(payload) !== ((raw[6] << 16) | (raw[7] << 8) | raw[8])) return { why: 'checksum mismatch' };
  return { seq, lines: parsePayload(payload) };
}

const rampMerged = ramp => { for (let i = 1; i < ramp.length; i++) for (let c = 0; c < 3; c++) if (ramp[i][c] - ramp[i - 1][c] <= 0) return true; return false; };

// -> { frame, why }; cols = cells per row if known, else every shape is tried
export function decode(img, x, y, cols = null) {
  if (cols) return decodeCols(img, x, y, cols);
  let why = 'no preamble';
  for (const c of COL_CHOICES) {
    const r = decodeCols(img, x, y, c);
    if (r.frame) return r;
    why = r.why;
  }
  return { frame: null, why };
}

function decodeCols(img, x, y, cols) {
  const { width: w, height: h } = img;
  const width = cols * CELL;
  if (x < 0 || y < 0 || x + width > w || y + CELL > h) return { frame: null, why: 'outside' };
  let first = centres(sub(img, x, y, width, CELL), 1, cols);
  const hi = first[0], lo = first[1];
  if (Math.min(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < MIN_CONTRAST) return { frame: null, why: 'no preamble' };
  const thr2 = [0, 1, 2].map(c => hi[c] + lo[c]);
  const fix = gamutFix(first);
  if (fix) first = fix(first);
  const bits = first.slice(0, RAMP_START).map(c => bitsOf(c, thr2));
  if (!PREAMBLE.every((p, i) => same(bits[i], p))) return { frame: null, why: 'no preamble' };
  const mb = bits.slice(N_PRE, RAMP_START).flat();
  if (!same(mb.slice(0, 3), [0, 1, 0]) || (mb.slice(0, 11).reduce((a, b) => a + b, 0) & 1) !== mb[11]) return { frame: null, why: 'bad mode' };
  const levels = CODE_LEVELS[mb[3] * 2 + mb[4]];
  let rows = 1;
  for (let k = 0; k < 6; k++) rows += mb[5 + k] << (5 - k);
  if (y + rows * CELL > h) return { frame: null, why: 'outside' };
  let cells = centres(sub(img, x, y, width, rows * CELL), rows, cols);
  if (fix) cells = fix(cells);
  const n = rows * cols;
  const end = cells.slice(n - N_END).map(c => bitsOf(c, thr2));
  if (!END.every((p, i) => same(end[i], p))) return { frame: null, why: 'no end marker' };
  const ramp = cells.slice(RAMP_START, RAMP_START + levels);
  if (rampMerged(ramp)) return { frame: null, why: 'ramp merged' };
  const data = cells.slice(RAMP_START + levels, n - N_END);
  const r = parseFrameBytes(symbolsToBytes(data, ramp, levels));
  if (r.why) return { frame: null, why: r.why };
  const top = levelValues(levels).at(-1);
  const gain = top ? (ramp.at(-1).reduce((a, b) => a + b, 0) / 3) / top : 1;
  return { frame: { seq: r.seq, lines: r.lines, levels, rows, gain, cols }, why: null };
}

// candidate top-left positions (cheap checks only; decode() decides)
export function find(img, maxCandidates = 60) {
  const { width: w, height: h, px } = img;
  const out = [];
  const hh = h - CELL + 1, ww = w - MIN_WIDTH + 1;
  if (hh <= 0 || ww <= 0) return out;
  for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) {
    const a = ((y + 2) * w + x + 2) * 4, b = a + 4 * CELL;
    if (px[a] - px[b] < MIN_CONTRAST || px[a + 1] - px[b + 1] < MIN_CONTRAST || px[a + 2] - px[b + 2] < MIN_CONTRAST) continue;
    const t2 = [px[a + 2] + px[b + 2], px[a + 1] + px[b + 1], px[a] + px[b]];     // R, G, B
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

export function refine(img, x, y, seq, cols = null) {
  const xs = [], ys = [];
  for (let d = -3; d <= 3; d++) {
    let f = decode(img, x + d, y, cols).frame;
    if (f && f.seq === seq) xs.push(d);
    f = decode(img, x, y + d, cols).frame;
    if (f && f.seq === seq) ys.push(d);
  }
  if (!xs.length || !ys.length) return [x, y];
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  return [x + Math.floor(mean(xs) + 0.5), y + Math.floor(mean(ys) + 0.5)];
}

// -> {x, y, frame} or null
export function findAndDecode(img) {
  for (let [x, y] of find(img)) {
    let { frame } = decode(img, x, y);
    if (!frame) continue;
    [x, y] = refine(img, x, y, frame.seq, frame.cols);
    ({ frame } = decode(img, x, y, frame.cols));
    if (frame) return { x, y, frame };
  }
  return null;
}
