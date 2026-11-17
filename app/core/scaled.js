// Reading a v2 matrix whose cells are NOT 4x4 screen pixels (any real-number cell size) and whose colours may have been mixed by a
// colour-space conversion (undone in proto2.decode from the preamble). Port of scaled.py; replaces the prototype's app/locate.js.
// Cells of any size occur when the screen is scaled (Windows display scaling with a wrong capture, macOS Retina modes ...).
import * as proto2 from './proto2.js';

const PRE = [1, 2, 3, 4, 5, 6, 2, 1];                  // colour classes of the v2 preamble: W K R G B Y K W
export const MAX_ROWS = 65;                            // the tallest matrix (2 levels, narrow) has 56 cell rows; 64 is the most the mode field can say

// colour classes: 0 other, 1 white, 2 black, 3 red, 4 green, 5 blue, 6 yellow
export function colourClass(b, g, r) {
  let c = 0;
  if (Math.min(r, g, b) > 140) c = 1;
  if (Math.max(r, g, b) < 80) c = 2;
  if (r > g + 70 && r > b + 70) c = 3;
  if (g > r + 50 && g > b + 60) c = 4;
  if (b > r + 70 && b > g + 70) c = 5;
  if (r > b + 70 && g > b + 70 && Math.abs(r - g) < 80) c = 6;
  return c;
}

export function classify(img) {
  const { px, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = colourClass(px[i], px[i + 1], px[i + 2]);
  return out;
}

// the preamble at ANY cell size -> [{x, y, pitch}]: left/top edge of each candidate and its cell size (floats)
export function locate(img, cls = null) {
  const { width, height } = img;
  cls = cls || classify(img);
  const hits = [];
  const starts = [], ends = [], vals = [];
  for (let y = 0; y < height; y += 2) {
    starts.length = ends.length = vals.length = 0;
    const base = y * width;
    let runStart = 0, cur = cls[base];
    for (let x = 1; x <= width; x++) {
      const c = x < width ? cls[base + x] : -1;
      if (c !== cur) {
        if (x - runStart > 2) { starts.push(runStart); ends.push(x); vals.push(cur); }   // 1-2 px runs are blurred cell edges, not cells
        runStart = x; cur = c;
      }
    }
    for (let k = 0; k + 8 <= vals.length; k++) {
      let match = true;
      for (let j = 0; j < 8; j++) if (vals[k + j] !== PRE[j]) { match = false; break; }
      if (!match) continue;
      let min = 1e9, max = 0, sum = 0;
      for (let j = 1; j <= 6; j++) { const w = ends[k + j] - starts[k + j]; min = Math.min(min, w); max = Math.max(max, w); sum += w; }
      if (min < 2 || max - min > Math.max(3, Math.trunc(0.35 * sum / 6))) continue;
      const centre = j => (starts[k + j] + ends[k + j]) / 2;
      const pitch = (centre(6) - centre(1)) / 5;           // cell 1 (black) .. cell 6 (black)
      const x0 = centre(1) - 1.5 * pitch;
      const xr = Math.trunc(centre(2));                     // inside the red cell: walk up to the top of the matrix (never further than 3 cells)
      let top = y;
      while (top > 0 && y - top < 3 * pitch && cls[(top - 1) * width + xr] === 3) top--;
      hits.push({ x: x0, y: top, pitch });
    }
  }
  return hits;
}

// the cell centres of a matrix with cell size `pitch` -> a clean picture with 4x4-pixel cells (what proto2 reads)
export function sample(img, x, y, pitch, rows, cols = proto2.COLS) {
  const C = proto2.CELL;
  const out = new Uint8Array(cols * C * rows * C * 4);
  const W = cols * C;
  const xs = Array.from({ length: cols }, (_, c) => Math.min(img.width - 1, Math.max(0, Math.trunc(x + (c + 0.5) * pitch))));
  for (let r = 0; r < rows; r++) {
    const sy = Math.min(img.height - 1, Math.max(0, Math.trunc(y + (r + 0.5) * pitch)));
    for (let c = 0; c < cols; c++) {
      const s = (sy * img.width + xs[c]) * 4;
      for (let dy = 0; dy < C; dy++) for (let dx = 0; dx < C; dx++) {
        const d = ((r * C + dy) * W + c * C + dx) * 4;
        out[d] = img.px[s]; out[d + 1] = img.px[s + 1]; out[d + 2] = img.px[s + 2]; out[d + 3] = img.px[s + 3];
      }
    }
  }
  return { px: out, width: W, height: rows * C };
}

// -> { frame, why }; cols = cells per row if known (32 or 16), else every shape is tried
export function decode(img, x, y, pitch, rows, cols = null) {
  if (cols) return proto2.decode(sample(img, x, y, pitch, rows, cols), 0, 0, cols);
  let why = 'no preamble';
  for (const c of proto2.COL_CHOICES) {
    const r = proto2.decode(sample(img, x, y, pitch, rows, c), 0, 0, c);
    if (r.frame) return r;
    why = r.why;
  }
  return { frame: null, why };
}

const median = a => { const s = [...a].sort((p, q) => p - q), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

// The preamble gives position and cell size only to a fraction of a pixel, which adds up over 32 cells: try small variations until one
// decodes (the checksum is the judge). -> { frame, x, y, pitch } or { frame: null, why }
export function fit(img, x, y, pitch) {
  const rows = Math.trunc(Math.min(MAX_ROWS, (img.height - y) / pitch));
  if (rows < 7) return { frame: null, why: 'outside' };
  let first = null, cols = null;
  const good = [];
  const step = pitch / 2;
  for (let i = 0; i < 13; i++) {
    const dp = -0.03 + 0.06 * i / 12;
    for (const dx of [-0.5, 0, 0.5]) for (const dy of [-0.5, 0, 0.5]) {
      const xx = x + dx * step, yy = y + dy * step, pp = pitch * (1 + dp);
      const r = decode(img, xx, yy, pp, rows, cols);
      if (r.frame) { cols = r.frame.cols; good.push([xx, yy, pp, r.frame]); }
      first = first || r.why;
    }
  }
  if (!good.length) return { frame: null, why: first };
  // sampling slightly off still decodes; take the middle of everything that does, so that small drift later is harmless
  const mx = median(good.map(g => g[0])), my = median(good.map(g => g[1])), mp = median(good.map(g => g[2]));
  const r = decode(img, mx, my, mp, rows, cols);
  if (r.frame) return { frame: r.frame, x: mx, y: my, pitch: mp };
  return { frame: good[0][3], x: good[0][0], y: good[0][1], pitch: good[0][2] };
}

// -> { x, y, pitch, frame } of the first matrix that really decodes, or null
export function find(img, maxTries = 4) {
  const cls = classify(img);
  const tried = [];
  for (const h of locate(img, cls)) {
    if (tried.some(t => Math.abs(h.x - t[0]) < 3 && Math.abs(h.y - t[1]) < 2 * h.pitch)) continue;
    tried.push([h.x, h.y]);
    const r = fit(img, h.x, h.y, h.pitch);
    if (r.frame) return { x: r.x, y: r.y, pitch: r.pitch, frame: r.frame };
    if (tried.length >= maxTries) break;
  }
  return null;
}
