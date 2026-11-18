import { familyFromSfnt } from '../app/core/sfnt.js';
import { sfntWith } from './helpers.mjs';
import { check } from './helpers.mjs';
check(familyFromSfnt(sfntWith('Nanum Gothic')) === 'Nanum Gothic', 'family name of a font file');
check(familyFromSfnt(sfntWith('맑은 고딕')) === '맑은 고딕', 'a Korean family name (UTF-16)');
check(familyFromSfnt(new ArrayBuffer(4)) === null && familyFromSfnt(new TextEncoder().encode('not a font at all, just text').buffer) === null, 'garbage: null');
import { repairedLoca } from '../app/core/sfnt.js';
{ // a tiny font: head (loca format 1), maxp (2 glyphs), glyf (16 bytes), loca with a closing 0
  const tabs = { glyf: 16, head: 54, loca: 12, maxp: 6 }, names = Object.keys(tabs).sort();
  let off = 12 + names.length * 16; const pos = {}; for (const k of names) { pos[k] = off; off += (tabs[k] + 3) & ~3; }
  const b = new ArrayBuffer(off), dv = new DataView(b); dv.setUint32(0, 0x10000); dv.setUint16(4, names.length);
  names.forEach((k, i) => { for (let j = 0; j < 4; j++) dv.setUint8(12 + i * 16 + j, k.charCodeAt(j)); dv.setUint32(12 + i * 16 + 8, pos[k]); dv.setUint32(12 + i * 16 + 12, tabs[k]); });
  dv.setInt16(pos.head + 50, 1); dv.setUint16(pos.maxp + 4, 2);
  dv.setUint32(pos.loca, 0); dv.setUint32(pos.loca + 4, 8); dv.setUint32(pos.loca + 8, 0);
  const fixed = repairedLoca(b);
  check(fixed && new DataView(fixed).getUint32(pos.loca + 8) === 16 && new DataView(fixed).getUint32(pos.loca + 4) === 8, 'loca: the closing 0 becomes the end of glyf');
  check(new DataView(b).getUint32(pos.loca + 8) === 0, 'loca: the original is not touched');
  check(repairedLoca(fixed) === null, 'loca: a good table needs nothing');
}

// cleanFont: the font put together again from the parts that matter (the browser refuses old game fonts whole for one odd table)
import fs from 'node:fs';
import { cleanFont, readCmap, buildCmap, assemble } from '../app/core/sfnt.js';
{
  // our own tiny font with the two faults of the game's fonts: a character map whose glyph array points past the last glyph (the 2002.ttf), and a kern table that does not fit
  const raw = fs.readFileSync(new URL('./fixtures/broken_font.ttf', import.meta.url)); const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length);
  const tagsOf = b => { const dv = new DataView(b); return Array.from({ length: dv.getUint16(4) }, (_, i) => String.fromCharCode(...new Uint8Array(b, 12 + i * 16, 4))).sort(); };
  check(tagsOf(buf).includes('kern'), 'the test font has the kern table');
  const map = readCmap(buf);
  check(map.size === 2 && map.get(0x41) === 1 && map.get(0xAC00) === 2 && !map.has(0x42), 'readCmap: what can be read is read, the entry that points past the last glyph is dropped');
  const out = cleanFont(buf);
  check(out && tagsOf(out).join(' ') === 'OS/2 cmap glyf head hhea hmtx loca maxp name post', 'cleanFont: only the parts that matter: ' + (out && tagsOf(out).join(' ')));
  check(familyFromSfnt(out) === 'Cmr Broken Test', 'cleanFont: the name is kept');
  const back = readCmap(out);
  check(back.size === 2 && back.get(0x41) === 1 && back.get(0xAC00) === 2, 'cleanFont: the new character map says the same');
  check(cleanFont(buf, { hinting: false }) && cleanFont(new ArrayBuffer(8)) === null && cleanFont(new TextEncoder().encode('not a font at all, just some text').buffer) === null, 'cleanFont: garbage is null');
}
{
  // a big map of every kind (runs of codes with glyphs in order, runs in any order, single codes, codes above 0xFFFF): written and read back it is the same
  let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const map = new Map(); let g = 1;
  for (let c = 0xAC00; c < 0xAC00 + 5000; c++) map.set(c, g++);                              // in order (Hangul)
  for (let c = 0x20; c < 0x7F; c++) map.set(c, 3000 + rnd(2000));                             // any order (Latin)
  for (let k = 0; k < 400; k++) map.set(0x3000 + rnd(0x800), 1 + rnd(9000));                  // single codes here and there
  map.set(0x1F600, 77); map.set(0x1F601, 78);                                                  // above the BMP
  const maxp = new Uint8Array(32); new DataView(maxp.buffer).setUint16(4, 10000);
  const f = assemble([{ tag: 'cmap', data: buildCmap(map) }, { tag: 'maxp', data: maxp }]);
  const back = readCmap(f);
  let bad = 0; for (const [c, gl] of map) if (back.get(c) !== gl) bad++;
  check(bad === 0 && back.size === map.size, `buildCmap / readCmap: ${map.size} codes written and read back, ${bad} differ`);
}
