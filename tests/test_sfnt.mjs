import { familyFromSfnt } from '../app/core/sfnt.js';
import { sfntWith } from './helpers.mjs';
import { check } from './helpers.mjs';
check(familyFromSfnt(sfntWith('Nanum Gothic')) === 'Nanum Gothic', 'family name of a font file');
check(familyFromSfnt(sfntWith('맑은 고딕')) === '맑은 고딕', 'a Korean family name (UTF-16)');
check(familyFromSfnt(new ArrayBuffer(4)) === null && familyFromSfnt(new TextEncoder().encode('not a font at all, just text').buffer) === null, 'garbage: null');
import { withoutTables } from '../app/core/sfnt.js';
{
  const f = sfntWith('Nano Test'), cut = withoutTables(f, ['kern']), none = withoutTables(f, ['name']);
  check(cut && familyFromSfnt(cut) === 'Nano Test', 'without a table that is not there: the family is still readable');
  check(none && new DataView(none).getUint16(4) === 0 && familyFromSfnt(none) === null, 'without the name table: no tables left');
  check(withoutTables(new ArrayBuffer(4), ['kern']) === null, 'garbage: null');
}
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
