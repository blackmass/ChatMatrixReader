// Finding the lines of a picture of the chat by the picture alone (core/ocr_lines.js). The pictures here are made by the test: dark bands with "letters" (bright
// vertical strokes) in rows, a gap between the lines. (The real chat pictures were tried by hand, see docs/HANDOFF.md.)
import { check, eq } from './helpers.mjs';
const { findLines, groupLines } = await import('../app/core/ocr_lines.js');

// w x h picture, background colour bg; each line = [top, bottom] rows with strokes every 3 pixels over `span` of the width, coloured `fg`
function picture(w, h, lines, { bg = [10, 10, 14], fg = [240, 240, 240], span = 0.8, noise = 0 } = {}) {      // (a line may be [top, bottom, left]: where its letters begin, 4 if not told)
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = bg[0]; px[i * 4 + 1] = bg[1]; px[i * 4 + 2] = bg[2]; px[i * 4 + 3] = 255; }
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const [t, b, left = 4] of lines) for (let y = t; y <= b; y++) for (let x = left; x < w * span; x += 3) { const o = (y * w + x) * 4; px[o] = fg[0]; px[o + 1] = fg[1]; px[o + 2] = fg[2]; }
  if (noise) for (let i = 0; i < w * h; i++) { const n = Math.round((rnd() - 0.5) * noise); for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.max(0, Math.min(255, px[i * 4 + c] + n)); }
  return px;
}
const tops = ls => ls.map(l => l.core[0] + '-' + l.core[1]).join(' ');

{
  const w = 300, h = 120, px = picture(w, h, [[20, 31], [40, 51], [60, 71], [80, 91]]);
  const ls = findLines(px, w, h);
  check(ls.length === 4 && tops(ls) === '20-31 40-51 60-71 80-91', 'four lines, a gap between them: ' + tops(ls));
  check(ls.every(l => !l.cutTop && !l.cutBottom), 'whole lines are not marked as cut');
  check(ls[1].top > ls[0].bottom && ls[1].top - ls[0].bottom === 1 && ls[0].top <= 20 && ls[3].bottom >= 91, 'each line is widened to the middle of the gap, with no hole and no overlap');
}
{
  const w = 300, h = 100, px = picture(w, h, [[0, 7], [20, 31], [40, 51], [60, 71], [92, 99]]);
  const ls = findLines(px, w, h);
  check(ls.length === 5 && ls[0].cutTop && !ls[0].cutBottom && ls[4].cutBottom && !ls[4].cutTop && ls.slice(1, 4).every(l => !l.cutTop && !l.cutBottom), 'a line that touches the top / bottom edge is marked as cut, the ones between are not');
}
{
  const w = 300, h = 100, px = picture(w, h, [[3, 9], [20, 31], [40, 51], [60, 71], [88, 96]]);          // (cut, but not exactly at the edge: the picture was cut inside of the letters' margin)
  const ls = findLines(px, w, h);
  check(ls[0].cutTop === true && ls[4].cutBottom === true, 'a line too near to the edge for a whole line is marked as cut too: ' + JSON.stringify(ls.map(l => [l.cutTop, l.cutBottom])));
}
{
  const w = 300, h = 100, px = picture(w, h, [[20, 31], [40, 51], [60, 71]], { noise: 14 });
  check(findLines(px, w, h).length === 3, 'a little noise in the background changes nothing');
}
{
  const w = 300, h = 100, px = picture(w, h, [[20, 31], [40, 51], [60, 71]], { fg: [30, 110, 30], bg: [12, 14, 12] });
  check(findLines(px, w, h).length === 3, 'dark green letters on a dark background are found (the colour changes, not only the brightness)');
}
{
  const w = 300, h = 80;
  check(findLines(picture(w, h, []), w, h).length === 0, 'an empty picture has no lines');
  check(findLines(picture(w, h, [[30, 32]]), w, h).length === 0, 'a speck is not a line');
  eq(findLines(picture(w, h, [[10, 21], [24, 24]]), w, h).length, 1, 'a thin stroke close under a line (an underline) is one line with it');
}

// where the letters begin, and the chat lines made of rows
{
  const w = 300, h = 130;
  const px = picture(w, h, [[10, 21, 5], [30, 41, 6], [50, 61, 21], [70, 81, 10], [90, 101, 5], [110, 121, 21]]);
  const ls = findLines(px, w, h);
  eq(ls.map(l => l.left), [5, 6, 21, 10, 5, 21], 'the beginning of each row is found');
  const g = groupLines(ls);
  eq(g.map(m => m.lines.length), [1, 2, 1, 2], 'a row that begins further right is the rest of the line above; a row that begins a little right (another first letter) is not: 1, 2, 1, 2');
  check(!g.some(m => m.continued) && g[1].top === ls[1].top && g[1].bottom === ls[2].bottom, 'a chat line covers its rows');
}
{
  const w = 300, h = 100;
  const g = groupLines(findLines(picture(w, h, [[10, 21, 21], [30, 41, 21], [50, 61, 5], [70, 81, 21]]), w, h));
  check(g.length === 2 && g[0].continued === true && g[0].lines.length === 2 && g[1].continued === false && g[1].lines.length === 2, 'the first rows are the rest of a line that began above the picture: marked "continued"');
  const g2 = groupLines(findLines(picture(w, h, [[10, 21, 21], [30, 41, 21]]), w, h), { baseX: 5 });
  check(g2.length === 1 && g2[0].continued === true, 'when every row is indented, the known beginning of a line (baseX) tells they are all rests');
  check(groupLines([]).length === 0, 'no rows, no chat lines');
}
{
  const w = 300, h = 80;
  const ls = findLines(picture(w, h, [[10, 21, 5], [30, 41, 40]]), w, h, { skipLeft: 20 });
  check(ls[0].left >= 20, 'skipLeft leaves out the buttons at the left: ' + ls[0].left);
}
