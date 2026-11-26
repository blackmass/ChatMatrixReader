// The marker bars of the addon (a small solid bar beside the first row of every message of the chat window: RED = a message that cannot be read, GREEN = a readable one) found in a
// picture. A bar is a block of one colour, about barW x barH pixels, in the strip beside the chat window. Text colours are in the strip too (the text begins at the edge of the
// window), so a bar has to be a solid block: the same pixels in most of its rows, not the strokes of a letter.

const isRed = (r, g, b) => r >= 100 && g <= r * 0.4 && b <= r * 0.4;
const isGreen = (r, g, b) => g >= 100 && r <= g * 0.4 && b <= g * 0.4;

// pic: { px (BGRA), width, height }; strip: { x, y, w, h } the part of the picture to look at; barW, barH: the size of a bar in pixels
// -> the bars from the top to the bottom: [{ top, bottom, kind: 'R' | 'G', cutTop, cutBottom }] (rows of the picture, bottom included; cut: the bar is cut by the edge of the strip)
export function findBars(pic, strip, barW, barH) {
  const { px, width: W } = pic;
  const x0 = Math.max(0, strip.x), x1 = Math.min(pic.width, strip.x + strip.w), y0 = Math.max(0, strip.y), y1 = Math.min(pic.height, strip.y + strip.h);
  const need = Math.max(2, Math.round(barW * 0.5));
  const rowKind = new Array(Math.max(0, y1 - y0)).fill('');
  for (let y = y0; y < y1; y++) {
    let r = 0, g = 0;
    for (let x = x0; x < x1; x++) {
      const p = (y * W + x) * 4, B = px[p], G = px[p + 1], R = px[p + 2];
      if (isRed(R, G, B)) r++; else if (isGreen(R, G, B)) g++;
    }
    if (r >= need && r > g) rowKind[y - y0] = 'R'; else if (g >= need) rowKind[y - y0] = 'G';
  }
  // runs of rows of one kind
  const runs = [];
  for (let i = 0; i < rowKind.length; i++) {
    if (!rowKind[i]) continue;
    const last = runs[runs.length - 1];
    if (last && last.kind === rowKind[i] && i - last.end <= 1) last.end = i; else runs.push({ kind: rowKind[i], start: i, end: i });
  }
  const out = [];
  for (const run of runs) {
    const h = run.end - run.start + 1;
    if (h < Math.max(3, barH * 0.4) || h > barH * 1.6) continue;
    // a solid block: columns that have the colour in most of the rows
    const solid = new Int32Array(x1 - x0);
    for (let y = run.start; y <= run.end; y++) {
      for (let x = x0; x < x1; x++) {
        const p = ((y + y0) * W + x) * 4;
        if (run.kind === 'R' ? isRed(px[p + 2], px[p + 1], px[p]) : isGreen(px[p + 2], px[p + 1], px[p])) solid[x - x0]++;
      }
    }
    let cols = 0; for (const c of solid) if (c >= h * 0.7) cols++;
    if (cols < Math.max(2, Math.round(barW * 0.6))) continue;
    const top = run.start + y0, bottom = run.end + y0;
    out.push({ top, bottom, kind: run.kind, cutTop: top === y0 && h < barH * 0.9, cutBottom: bottom === y1 - 1 && h < barH * 0.9 });
  }
  return out;
}
