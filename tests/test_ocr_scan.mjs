// The reading of a restricted chat with the help of the addon: the state line, the bars in a picture, the ledger, and BarScan (pictures made by the test).
import { check, eq } from './helpers.mjs';
const { parseState, regionOf } = await import('../app/core/ocr_state.js');
const { findBars } = await import('../app/core/ocr_bars.js');
const { Ledger, matchTail } = await import('../app/core/ocr_ledger.js');
const { BarScan, sameReading } = await import('../app/core/ocr_scan.js');

const STATE = n => `1,${n},1,34,190,426,188,0,-6,40,6,12,17,14,0,1920,1080,2,2,128,16,98,14`;
const client = { width: 1920, height: 1080 };

// ---- the state line
{
  const st = parseState(STATE(5));
  check(st && st.n === 5 && st.left === 34 && st.bottom === 190 && st.width === 426 && st.height === 188 && st.pitch === 17 && st.fontH === 14 && st.scroll === 0 && st.pw === 1920 && st.messages === 98 && st.shown === 14, 'the state line is read');
  check(parseState('') === null && parseState('1,2,3') === null && parseState(STATE(1).replace('1,1,1,34', '2,1,1,34')) === null && parseState(STATE(1).replace('426', 'x')) === null && parseState(STATE(1).replace(',17,14,', ',10,14,').replace(',6,12,10,14', ',6,12,10,14')) !== undefined, 'a line that is not a state of version 1 is nothing');
  const st2 = parseState(STATE(5) + ',1234,5678901');
  check(st2 && st2.t === 1234 && st2.session === 5678901 && st2.messages === 98 && st.t === undefined && st.session === undefined, 'the count of the chat window and the session are read when the addon sends them, and are nothing when it does not');
  check(parseState(STATE(5) + ',12,x').t === 12 && parseState(STATE(5) + ',12,x').session === undefined, 'a field at the end that is not a number is left out, the state is still read');
  const r = regionOf(st, client);
  eq([r.x, r.y, r.w, r.h], [0, 702, 460, 188], 'the part of the game window to grab: the window and the strip beside it (y from the top: 1080 - (190 + 188))');
  eq([r.chat.left, r.chat.top, r.chat.width, r.chat.height, r.strip.x, r.strip.w, r.pitch, r.fontH, r.barW, r.barH], [34, 0, 426, 188, 0, 34, 17, 14, 6, 12], 'its places in that part: the window, the strip (cut at the screen edge), the sizes');
  const half = regionOf(st, { width: 960, height: 540 });
  check(half && half.pitch === 9 && half.chat.width === 213 && half.y === 351, 'a game window that is half as big: everything is half as big');
  check(regionOf(st, { width: 1920, height: 900 }) === null && regionOf(st, null) === null && regionOf(null, client) === null, 'a window of another shape does not fit: nothing');
}

// ---- a picture of a chat window: messages from the bottom up (kind, rows), rows on a grid of 17 pixels, a bar at the first row of every message
const W = 460, H = 188, L = 34, CW = 426, P = 17, F = 14;
function scene(messages, { cover = null, strokeSeed = 1 } = {}) {
  const px = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = 20; px[i * 4 + 1] = 14; px[i * 4 + 2] = 14; px[i * 4 + 3] = 255; }
  const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; px[o] = b; px[o + 1] = g; px[o + 2] = r; };
  let k = 0;
  for (const m of messages) {
    const rowsTop = [];
    for (let j = 0; j < m.rows; j++) rowsTop.push(H - ((k + m.rows - 1 - j) * P + F));          // (the first row of the message is the highest)
    k += m.rows;
    rowsTop.forEach((top, j) => {
      for (let y = top; y < top + F; y++) for (let x = L + (j ? 12 : 0); x < L + CW - 20 - (m.cut || 0); x++) {
        const hit = ((x * 7 + y * 13 + (m.seed || 1) * 31 + j * 5) % 11) < 4;
        if (hit && y >= 0 && y < H) put(x, y, m.kind === 'R' ? 230 : 230, m.kind === 'R' ? 40 : 230, 40);        // (the red text of a boss line is in the picture too)
      }
    });
    const first = rowsTop[0] - 0;                                            // (the bar: 1 px below the top of the first row, 12 tall, 6 wide, 17 px left of the window)
    for (let y = first + 1; y < first + 13; y++) for (let x = L - 17; x < L - 11; x++) if (y >= 0 && y < H) put(x, y, m.kind === 'R' ? 255 : 0, m.kind === 'R' ? 0 : 255, 0);
  }
  if (cover) for (let y = cover.y; y < cover.y + cover.h; y++) for (let x = cover.x; x < cover.x + cover.w; x++) put(x, y, 40, 40, 40);
  return { px, width: W, height: H };
}
const REGION = regionOf(parseState(STATE(1)), client);

// ---- the bars
{
  const pic = scene([{ kind: 'R', rows: 2 }, { kind: 'G', rows: 1 }, { kind: 'R', rows: 1 }, { kind: 'G', rows: 3 }]);
  const bars = findBars(pic, { x: REGION.strip.x, y: 0, w: REGION.strip.w, h: H }, 6, 12);
  eq(bars.map(b => b.kind).join(''), 'GRGR', 'the bars are found from the top to the bottom, red and green (the red text of the window is not a bar)');
  eq(bars.map(b => b.bottom - b.top + 1), [12, 12, 12, 12], 'each is a whole bar');
  eq([bars[1].top - bars[0].top, bars[2].top - bars[1].top, bars[3].top - bars[2].top], [3 * P, P, P], 'the bars are on the grid of the rows: as far apart as the rows of the message above (3, 1, 1 rows)');
  const cut = findBars(scene(Array.from({ length: 11 }, () => ({ kind: 'G', rows: 1 }))), { x: 0, y: 0, w: 34, h: H }, 6, 12);
  check(cut.length === 11 && !cut[0].cutTop, 'eleven messages fill the window: all bars whole');
  const over = scene(Array.from({ length: 12 }, () => ({ kind: 'G', rows: 1 })));
  const cutBars = findBars(over, { x: 0, y: 0, w: 34, h: H }, 6, 12);
  check(cutBars.length >= 11 && cutBars[0].top >= 0, 'a twelfth message above the window has no bar or a cut one');
}

// ---- the ledger and the matching
{
  const L2 = new Ledger();
  const mk = kinds => kinds.split('').map((k, i) => L2.add({ id: i + 1, channel: 'G', text: k === 'R' ? '[restricted]' : 'hello ' + i }, 1));
  mk('ARRAR');
  check(L2.add({ id: 9, channel: '@RT', text: '12' }, 1) === null && L2.add({ id: 9, channel: '@CS', text: 'x' }, 1) === null && L2.add({ id: 9, channel: '!OCR', text: 'x' }, 1) === null && L2.add({ id: 9, channel: '@x', text: 'x' }, 1) === null && L2.add({ id: 10, channel: '!PG', text: 'x' }, 1) !== null, 'the control lines and the lines of the program are not messages; a ping is');
  const ledger = new Ledger(); [['A'], ['R'], ['R'], ['A'], ['R']].forEach(([k], i) => ledger.add({ id: i + 1, channel: 'G', text: k === 'R' ? '[restricted]' : 't' }, 1));
  const scr = s => s.split('').map(k => ({ kind: k }));
  let m = matchTail(scr('ARRAR'), ledger.list);
  check(m.ok && m.pairs.length === 5 && m.pairs.every((p, i) => p.si === i && p.entry.seq === i + 1), 'the same on both sides: every bar has its entry');
  m = matchTail(scr('XXARRAR'.replace(/X/g, 'G')), ledger.list);
  check(m.ok && m.pairs.length === 5, 'older bars on the screen than the ledger holds are left alone');
  m = matchTail(scr('RRAR'), ledger.list);
  check(m.ok && m.pairs.length === 4 && m.pairs[0].entry.seq === 2, 'the ledger holds more than the window shows (the oldest went up): the newest are paired');
  m = matchTail(scr('ARRARR'), ledger.list);
  check(m.ok && m.ahead === 1 && m.pairs.length === 5, 'a message is drawn that the ledger has not got yet (it comes a moment later): its bar waits');
  m = matchTail(scr('ARRA'), ledger.list);
  check(m.ok && m.behind === 1 && m.pairs.length === 4, 'the ledger has a message that is not drawn yet: it waits');
  m = matchTail(scr('ARGRAR'), ledger.list);
  check(m.ok && m.skipped === 1, 'a readable message on the screen that the ledger has not (another addon wrote it) is skipped: ' + JSON.stringify([m.ok, m.skipped]));
  m = matchTail(scr('RRRRRRRRRR'), ledger.list);
  check(m.ok && m.pairs.length === 3, 'more restricted bars on the screen than the ledger has: the older ones have no entry, they are left alone');
  m = matchTail(scr('GGGGGGGGGG'), ledger.list);
  check(!m.ok, 'only readable bars on the screen while the ledger has restricted messages: nothing fits, not ok');
}

// ---- BarScan
const line = (id, kind, text) => ({ id, channel: 'G', text: kind === 'R' ? '[restricted]' : (text || 'hello') });
function setup(opts = {}) {
  const bs = new BarScan(opts);
  bs.onLine({ channel: '@CS', text: STATE(1) }, 0);
  bs.begin();
  return bs;
}
// the picture of a message changes when the text of it changes: another seed of the strokes
function sceneSeed(messages, seed) { return scene(messages.map(m => ({ ...m, seed, cut: ((seed - 1) % 8) * 40 }))); }
{
  // the default: a message is read once, when its picture is the same in two pictures
  const bs = setup();
  [['A'], ['R'], ['R']].forEach(([k], i) => bs.onLine(line(i + 1, k), 10));
  const pic = scene([{ kind: 'R', rows: 2 }, { kind: 'R', rows: 1 }, { kind: 'G', rows: 1 }]);
  let r = bs.scan(pic, REGION, 10.1);
  check(r.status === 'ok' && r.jobs.length === 0, 'the first time a message is on a picture it is not read yet');
  r = bs.scan(pic, REGION, 10.2);
  check(r.jobs.length === 0, 'the same picture a moment later (less than the settling time): not yet');
  r = bs.scan(pic, REGION, 10.4);
  check(r.jobs.length === 2 && r.jobs[0].seq === 2 && r.jobs[1].seq === 3, 'the same picture again: two jobs, the older first: ' + JSON.stringify(r.jobs.map(j => j.seq)));
  eq([r.jobs[0].pic.height, r.jobs[1].pic.height, r.jobs[0].geo.rows, r.jobs[1].geo.rows, r.jobs[0].pic.width], [14, 31, 1, 2, 426], 'the picture of a job holds all rows of the message (a message of two rows is 31 pixels high), nothing of the others');
  check(bs.scan(pic, REGION, 10.7).jobs.length === 0, 'what is being read is not asked again');
  bs.onRead(3, 'Run away!', 10.8);
  eq(bs.collect(10.8).done.map(x => x.text), ['Run away!'], 'the later message is ready first: it is given at once (its place in the chat is kept by the program, not by waiting)');
  bs.onRead(2, '[Boss]: burn them all', 10.9);
  const rel = bs.collect(10.9);
  eq(rel.done.map(x => x.text), ['[Boss]: burn them all'], 'the earlier one is ready now: given (each only once)');
  check(bs.collect(11).done.length === 0 && bs.stats.shown === 2, 'and each only once');
}
{
  // the picture of a message that is still changing (a bar that has not got its colour, the rows not in their place) is not read; when it is still it is
  const bs = setup();
  bs.onLine(line(1, 'R'), 10);
  const a = sceneSeed([{ kind: 'R', rows: 1 }], 1), b = sceneSeed([{ kind: 'R', rows: 1 }], 2);
  bs.scan(a, REGION, 10.1);
  check(bs.scan(b, REGION, 10.4).jobs.length === 0, 'another picture than the one before: not read');
  check(bs.scan(b, REGION, 10.7).jobs.length === 1, 'the same as the one before: read');
}
{
  // a message that never gets still is read anyway after a while
  const bs = setup();
  bs.onLine(line(1, 'R'), 10);
  let jobs = 0;
  for (let i = 0; i < 12; i++) jobs += bs.scan(sceneSeed([{ kind: 'R', rows: 1 }], i + 1), REGION, 10.1 + i * 0.25).jobs.length;
  check(jobs === 1, 'a picture that changes all the time: read after maxSettle seconds, once');
}
{
  // the older way, two readings that agree (readsNeeded 2)
  const bs = setup({ readsNeeded: 2 });
  bs.onLine(line(1, 'R'), 10);
  const pic = scene([{ kind: 'R', rows: 1 }]);
  bs.scan(pic, REGION, 10.1); bs.scan(pic, REGION, 10.4);
  bs.onRead(1, 'a garbled something', 10.5);
  check(bs.collect(10.5).done.length === 0 && bs.scan(pic, REGION, 10.8).jobs.length === 1, 'one reading is not enough there: a second one is asked for');
  bs.onRead(1, 'The real words of the line', 10.9);
  check(bs.collect(10.9).done.length === 0, 'two different readings: not shown');
  bs.scan(pic, REGION, 11.2); bs.onRead(1, 'The real words of the line!', 11.3);
  eq(bs.collect(11.3).done.map(x => [x.text, x.best]), [['The real words of the line!', false]], 'the third reading agrees with the second: that one is shown');
}
{
  const bs = setup({ readsNeeded: 2 });
  bs.onLine(line(1, 'R'), 10);
  const pic = scene([{ kind: 'R', rows: 1 }]);
  bs.scan(pic, REGION, 10.1); bs.scan(pic, REGION, 10.4);
  for (let i = 0; i < 3; i++) { bs.onRead(1, ['one thing', 'something else', 'a third text'][i], 10.5 + i * 0.4); bs.scan(pic, REGION, 10.8 + i * 0.4); }
  const rel = bs.collect(12);
  check(rel.done.length === 1 && rel.done[0].best === true && rel.done[0].text === 'a third text', 'three readings that all differ: the newest is shown, marked as not confirmed');
}
{
  // the window is full, older restricted messages went up before they could be read: missed, counted exactly, told after they have been missing for a moment
  const bs = setup();
  for (let i = 1; i <= 15; i++) bs.onLine(line(i, i % 2 ? 'R' : 'A'), 10);
  const pic = scene(Array.from({ length: 11 }, (_, i) => ({ kind: (15 - i) % 2 ? 'R' : 'G', rows: 1 })));
  let r = bs.scan(pic, REGION, 10.1);
  check(r.status === 'ok' && r.paired === 11 && r.missed === 0, 'fifteen messages came, eleven are in the window: the first picture does not tell yet: ' + JSON.stringify([r.status, r.paired, r.missed]));
  r = bs.scan(pic, REGION, 10.5);
  check(r.missed === 2 && r.debug && r.debug.ledger.length > 0, 'a moment later the two restricted ones among the four that went up are told as missed, with the colours of the bars and of the ledger for the log: ' + JSON.stringify([r.missed, r.debug && r.debug.screen]));
  check(bs.scan(pic, REGION, 10.9).missed === 0, 'and told once');
}
{
  const bs = setup();
  bs.onLine(line(1, 'R'), 10); bs.onLine(line(2, 'R'), 10);
  const pic2 = scene([{ kind: 'R', rows: 1 }, { kind: 'R', rows: 1 }]);
  bs.scan(pic2, REGION, 10.1);
  let r = bs.scan(pic2, REGION, 10.4);
  check(r.jobs.length === 2, 'two jobs');
  bs.onLine({ channel: '@CS', text: STATE(2).replace(',0,1920', ',3,1920') }, 10.5);
  r = bs.scan(pic2, REGION, 10.6);
  check(r.status === 'scrolled' && r.jobs.length === 0, 'the window is scrolled up: nothing is read');
  bs.onLine({ channel: '@CS', text: STATE(3) }, 10.7);
  bs.onLine(line(3, 'A'), 10.7);
  r = bs.scan(scene(Array.from({ length: 10 }, () => ({ kind: 'G', rows: 1 }))), REGION, 10.8);
  check(r.status === 'mismatch' && r.debug && r.debug.screen.length === 10, 'a picture with only readable bars while the ledger has restricted messages: it does not fit, mismatch, nothing is read');
}
{
  // a frame in which the bars still have the colours of the messages that were there before (the colour is set a frame after the message came): the messages are not paired wrongly for good
  const bs = setup();
  bs.onLine(line(1, 'A'), 10); bs.onLine(line(2, 'R'), 10); bs.onLine(line(3, 'A'), 10);
  const right = scene([{ kind: 'G', rows: 1, cut: 0 }, { kind: 'R', rows: 1, cut: 80 }, { kind: 'G', rows: 1, cut: 160 }]);      // (bottom up; each message has its own look)
  const stale = scene([{ kind: 'R', rows: 1, cut: 0 }, { kind: 'G', rows: 1, cut: 80 }, { kind: 'G', rows: 1, cut: 160 }]);
  let r = bs.scan(stale, REGION, 10.1);
  const jobsStale = r.jobs.length;
  r = bs.scan(right, REGION, 10.4);
  check(jobsStale === 0 && r.jobs.length === 0, 'a picture with wrong colours is not read from, and one picture of the right colours is only the first picture of the message');
  r = bs.scan(right, REGION, 10.7);
  check(r.jobs.length === 1 && r.jobs[0].seq === 2, 'the next one of the same: the restricted message is read');
}
{
  const bs = setup();
  bs.onLine({ channel: '@CS', text: STATE(9) }, 5); bs.onLine({ channel: '@CS', text: STATE(4) }, 5.1);
  check(bs.state.n === 9, 'the newest state is the truth (an older one that comes late is ignored)');
  check(bs.fresh(8) && !bs.fresh(20), 'a state is fresh for a few seconds');
  check(sameReading('[Boss]: burn them all', '[Boss]: Burn them all.') && !sameReading('hello world', 'something quite different') && !sameReading('', 'x'), 'sameReading: the same words with other marks are the same');
}
