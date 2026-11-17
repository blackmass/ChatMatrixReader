// The matrix decoders (v1, v2, v3) against the pictures the Python 2.0 encoders drew (tests/fixtures).
import * as v1 from '../app/core/decoder.js';
import * as v2 from '../app/core/proto2.js';
import * as v3 from '../app/core/proto3.js';
import { loadFixtures, busyScreen, flatScreen, put, check, eq, lineTuple } from './helpers.mjs';

const fx = loadFixtures();
let n = 0;

for (const f of fx) {
  const e = f.expect;
  if (f.kind === 'v1') {
    const { frame, why } = v1.decodeRegion(f.img, e.cols);
    check(frame, `${f.name}: ${why}`);
    if (frame) { eq(frame.seq, e.seq, f.name + ' seq'); eq(frame.lines.map(lineTuple), e.lines, f.name + ' lines'); }
    const scr = put(busyScreen(1920, 1080, 5), f.img, 200, 100);
    eq(v1.findMatrixEx(scr), { x: 200, y: 100, cols: e.cols }, f.name + ' located');
    check(v2.findAndDecode(scr) === null, f.name + ' is not a v2 matrix');
  } else if (f.kind === 'v2') {
    const { frame, why } = v2.decode(f.img, 0, 0);
    check(frame, `${f.name}: ${why}`);
    if (frame) {
      eq([frame.seq, frame.levels, frame.cols, frame.rows], [e.seq, e.levels, e.cols, e.rows], f.name + ' header');
      eq(frame.lines.map(lineTuple), e.lines, f.name + ' lines');
    }
    check(v2.decode(f.img, 0, 0, e.cols === 32 ? 16 : 32).frame === null, f.name + ' wrong shape refused');
    const x0 = e.cols === 16 ? 1920 - 64 : 333, y0 = 417;
    const scr = put(busyScreen(1920, 1080, 6 + n++), f.img, x0, y0);
    const hit = v2.findAndDecode(scr);
    check(hit && Math.abs(hit.x - x0) <= (x0 === 1920 - 64 ? 1 : 0) && hit.y === y0 && hit.frame.levels === e.levels, `${f.name} located: ${hit && [hit.x, hit.y]}`);
    check(v1.findMatrixEx(scr) === null, f.name + ' is not a v1 matrix');
    check(v3.findAndDecode(scr) === null, f.name + ' is not a v3 line');
  } else if (f.kind === 'v2_reject') {
    const { frame } = v2.decode(f.img, 0, 0);
    check(frame === null || frame.seq === e.seq, f.name + ' hopeless damage is rejected, never mis-decoded');
  } else if (f.kind === 'v3') {
    const row = v3.oriented(f.img, 0, 0, f.vertical, v3.extent(f.img, 0, 0, f.vertical));
    const { frame, why } = v3.decode(row, f.vertical);
    check(frame, `${f.name}: ${why}`);
    if (frame) {
      eq([frame.seq, frame.levels, frame.cells, frame.vertical], [e.seq, e.levels, e.cells, e.vertical], f.name + ' header');
      eq(frame.lines.map(lineTuple), e.lines, f.name + ' lines');
    }
    check(v3.decode(row, !f.vertical).frame === null, f.name + ' wrong orientation refused');
    // located at the screen edges (the position is exact to 1 px)
    const w = f.img.width, h = f.img.height;
    const spots = f.vertical ? [[0, Math.min(300, 1080 - h)], [1920 - 4, 0], [7, 1080 - h]] : [[0, 1080 - 4], [640, 0], [1920 - w, 1], [3, 30]];
    for (const [x, y] of spots) {
      const scr = put(flatScreen(1920, 1080), f.img, x, y);
      const hit = v3.findAndDecode(scr);
      check(hit && hit.vertical === f.vertical && hit.frame.seq === e.seq && Math.abs(hit.x - x) <= 1 && Math.abs(hit.y - y) <= 1, `${f.name} located at ${x},${y}: ${hit && [hit.x, hit.y]}`);
    }
    if (!f.name.includes('_gain') && f.name.endsWith('_h')) {                         // a band grabbed on its own
      const scr = put(flatScreen(1920, 48), f.img, 100, 20);
      const hit = v3.findInBand(scr, false);
      check(hit && hit.frame.seq === e.seq, f.name + ' found in a band');
    }
    check(v2.findAndDecode(put(flatScreen(1920, 1080), f.img, 0, Math.min(1000, 1080 - f.img.height))) === null, f.name + ' is not a v2 matrix');
  } else if (f.kind === 'v3_reject') {
    const row = v3.oriented(f.img, 0, 0, false, f.img.width);
    check(v3.decode(row, false).frame === null, f.name + ' must not decode');
  }
}

// nothing is found where there is nothing
for (let s = 0; s < 5; s++) {
  const scr = busyScreen(1920, 1080, 100 + s);
  check(v2.findAndDecode(scr) === null && v3.findAndDecode(scr) === null && v1.findMatrixEx(scr) === null, 'no false positive on a random screen ' + s);
}
// a v3 line in the middle of the screen is not looked for
const mid = fx.find(f => f.name === 'v3_L4_h');
check(v3.findAndDecode(put(flatScreen(1920, 1080), mid.img, 300, 500)) === null, 'v3 line away from the edges is not found');
// speed of the corner search the reader uses
const corner = busyScreen(900, 260, 77);
const t = performance.now();
for (let i = 0; i < 10; i++) v2.findAndDecode(corner);
console.log(`  corner window search ${((performance.now() - t) / 10).toFixed(1)} ms; full HD v2 search:`, (() => { const s = busyScreen(1920, 1080, 78); const t0 = performance.now(); v2.findAndDecode(s); return (performance.now() - t0).toFixed(0) + ' ms'; })());
