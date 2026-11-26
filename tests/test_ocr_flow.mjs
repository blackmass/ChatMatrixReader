// From a picture to chat lines (core/ocr_flow.js): whole chat lines are read, the cut ones and the rests are not, a failing read is skipped, the region follows the game window.
import { check, eq } from './helpers.mjs';
const { readPicture, regionNow } = await import('../app/core/ocr_flow.js');

// a picture (BGRA): dark, with rows of strokes; a row is [top, bottom, left]
function pic(w, h, rows) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = 14; px[i * 4 + 1] = 10; px[i * 4 + 2] = 10; px[i * 4 + 3] = 255; }
  for (const [t, b, left = 4] of rows) for (let y = t; y <= b; y++) for (let x = left; x < w * 0.8; x += 3) { const o = (y * w + x) * 4; px[o] = px[o + 1] = px[o + 2] = 240; }
  return { px, width: w, height: h };
}
const encode = p => ({ mime: 'image/png', base64: `${p.width}x${p.height}` });
const readBy = texts => { let i = 0; const seen = []; return { seen, read: async (img, geo) => { seen.push([img.base64, geo.rows]); return texts[i++] ?? ''; } }; };

{
  // [cut at the top: the rest of a line] [line: 2 rows] [line] [cut at the bottom]
  const p = pic(300, 160, [[0, 8, 21], [22, 33, 5], [40, 51, 21], [62, 73, 5], [92, 103, 5], [150, 159, 5]]);
  const r = readBy(['two rows text', 'one row text', 'sure']);
  const out = await readPicture(p, { encode, read: r.read });
  eq(out.lines, ['two rows text', 'one row text', 'sure'], 'the whole chat lines are read from the top to the bottom');
  check(out.skipped.continued === 1 && out.skipped.cut === 1 && r.seen.length === 3, 'the rest of a line (its beginning is above) and the line cut at the bottom are not read: ' + JSON.stringify(out.skipped));
  check(r.seen[0][1] === 2 && r.seen[1][1] === 1 && r.seen[0][0].startsWith('300x') , 'a chat line of two rows is one picture with its two rows: ' + JSON.stringify(r.seen));
}
{
  const p = pic(300, 120, [[0, 5, 5], [20, 31, 5], [40, 51, 5], [70, 81, 5]]);
  const out = await readPicture(p, { encode, read: readBy(['a', 'b', 'c']).read, keepCut: true });
  check(out.lines.length === 3 && out.skipped.cut === 1, 'a region the user picked is read, also the cut lines (keepCut), but not a sliver of a line (a model makes things up from it): ' + JSON.stringify(out.skipped));
  const p2 = pic(300, 120, [[0, 10, 5], [20, 31, 5], [40, 51, 5]]);
  const out2 = await readPicture(p2, { encode, read: readBy(['a', 'b', 'c']).read, keepCut: true });
  check(out2.lines.length === 3, 'a cut line of which most is seen is read');
}
{
  const p = pic(300, 120, [[20, 31, 5], [40, 51, 5], [60, 71, 5]]);
  const out = await readPicture(p, { encode, read: readBy(['a', '', 'c']).read });
  check(out.lines.join() === 'a,c' && out.skipped.unreadable === 1, 'a line that could not be read is left out, the others stay');
  let err = ''; try { await readPicture(p, { encode, read: async () => { throw new Error('연결 실패'); } }); } catch (e) { err = e.message; }
  check(err === '연결 실패', 'a failing server stops it with the reason');
}
{
  const out = await readPicture(pic(300, 60, []), { encode, read: async () => 'x' });
  check(out.lines.length === 0 && out.rows === 0, 'a picture without lines gives nothing');
}
// the region for the game window as it is now
{
  const region = { x: 100, y: 200, w: 400, h: 100, gw: 1000, gh: 1000 };
  eq(regionNow(region, { width: 2000, height: 500 }), [200, 100, 800, 50], 'the region follows the size of the game window');
  eq(regionNow(region, { width: 1000, height: 1000 }), [100, 200, 400, 100], 'the same size: the same region');
  check(regionNow(null, { width: 100, height: 100 }) === null && regionNow(region, null) === null, 'no region or no window: null');
}
