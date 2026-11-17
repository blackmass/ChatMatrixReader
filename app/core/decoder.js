// Decoder for the ChatMatrix pixel protocol v1 (docs/PROTOCOL.md). Port of decoder.py.
import { sub } from './image.js';

export const CELL = 4;
export const COLS = 32, ROWS = 4;
export const NUM_CELLS = COLS * ROWS;
export const COL_CHOICES = [32, 16];
export const PAYLOAD_CELLS = NUM_CELLS - 4 - 1;
export const MAX_PAYLOAD = PAYLOAD_CELLS * 3;
export const MARKER = [0x43, 0x4D, 1];
export const END_MARKER = [0x4D, 0x58, 0x45];
export const FS = '\x1f';

export function checksum(data) {
  let s1 = 0, s2 = 0;
  for (const b of data) { s1 = (s1 + b) % 4095; s2 = (s2 + s1) % 4095; }
  return s2 * 4096 + s1;
}

// Python's str.split(sep, maxsplit): the rest stays in the last piece
export function splitMax(s, sep, max) {
  const out = [];
  let from = 0;
  while (out.length < max) {
    const i = s.indexOf(sep, from);
    if (i < 0) break;
    out.push(s.slice(from, i));
    from = i + sep.length;
  }
  out.push(s.slice(from));
  return out;
}

const utf8 = new TextDecoder('utf-8');

// -> [{channel, id, sender, text, cls, base}]
export function parsePayload(payload) {
  const text = utf8.decode(payload);
  const lines = [];
  if (!text) return lines;
  for (const raw of text.split('\n')) {
    const parts = splitMax(raw, FS, 5);
    if (parts.length < 4) continue;
    const cls = parts.length >= 5 ? ([...parts[4]][0] || '') : '';
    const base = parts.length === 6 && parts[5] ? parts[5].codePointAt(0) - 48 : -1;
    if (!/^\s*[+-]?\d+\s*$/.test(parts[1])) continue;
    lines.push({ channel: parts[0], id: parseInt(parts[1], 10), sender: parts[2], text: parts[3], cls, base });
  }
  return lines;
}

export function sizeFor(cols) { return [cols * CELL, NUM_CELLS / cols * CELL]; }

function cellsToBytes(img, cols) {
  const out = new Uint8Array(NUM_CELLS * 3);
  const rows = NUM_CELLS / cols;
  let k = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = ((r * CELL + 2) * img.width + c * CELL + 2) * 4;
    out[k++] = img.px[i + 2]; out[k++] = img.px[i + 1]; out[k++] = img.px[i];
  }
  return out;
}

// -> { frame, why }
export function decodeRegion(img, cols = COLS) {
  const [w, h] = sizeFor(cols);
  if (!img || img.height < h || img.width < w) return { frame: null, why: 'region too small' };
  const flat = cellsToBytes(sub(img, 0, 0, w, h), cols);
  if (flat[0] !== MARKER[0] || flat[1] !== MARKER[1] || flat[2] !== MARKER[2]) return { frame: null, why: 'no marker' };
  if (flat[381] !== END_MARKER[0] || flat[382] !== END_MARKER[1] || flat[383] !== END_MARKER[2]) return { frame: null, why: 'no end marker' };
  const seq = (flat[3] << 16) | (flat[4] << 8) | flat[5];
  const length = (flat[6] << 8) | flat[7];
  if (length > MAX_PAYLOAD) return { frame: null, why: 'bad length' };
  const chk = (flat[9] << 16) | (flat[10] << 8) | flat[11];
  const payload = flat.subarray(12, 12 + length);
  if (checksum(payload) !== chk) return { frame: null, why: 'checksum mismatch' };
  return { frame: { seq, lines: parsePayload(payload) }, why: null };
}

// -> {x, y, cols} or null
export function findMatrixEx(img, maxCandidates = 4000) {
  const { width: w, height: h, px } = img;
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (px[i + 2] !== MARKER[0] || px[i + 1] !== MARKER[1] || px[i] !== MARKER[2]) continue;
    if (n++ >= maxCandidates) return null;
    for (const cols of COL_CHOICES) {
      const [cw, ch] = sizeFor(cols);
      if (y + ch > h || x + cw > w) continue;
      const { frame } = decodeRegion(sub(img, x, y, cw, ch), cols);
      if (frame) return { x, y, cols };
    }
  }
  return null;
}
