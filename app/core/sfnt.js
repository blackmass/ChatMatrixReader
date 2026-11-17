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


// The same font without some tables (a plain TrueType file only). The browser refuses a whole font when one table does not please it,
// and the tables that are dropped here (old 'kern', hinting programs) are the usual reason; the shapes and the names do not need them.
// Returns a new ArrayBuffer, or null when the file is not a plain sfnt.
export function withoutTables(buf, drop) {
  try {
    const dv = new DataView(buf);
    const n = dv.getUint16(4), keep = [];
    if (dv.getUint32(0) === 0x74746366 || n < 1 || n > 100) return null;
    for (let i = 0; i < n; i++) {
      const rec = 12 + i * 16, tag = String.fromCharCode(...new Uint8Array(buf, rec, 4)), off = dv.getUint32(rec + 8), len = dv.getUint32(rec + 12);
      if (off + len > buf.byteLength) return null;
      if (!drop.includes(tag)) keep.push({ tag, off, len });
    }
    keep.sort((a, b) => (a.tag < b.tag ? -1 : 1));
    const head = 12 + keep.length * 16;
    let size = head; for (const t of keep) size += (t.len + 3) & ~3;
    const out = new ArrayBuffer(size), od = new DataView(out), ob = new Uint8Array(out), src = new Uint8Array(buf);
    od.setUint32(0, dv.getUint32(0)); od.setUint16(4, keep.length);
    let p = 1; while (p * 2 <= keep.length) p *= 2;
    od.setUint16(6, p * 16); od.setUint16(8, Math.log2(p)); od.setUint16(10, keep.length * 16 - p * 16);
    let pos = head;
    keep.forEach((t, i) => {
      ob.set(src.subarray(t.off, t.off + t.len), pos);
      let sum = 0; for (let k = 0; k < t.len; k += 4) { let w = 0; for (let b = 0; b < 4; b++) w = (w * 256 + (k + b < t.len ? src[t.off + k + b] : 0)) >>> 0; sum = (sum + w) >>> 0; }
      const rec = 12 + i * 16;
      for (let b = 0; b < 4; b++) ob[rec + b] = t.tag.charCodeAt(b);
      od.setUint32(rec + 4, sum); od.setUint32(rec + 8, pos); od.setUint32(rec + 12, t.len);
      pos += (t.len + 3) & ~3;
    });
    return out;
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
