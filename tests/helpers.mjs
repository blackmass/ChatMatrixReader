import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));

export function rng(seed) {                     // mulberry32: the same numbers on every run
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function loadFixtures() {
  const dir = path.join(HERE, 'fixtures');
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).map(f => ({
    ...f, img: { px: new Uint8Array(fs.readFileSync(path.join(dir, f.name + '.bin'))), width: f.width, height: f.height },
  }));
}

// a busy fake screen: noise plus flat blocks (they make edges everywhere)
export function busyScreen(w, h, seed) {
  const r = rng(seed);
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = (r() * 256) | 0;
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  for (let n = 0; n < 300; n++) {
    const x = (r() * (w - 80)) | 0, y = (r() * (h - 60)) | 0, bw = 8 + ((r() * 72) | 0), bh = 8 + ((r() * 52) | 0);
    const c = [(r() * 256) | 0, (r() * 256) | 0, (r() * 256) | 0];
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) { const i = (yy * w + xx) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; }
  }
  return { px, width: w, height: h };
}

export function flatScreen(w, h, bg = [20, 60, 30]) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]; px[i + 3] = 255; }
  return { px, width: w, height: h };
}

export function put(scr, img, x, y) {
  for (let r = 0; r < img.height; r++) scr.px.set(img.px.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((y + r) * scr.width + x) * 4);
  return scr;
}

let passed = 0, failed = 0;
export function check(cond, msg) { if (cond) passed++; else { failed++; console.log('  FAIL: ' + msg); } }
export function eq(a, b, msg) { check(JSON.stringify(a) === JSON.stringify(b), msg + '\n    got  ' + JSON.stringify(a) + '\n    want ' + JSON.stringify(b)); }
export const summary = () => ({ passed, failed });
export const lineTuple = l => [l.channel, l.id, l.sender, l.text, l.cls];

// the same JSON whatever the order of the keys
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// a minimal font file that has only a "name" table with the family (name id 1, Windows / UTF-16BE): enough for core/sfnt.js
export function sfntWith(family) {
  const text = Buffer.alloc(family.length * 2); for (let i = 0; i < family.length; i++) text.writeUInt16BE(family.charCodeAt(i), i * 2);
  const nameTable = Buffer.alloc(6 + 12 + text.length);
  nameTable.writeUInt16BE(0, 0); nameTable.writeUInt16BE(1, 2); nameTable.writeUInt16BE(18, 4);
  nameTable.writeUInt16BE(3, 6); nameTable.writeUInt16BE(1, 8); nameTable.writeUInt16BE(0x409, 10); nameTable.writeUInt16BE(1, 12); nameTable.writeUInt16BE(text.length, 14); nameTable.writeUInt16BE(0, 16);
  text.copy(nameTable, 18);
  const head = Buffer.alloc(12 + 16);
  head.writeUInt32BE(0x00010000, 0); head.writeUInt16BE(1, 4);
  head.write('name', 12, 'ascii'); head.writeUInt32BE(28, 20); head.writeUInt32BE(nameTable.length, 24);
  const all = Buffer.concat([head, nameTable]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}
