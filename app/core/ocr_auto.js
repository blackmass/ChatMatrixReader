// OCR assist: reading the chat by itself while the addon says it is restricted (or all the time, to try it). The pieces that need no screen and no model are here:
// which chat lines of a picture are new (the lines that were there in the last picture are not read again: the chat scrolls up by whole lines), which lines
// are already in the chat (they came from the addon: not shown twice), and when the reading is on.
import { EDGE } from './ocr_lines.js';
import { stripStamp } from './ocr.js';

const MIN_EDGE = 18;            // the weakest change that counts as the edge of a letter
const GX = 96, GY = 3;          // the picture of a line is cut in this many cells across and down
const SAME = 0.05;              // two chat lines are the same when the strokes of their letters are laid out the same way (distance below this)

// the look of a chat line of the picture, to know it again in the next picture: how many edges of letters there are in each cell of a grid over its rows (the rows with letters in
// them: top..bottom of the core, the same wherever the line is). The colours and the scene behind do not count (a see-through chat over a moving scene is still the same line).
export function signatureOf(pic, top, bottom) {
  const { px, width: w } = pic, sig = new Float64Array(GX * GY), h = Math.max(1, bottom - top + 1);
  // how strong the edges are is the line's own: a line that is fading (the game makes the old lines dim) has weaker edges, and it must still look like the same line. The bar is a part
  // of the strong edges of the line itself.
  const hist = new Int32Array(256); let total = 0;
  for (let y = top; y <= bottom; y++) {
    let p = y * w * 4;
    for (let x = 1; x < w; x++, p += 4) { hist[Math.max(Math.abs(px[p + 4] - px[p]), Math.abs(px[p + 5] - px[p + 1]), Math.abs(px[p + 6] - px[p + 2]))]++; total++; }
  }
  let acc = 0, strong = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { strong = v; break; } }        // (the top 2 percent of the changes)
  const bar = Math.max(MIN_EDGE, Math.round(strong * 0.4));
  for (let y = top; y <= bottom; y++) {
    const gy = Math.min(GY - 1, Math.floor((y - top) * GY / h));
    let p = y * w * 4;
    for (let x = 1; x < w; x++, p += 4) {
      if (Math.max(Math.abs(px[p + 4] - px[p]), Math.abs(px[p + 5] - px[p + 1]), Math.abs(px[p + 6] - px[p + 2])) >= bar) sig[gy * GX + Math.min(GX - 1, Math.floor(x * GX / w))]++;
    }
  }
  return sig;
}
export function distance(a, b) {
  let d = 0, s = 0;
  for (let i = 0; i < a.length; i++) { d += Math.abs(a[i] - b[i]); s += a[i] + b[i]; }
  return d / (s + 1);
}
export const same = (a, b) => distance(a, b) < SAME;

// the chat lines of the last picture (prev) and of this one (cur), as signatures from the top to the bottom -> how many lines at the top of `cur` were in `prev` already
// (the longest end of `prev` that is the beginning of `cur`). The lines after them are new: cur.slice(result).
export function alignedCount(prev, cur) {
  for (let k = Math.min(prev.length, cur.length); k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k && ok; i++) ok = same(prev[prev.length - k + i], cur[i]);
    if (ok) return k;
  }
  return 0;
}

// Is this picture one to trust, and which of its lines are new? New lines come in at the bottom, so what counts is the newest lines of the last picture: the lowest line of this
// picture that is one of the newest lines of the last one (the newest, else the one before it, else the one before that) is the place; the lines below it are new. What is above does
// not matter: the old lines at the top fade away or go up by themselves (the game does that), and that changes nothing. A picture is not trusted when
//  - no line of it is a newest line of the last picture and it has more lines than could have come (the chat is covered, or it looks quite different), or
//  - more new lines than could have come are below the place (something covers the lowest lines: they are not new lines but the old ones changed).
// `budget`: how many new lines could have come (the lines the chat has had since the last trusted picture). Nothing is trusted when the chat had lines and now has none.
// -> { ok, first (the index of the first new line), n (how many are new) }
export const ANCHORS = 3;
export function judge(prev, cur, budget) {
  if (!cur.length && prev.length) return { ok: false, first: 0, n: 0 };                 // (no line at all: the chat faded away, or something covers it all)
  for (let a = 0; a < Math.min(ANCHORS, prev.length); a++) {
    const want = prev[prev.length - 1 - a];
    for (let i = cur.length - 1; i >= 0; i--) {
      if (same(want, cur[i])) { const n = cur.length - 1 - i; return { ok: n <= budget, first: i + 1, n }; }
    }
  }
  return { ok: cur.length <= budget, first: 0, n: cur.length };
}

// the first picture of a reading has nothing to be compared with, so it is trusted when the next one is the same (a tooltip that comes and goes is not): `seen` is the picture before
export const steady = (seen, cur) => !!seen && seen.length === cur.length && alignedCount(seen, cur) === cur.length;

// what is said, with nothing that differs between how the addon and the picture have it: no time, no front in brackets, only letters and digits, small
export function normalize(text) {
  let t = stripStamp(text);
  t = t.replace(/^\s*(?:\[[^\[\]\n]{1,60}\]\s*)+(?::\s*)?/u, '');
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// the lines that are in the chat already (what the addon gave): a line read from the picture that is one of them is not shown again
// how alike two texts are, 0..1: the letter pairs they share (a few letters read wrong in an otherwise same line still count as the same line)
export function alike(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = t => { const m = new Map(); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const pa = pairs(a), pb = pairs(b); let shared = 0;
  for (const [k, n] of pa) shared += Math.min(n, pb.get(k) || 0);
  return 2 * shared / (a.length + b.length - 2);
}
const SAME_TEXT = 0.88;

// The lines the addon gave a moment ago, so that the same line read from the picture is not shown twice. A line the addon gave is waiting for its twin on the screen for a short
// time (TTL seconds) and is used up by the first line read that is the same: what is on the screen is the addon's line again only once. What was read from the screen is never kept
// for this (a boss that says the same thing again, a message that is sent twice: both are shown), and a line that nothing waits for is always shown.
export const TTL = 20;          // seconds
export class Recent {
  constructor(max = 120) { this.max = max; this.list = []; }
  add(text, now) { const n = normalize(text); if (n.length >= 2) { this.list.push({ n, t: now, used: false }); if (this.list.length > this.max) this.list.shift(); } }
  // true when a line of the addon that is not used up yet is this line (equal, or the end of a line that is cut by the edge of the picture, or nearly the same text: a few letters read wrong);
  // that line of the addon is then used up
  take(text, now) {
    const n = normalize(text);
    if (n.length < 2) return true;                                   // (nothing to show)
    const hit = this.list.find(e => !e.used && now - e.t <= TTL && this.same(e.n, n));
    if (hit) hit.used = true;
    return !!hit;
  }
  same(r, n) {
    if (r === n) return true;
    const [lo, hi] = r.length < n.length ? [r, n] : [n, r];
    if (lo.length >= 10 && lo.length >= hi.length * 0.8 && hi.includes(lo)) return true;
    return lo.length >= 12 && lo.length >= hi.length * 0.8 && alike(r, n) >= SAME_TEXT;           // (read a little differently: "lfg" and "Ifg")
  }
}

// when the reading is on: after the chat was restricted, for HOLD seconds from the last restricted line, a few seconds after the end line
export const HOLD = 30;         // seconds
export const AFTER_END = 4;     // seconds: the end line of the addon is only a hint, one last look at the screen
export const RESETTLE = 8;      // looks in a row that are not trusted but are all the same: it is not a passing thing but how the chat looks now (bigger window...): the picture to compare with is made again
export class Watch {
  constructor() { this.until = 0; this.pending = 0; this.arrived = 0; }
  line() { this.arrived = Math.min(60, this.arrived + 1); }                 // a chat line came (any: the ones the addon gave and the restricted ones)
  trusted() { this.arrived = 0; }                                            // the picture was trusted: the count starts again
  restricted(now) { this.until = now + HOLD; this.pending = Math.min(8, this.pending + 1); }
  keep(now) { this.until = Math.max(this.until, now + HOLD); }                // the watching goes on (a numbered line of the addon): no line is expected for the older way
  ended(now) { this.until = Math.min(this.until, now + AFTER_END); }
  on(now) { return now < this.until; }
  // a reading session is over: forget what the last picture was
  idle(now) { const off = !this.on(now); if (off) this.pending = 0; return off; }
}
