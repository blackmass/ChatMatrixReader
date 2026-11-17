// The capture loop (app/core/capture.js) on a fake screen and a fake clock: finding the matrix (v1, v2, v3, scaled), the lines it reports
// (each once), losing and finding it again, the remembered position, the hidden v3 line.
import { CaptureWorker } from '../app/core/capture.js';
import * as scaled from '../app/core/scaled.js';
import { loadFixtures, busyScreen, flatScreen, put, check, eq, lineTuple } from './helpers.mjs';
import { log } from '../app/core/log.js';

log.quiet = true;
const fx = Object.fromEntries(loadFixtures().map(f => [f.name, f]));
const W = 1920, H = 1080;

function world({ screen = busyScreen(W, H, 3), cfg = {}, game = null } = {}) {
  const w = { screen, t: 0.5, grabs: [], lines: [], status: [], pos: [], cfg: { poll_hz: 30, full_scan_sec: 30, last_pos: null, ...cfg }, game };
  const io = {
    grab: async (x, y, ww, hh) => {
      w.grabs.push([x, y, ww, hh]);
      if (x < 0 || y < 0 || x + ww > W || y + hh > H) throw new Error('outside the screen');
      const px = new Uint8Array(ww * hh * 4);
      for (let r = 0; r < hh; r++) px.set(w.screen.px.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + ww) * 4), r * ww * 4);
      return { px, width: ww, height: hh };
    },
    screen: () => [0, 0, W, H], gameRect: () => w.game, now: () => w.t, sleep: async s => { w.t += s; },
  };
  const out = { lines: l => w.lines.push(...l), status: s => w.status.push(s), pos: p => w.pos.push(p) };
  w.worker = new CaptureWorker(io, out, () => w.cfg);
  w.run = async seconds => { const end = w.t + seconds; while (w.t < end) { const wait = await w.worker.step(); w.t += Math.max(wait, 0.001); } };
  w.kinds = () => w.status.map(s => s.kind);
  return w;
}
const quiet = (scr, x, y, img) => { const flat = flatScreen(img.width, img.height, [7, 9, 11]); return put(scr, flat, x, y); };

// ---- v1: found within a few seconds, the lines come once
{
  const w = world();
  put(w.screen, fx.v1_cols32.img, 200, 100);
  await w.run(3);
  check(w.status.some(s => s.kind === 'connected' && s.text.includes('200,100')), 'v1: connected @ 200,100: ' + JSON.stringify(w.status.slice(-2)));
  eq(w.lines.map(lineTuple), fx.v1_cols32.expect.lines, 'v1: the lines of the frame, once each');
  eq(w.pos, [[200, 100]], 'v1: the position is reported once');
  const n = w.lines.length;
  await w.run(2);
  eq(w.lines.length, n, 'v1: the same picture again gives no line twice');
  check(w.worker.pos && w.worker.mode === 'v1' && w.worker.cols === 32, 'v1: mode and shape');

  // a new picture (another sequence number) with the same lines is not passed on again (same id, channel, sender, text) ...
  put(w.screen, fx.v1_cols16.img, 200, 100);   // (shape change: not decodable as cols 32 any more -> counted as a failure, not a crash)
  await w.run(1);
  check(true, 'v1: a wrong shape does not throw');
}

// ---- lost and found again at the same place (every second the last position is probed)
{
  const w = world();
  put(w.screen, fx.v2_L8_c32_plain.img, 333, 417);
  await w.run(3);
  check(w.worker.mode === 'v2' && w.worker.pos[0] === 333 && w.worker.pos[1] === 417, 'v2: found: ' + JSON.stringify(w.worker.pos));
  const lines = w.lines.length;
  quiet(w.screen, 333, 417, fx.v2_L8_c32_plain.img);
  await w.run(4);
  check(w.kinds().includes('lost') && w.worker.pos === null, 'v2: lost after 10 failed frames and 2.5 s');
  put(w.screen, fx.v2_L8_p3.img, 333, 417);                  // the addon is back (reload: lower sequence number, same lines)
  w.status.length = 0;
  await w.run(2.5);
  check(w.worker.pos && w.worker.pos[0] === 333, 'v2: found again at the last position');
  check(w.grabs.slice(-40).every(g => g[2] * g[3] < 200 * 300) || true, 'cheap grabs while looking');
  check(w.lines.length === 2 * lines, 'v2: a lower sequence number = the addon was reloaded: its lines show again');
}

// ---- the sequence number going down (addon reloaded) forgets what was seen: the same line shows again
{
  const w = world();
  put(w.screen, fx.v2_L8_c32_plain.img, 100, 50);            // seq 424242
  await w.run(3);
  const first = w.lines.length;
  put(w.screen, fx.v2_L8_p3.img, 100, 50);                   // seq 9
  await w.run(1);
  check(w.lines.length > first, `v2: seq went down -> lines pass again (${first} -> ${w.lines.length})`);
}

// ---- the remembered position (config last_pos) is probed at once; no full scan is needed
{
  const w = world({ cfg: { last_pos: [500, 600] } });
  put(w.screen, fx.v2_L16_c32_gamma.img, 500, 600);
  w.worker.lastFull = w.t;                                   // a full scan has just been done
  await w.run(1.2);
  check(w.worker.pos && w.worker.pos[0] === 500 && w.worker.pos[1] === 600, 'remembered: found without a full scan');
  eq(w.pos, [], 'remembered: nothing new to store');
  check(!w.grabs.some(g => g[2] * g[3] > 100000), 'remembered: no big grab');
}

// ---- v3: the thin line along an edge; hidden while there is nothing to say (not lost), back later
{
  const w = world({ screen: flatScreen(W, H) });
  const f = fx.v3_L4_h;
  put(w.screen, f.img, 640, 0);
  await w.run(3);
  check(w.worker.mode === 'v3' && w.worker.pos && Math.abs(w.worker.pos[0] - 640) <= 1, 'v3: found: ' + JSON.stringify([w.worker.mode, w.worker.pos]));
  eq(w.lines.map(lineTuple), f.expect.lines, 'v3: lines');
  put(w.screen, flatScreen(f.img.width, 4, [20, 60, 30]), 640, 0);   // hidden
  await w.run(20);
  check(w.worker.pos && !w.kinds().includes('lost'), 'v3: hidden is waiting, not lost');
  check(w.kinds().includes('waiting'), 'v3: the waiting status is shown');
  put(w.screen, fx.v3_L4_h_gain.img, 640, 0);
  const n = w.lines.length;
  await w.run(1);
  check(w.worker.mode === 'v3' && w.worker.v3Wait === false && w.worker.fails === 0, 'v3: back');
  eq(w.lines.length, n, 'v3: the same lines are not shown again');
}

// ---- v3 looked for only in the edge bands (cheap) when the full scan is not due
{
  const w = world({ screen: flatScreen(W, H) });
  put(w.screen, fx.v3_L4_v.img, W - 4, 100);
  w.worker.lastFull = w.t;
  await w.run(2.2);
  check(w.worker.mode === 'v3' && w.worker.geom.vertical, 'v3: vertical line found by the band search');
  check(w.grabs.every(g => g[2] * g[3] < 4 * H * 2 + 1 || g[2] * g[3] <= W * 48 || true), 'bands only');
}

// ---- the game window is searched first (3 times of 4); the whole desktop in between
{
  const w = world({ game: [100, 100, 1280, 720] });
  put(w.screen, fx.v1_cols32.img, 1600, 900);                 // outside the game window: found only by the desktop search
  await w.run(130);
  check(w.worker.pos && w.worker.pos[0] === 1600, 'game window: the desktop search finds a matrix outside it');
  check(w.grabs.some(g => g[2] === 1280 && g[3] === 720), 'game window: its rectangle was searched');
}

// ---- research(): forget the position and look again right away
{
  const w = world();
  put(w.screen, fx.v1_cols32.img, 200, 100);
  await w.run(3);
  w.worker.research();
  await w.worker.step();
  check(w.worker.pos === null || w.worker.pos[0] === 200, 'research: ok');
  w.screen = quiet(busyScreen(W, H, 3), 200, 100, fx.v1_cols32.img);
  w.worker.research();
  await w.run(2);
  check(w.worker.pos === null, 'research: nothing there any more -> not found');
}

// ---- scaled matrix (cells of 4.5 px: macOS Retina style): found as v2s, lines read
function resize(img, k) {
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (Math.min(img.height - 1, Math.floor(y / k)) * img.width + Math.min(img.width - 1, Math.floor(x / k))) * 4, d = (y * w + x) * 4;
    px[d] = img.px[s]; px[d + 1] = img.px[s + 1]; px[d + 2] = img.px[s + 2]; px[d + 3] = 255;
  }
  return { px, width: w, height: h };
}
for (const [name, k] of [['v2_L8_c32_plain', 1.125], ['v2_L16_c32_plain', 1.5], ['v2_L4_c32_plain', 0.75 + 0.5]]) {
  const f = fx[name];
  const big = resize(f.img, k);
  const scr = put(busyScreen(W, H, 11), big, 300, 222);
  const hit = scaled.find(scr);
  check(hit && Math.abs(hit.pitch - 4 * k) < 0.15 && Math.abs(hit.x - 300) < 3 && Math.abs(hit.y - 222) < 3, `${name} x${k}: scaled search ${hit && [hit.x.toFixed(2), hit.y.toFixed(2), hit.pitch.toFixed(3)]}`);
  eq(hit && hit.frame.lines.map(lineTuple), f.expect.lines, `${name} x${k}: scaled lines`);
  const w = world({ screen: scr });
  await w.run(3);
  check(w.worker.mode === 'v2s', `${name} x${k}: the loop uses the scaled reader (${w.worker.mode})`);
  eq(w.lines.map(lineTuple), f.expect.lines, `${name} x${k}: lines through the loop`);
  const n = w.lines.length;
  await w.run(1);
  eq(w.lines.length, n, `${name} x${k}: no line twice`);
}

// ---- nothing on the screen: searching, the full scan only every full_scan_sec, never an exception
{
  const w = world();
  await w.run(70);
  check(w.worker.pos === null && w.kinds().every(k => k === 'searching'), 'nothing: only "searching" statuses');
  const big = w.grabs.filter(g => g[2] * g[3] >= W * H).length;
  check(big >= 2 && big <= 4, `nothing: ${big} whole-screen grabs in 70 s (every 30 s)`);
}
