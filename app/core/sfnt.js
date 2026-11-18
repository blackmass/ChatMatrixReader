// The family name written inside a TrueType / OpenType font file.

function utf16be(dv, start, len) { let s = ''; for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(dv.getUint16(start + i)); return s; }

// the family name of a TrueType / OpenType file (name id 16, else 1; English first); null when it cannot be read
export function familyFromSfnt(buf) {
  try {
    const dv = new DataView(buf);
    let base = 0;
    if (dv.getUint32(0) === 0x74746366) base = dv.getUint32(12);                  // 'ttcf': the first font of the collection
    const tables = dv.getUint16(base + 4);
    let name = 0;
    for (let i = 0; i < tables; i++) { const rec = base + 12 + i * 16; if (dv.getUint32(rec) === 0x6e616d65) { name = dv.getUint32(rec + 8); break; } }
    if (!name) return null;
    const count = dv.getUint16(name + 2), strings = name + dv.getUint16(name + 4);
    let best = null, bestScore = -1;
    for (let i = 0; i < count; i++) {
      const r = name + 6 + i * 12;
      const platform = dv.getUint16(r), lang = dv.getUint16(r + 4), id = dv.getUint16(r + 6), len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
      if (id !== 1 && id !== 16) continue;
      let text;
      if (platform === 3 || platform === 0) text = utf16be(dv, strings + off, len);
      else if (platform === 1) { text = ''; for (let k = 0; k < len; k++) text += String.fromCharCode(dv.getUint8(strings + off + k)); }
      else continue;
      text = text.trim();
      if (!text) continue;
      const score = (id === 16 ? 4 : 0) + (lang === 0x409 || (platform === 1 && lang === 0) ? 2 : 0) + (platform === 3 ? 1 : 0);
      if (score > bestScore) { best = text; bestScore = score; }
    }
    return best;
  } catch { return null; }
}


// ---- cleanFont: the same font, rebuilt so that the browser takes it
// The browser checks a font file much harder than the programs the old game fonts were made for, and refuses the WHOLE font for one odd table (a
// character map that points past the last glyph: the game's 2002.ttf; a kerning table that does not fit: the English client's ARIALN.TTF). The game
// does not care. So the font is put together again from the parts that matter: the shapes (glyf, loca), the sizes (head, hhea, hmtx, maxp), the names,
// OS/2, the hinting (cvt, fpgm, prep, gasp; left out on request), a character map WRITTEN NEW from what could be read of the old one (an entry that
// points nowhere is dropped) and a plain 'post' table. Everything else (kern, mort, GSUB, vhea, vmtx, hdmx, VDMX, PCLT, DSIG ...) is left out.
const u16 = (dv, o) => dv.getUint16(o), u32 = (dv, o) => dv.getUint32(o);
const tagAt = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

// { tag: { off, len } } of a plain (not collection) font, null otherwise
function directory(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 12 || u32(dv, 0) === 0x74746366) return null;
  const n = u16(dv, 4), t = {};
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16, off = u32(dv, rec + 8), len = u32(dv, rec + 12);
    if (off > buf.byteLength) continue;
    t[tagAt(dv, rec)] = { off, len: Math.min(len, buf.byteLength - off) };
  }
  return t;
}

// the character map as far as it can be read: Map(code -> glyph). Formats 4, 12, 6 and 0; an entry whose glyph is 0 or does not exist is left out.
export function readCmap(buf) {
  const out = new Map();
  try {
    const t = directory(buf), dv = new DataView(buf);
    if (!t || !t.cmap || !t.maxp) return out;
    const glyphs = u16(dv, t.maxp.off + 4), base = t.cmap.off, end = Math.min(buf.byteLength, base + t.cmap.len);
    const put = (code, g) => { if (g > 0 && g < glyphs && !out.has(code)) out.set(code, g); };
    const subs = [];
    for (let i = 0, n = u16(dv, base + 2); i < n; i++) { const r = base + 4 + i * 8; subs.push({ platform: u16(dv, r), enc: u16(dv, r + 2), off: base + u32(dv, r + 4) }); }
    // Unicode first (3/10 and 0/x, then 3/1), the rest is not a Unicode map
    const rank = s => (s.platform === 3 && s.enc === 10 ? 0 : s.platform === 0 ? 1 : s.platform === 3 && s.enc === 1 ? 2 : 9);
    for (const sub of subs.filter(x => rank(x) < 9).sort((x, y) => rank(x) - rank(y))) {
      const o = sub.off;
      if (o + 4 > end) continue;
      const fmt = u16(dv, o);
      if (fmt === 4) {
        const segs = u16(dv, o + 6) / 2, endsAt = o + 14, startsAt = endsAt + segs * 2 + 2, deltasAt = startsAt + segs * 2, rangesAt = deltasAt + segs * 2;
        if (rangesAt + segs * 2 > end) continue;
        for (let i = 0; i < segs; i++) {
          const e = u16(dv, endsAt + i * 2), st = u16(dv, startsAt + i * 2), delta = dv.getInt16(deltasAt + i * 2), ro = u16(dv, rangesAt + i * 2);
          if (st === 0xFFFF || e < st) continue;
          for (let c = st; c <= e; c++) {
            let g;
            if (ro === 0) g = (c + delta) & 0xFFFF;
            else {
              const at = rangesAt + i * 2 + ro + (c - st) * 2;
              if (at + 2 > end) continue;
              g = u16(dv, at); if (g !== 0) g = (g + delta) & 0xFFFF;
            }
            put(c, g);
          }
        }
      } else if (fmt === 12) {
        for (let i = 0, n = u32(dv, o + 12); i < n && o + 16 + i * 12 + 12 <= end; i++) {
          const g0 = o + 16 + i * 12, st = u32(dv, g0), e = u32(dv, g0 + 4), gl = u32(dv, g0 + 8);
          if (e < st || e - st > 0x10FFFF) continue;
          for (let c = st; c <= e; c++) put(c, gl + (c - st));
        }
      } else if (fmt === 6) {
        const first = u16(dv, o + 6), count = u16(dv, o + 8);
        for (let i = 0; i < count && o + 10 + i * 2 + 2 <= end; i++) put(first + i, u16(dv, o + 10 + i * 2));
      } else if (fmt === 0) {
        for (let c = 0; c < 256 && o + 6 + c < end; c++) put(c, dv.getUint8(o + 6 + c));
      }
    }
  } catch { /* what was read so far */ }
  return out;
}

// a character map (cmap table) for Map(code -> glyph): a format 4 subtable for the codes up to 0xFFFF (3/1), a format 12 one for all of them (3/10) when there are more
export function buildCmap(map) {                                               // (exported for the tests)
  const codes = [...map.keys()].sort((a, b) => a - b), bmp = codes.filter(c => c <= 0xFFFF);
  // runs of codes that follow each other; a run whose glyphs follow each other too is a "delta" segment, any other run reads its glyphs from an array
  const segs = [];
  for (let i = 0; i < bmp.length;) {
    let j = i; while (j + 1 < bmp.length && bmp[j + 1] === bmp[j] + 1) j++;
    let k = i;
    while (k <= j) {
      let m = k; while (m + 1 <= j && map.get(bmp[m + 1]) === map.get(bmp[m]) + 1) m++;
      segs.push({ start: bmp[k], end: bmp[m], gl: map.get(bmp[k]), len: m - k + 1, codes: bmp.slice(k, m + 1) });
      k = m + 1;
    }
    i = j + 1;
  }
  // many short delta segments in a row (glyphs not in order) are cheaper as one array segment: merge the neighbours that follow each other in code
  const merged = [];
  for (const sg of segs) {
    const prev = merged[merged.length - 1];
    if (prev && sg.len <= 3 && prev.end + 1 === sg.start && (prev.arr || prev.len <= 3)) {
      if (!prev.arr) { prev.arr = prev.codes.map(c => map.get(c)); }
      prev.arr.push(...sg.codes.map(c => map.get(c))); prev.end = sg.end; prev.len += sg.len; prev.codes = prev.codes.concat(sg.codes);
    } else merged.push({ ...sg });
  }
  const n = merged.length + 1;                                                 // (+ the closing 0xFFFF segment)
  const ends = [], starts = [], deltas = [], offs = [], array = [];
  merged.forEach((sg, i) => {
    starts.push(sg.start); ends.push(sg.end);
    if (sg.arr) { deltas.push(0); offs.push((n - i) * 2 + array.length * 2); array.push(...sg.arr); }
    else { deltas.push((sg.gl - sg.start) & 0xFFFF); offs.push(0); }
  });
  starts.push(0xFFFF); ends.push(0xFFFF); deltas.push(1); offs.push(0);
  const len4 = 16 + n * 8 + array.length * 2;
  const log = Math.floor(Math.log2(n));
  const out = [];
  const u16w = v => out.push((v >> 8) & 255, v & 255), u32w = v => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const nonBmp = codes.length > bmp.length;
  const subs = [];                                                             // [platform, encoding, bytes]
  if (len4 <= 0xFFFF) {
    const b = []; const w16 = v => b.push((v >> 8) & 255, v & 255);
    w16(4); w16(len4); w16(0); w16(n * 2); w16(2 * 2 ** log); w16(log); w16(n * 2 - 2 * 2 ** log);
    ends.forEach(w16); w16(0); starts.forEach(w16); deltas.forEach(w16); offs.forEach(w16); array.forEach(w16);
    subs.push([3, 1, b]);
  }
  if (nonBmp || !subs.length) {
    const groups = []; for (const c of codes) { const g = groups[groups.length - 1]; if (g && c === g.end + 1 && map.get(c) === g.gl + (c - g.start)) g.end = c; else groups.push({ start: c, end: c, gl: map.get(c) }); }
    const b = []; const w16 = v => b.push((v >> 8) & 255, v & 255), w32 = v => b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    w16(12); w16(0); w32(16 + groups.length * 12); w32(0); w32(groups.length);
    for (const g of groups) { w32(g.start); w32(g.end); w32(g.gl); }
    subs.push([3, 10, b]);
  }
  u16w(0); u16w(subs.length);
  let pos = 4 + subs.length * 8;
  for (const [pl, enc, b] of subs) { u16w(pl); u16w(enc); u32w(pos); pos += b.length; }
  for (const [, , b] of subs) out.push(...b);
  return Uint8Array.from(out);
}

// the font file made of these tables: [{ tag, data }], sorted, with the checksums
export function assemble(tables) {                                             // (exported for the tests)
  const list = tables.slice().sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const head = 12 + list.length * 16;
  let size = head; for (const t of list) size += (t.data.length + 3) & ~3;
  const out = new ArrayBuffer(size), dv = new DataView(out), bytes = new Uint8Array(out);
  const sumOf = (arr, from, to) => { let s = 0; for (let k = from; k < to; k += 4) { let w = 0; for (let b = 0; b < 4; b++) w = (w * 256 + (k + b < to ? arr[k + b] : 0)) >>> 0; s = (s + w) >>> 0; } return s; };
  dv.setUint32(0, 0x00010000); dv.setUint16(4, list.length);
  let p = 1; while (p * 2 <= list.length) p *= 2;
  dv.setUint16(6, p * 16); dv.setUint16(8, Math.log2(p)); dv.setUint16(10, list.length * 16 - p * 16);
  let pos = head, headAt = -1;
  list.forEach((t, i) => {
    bytes.set(t.data, pos);
    if (t.tag === 'head') { headAt = pos; dv.setUint32(pos + 8, 0); }              // (checkSumAdjustment is worked out last)
    const rec = 12 + i * 16;
    for (let b = 0; b < 4; b++) bytes[rec + b] = t.tag.charCodeAt(b);
    dv.setUint32(rec + 4, sumOf(bytes, pos, pos + t.data.length)); dv.setUint32(rec + 8, pos); dv.setUint32(rec + 12, t.data.length);
    pos += (t.data.length + 3) & ~3;
  });
  if (headAt >= 0) dv.setUint32(headAt + 8, (0xB1B0AFBA - sumOf(bytes, 0, size)) >>> 0);
  return out;
}

const NEEDED = ['glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'OS/2'];
const HINTING = ['cvt ', 'fpgm', 'prep', 'gasp'];

// -> a new ArrayBuffer, or null when the file is not a plain TrueType font (or a needed table is missing). hinting: false leaves the hinting tables out too.
export function cleanFont(buf, { hinting = true } = {}) {
  try {
    const t = directory(buf);
    if (!t || NEEDED.some(k => !t[k])) return null;
    const take = k => new Uint8Array(buf, t[k].off, t[k].len);
    const map = readCmap(buf);
    const tables = NEEDED.map(k => ({ tag: k, data: take(k) }));
    tables.push({ tag: 'cmap', data: map.size ? buildCmap(map) : (t.cmap ? take('cmap') : new Uint8Array(0)) });
    const post = new Uint8Array(32); if (t.post && t.post.len >= 32) post.set(take('post').subarray(0, 32)); new DataView(post.buffer).setUint32(0, 0x00030000);     // format 3: no glyph names
    tables.push({ tag: 'post', data: post });
    if (hinting) for (const k of HINTING) if (t[k]) tables.push({ tag: k, data: take(k) });
    return assemble(tables);
  } catch { return null; }
}

// Old fonts (the game's own 2002.ttf is one) often have a broken 'loca' table: the closing entry is 0 instead of the end of 'glyf', or an entry goes
// backwards. Programs that read glyph by glyph do not mind, the browser refuses the whole font. Here every entry is brought into line
// (never lower than the one before, never past the end of 'glyf'). Returns a repaired copy, or null when nothing had to be changed.
export function repairedLoca(buf) {
  try {
    const dv = new DataView(buf), n = dv.getUint16(4), t = {};
    if (dv.getUint32(0) === 0x74746366) return null;
    for (let i = 0; i < n; i++) { const rec = 12 + i * 16; t[String.fromCharCode(...new Uint8Array(buf, rec, 4))] = { off: dv.getUint32(rec + 8), len: dv.getUint32(rec + 12) }; }
    if (!t.loca || !t.glyf || !t.head || !t.maxp) return null;
    const long = dv.getInt16(t.head.off + 50) === 1, size = long ? 4 : 2, count = dv.getUint16(t.maxp.off + 4) + 1;
    if (t.loca.len < count * size || t.loca.off + count * size > buf.byteLength) return null;
    const out = buf.slice(0), od = new DataView(out), at = i => t.loca.off + i * size;
    const get = i => (long ? od.getUint32(at(i)) : od.getUint16(at(i)) * 2), put = (i, v) => (long ? od.setUint32(at(i), v) : od.setUint16(at(i), v / 2));
    let changed = false, prev = 0;
    for (let i = 0; i < count; i++) {
      let v = get(i);
      const last = i === count - 1;
      if (v < prev || v > t.glyf.len || (last && v < t.glyf.len && v === 0)) { v = last ? Math.max(prev, t.glyf.len) : Math.min(prev, t.glyf.len); put(i, v); changed = true; }
      prev = v;
    }
    return changed ? out : null;
  } catch { return null; }
}
