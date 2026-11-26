// The reading of a restricted chat with the numbers of the addon (docs/HANDOFF.md 4-0h): the lines "@RT" (the number t of every censored message of the chat window) and the state line with
// the count t and the session. The bars are counted from the bottom; the base number is the one for which every line in the window falls on a red bar (pictures made by the test).
import { check, eq } from './helpers.mjs';
const { parseState, regionOf } = await import('../app/core/ocr_state.js');
const { BarScan } = await import('../app/core/ocr_scan.js');

const client = { width: 1920, height: 1080 };
const STATE = (n, t, session, scroll = 0) => `2,${n},34,190,426,188,-6,40,6,12,17,14,${scroll},1920,1080,${t},${session}`;
const REGION = regionOf(parseState(STATE(1, 100, 7)), client);
const W = 460, H = 188, L = 34, CW = 426, P = 17, F = 14;

// a picture of the window: messages from the bottom up (kind R / G, rows), a bar at the first row of each
function scene(messages) {
  const px = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = 20; px[i * 4 + 1] = 14; px[i * 4 + 2] = 14; px[i * 4 + 3] = 255; }
  const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; px[o] = b; px[o + 1] = g; px[o + 2] = r; };
  let k = 0;
  for (const m of messages) {
    const rowsTop = [];
    for (let j = 0; j < m.rows; j++) rowsTop.push(H - ((k + m.rows - 1 - j) * P + F));
    k += m.rows;
    rowsTop.forEach((top, j) => {
      for (let y = top; y < top + F; y++) for (let x = L + (j ? 12 : 0); x < L + CW - 20 - (m.cut || 0); x++) {
        const hit = ((x * 7 + y * 13 + (m.seed || 1) * 31 + j * 5) % 11) < 4;
        if (hit && y >= 0 && y < H) put(x, y, 230, m.kind === 'R' ? 40 : 230, 40);
      }
    });
    const first = rowsTop[0];
    for (let y = first + 1; y < first + 13; y++) for (let x = L - 17; x < L - 11; x++) if (y >= 0 && y < H) put(x, y, m.kind === 'R' ? 255 : 0, m.kind === 'R' ? 0 : 255, 0);
  }
  return { px, width: W, height: H };
}
const msgs = (spec, shift = 0) => spec.map((s, i) => {                                                // 'R2' = restricted, 2 rows; bottom first (shift: another look of the strokes); 'R1#17' = the message with the look number 17 (it keeps its look when it goes up)
  const [kr, id] = s.split('#'), rows = Number(kr.slice(1)) || 1;
  return id === undefined ? { kind: kr[0], rows, seed: (i * 5 + 3 + shift) % 17 + 1, cut: (((i * 3) + shift) % 8) * 40 } : { kind: kr[0], rows, seed: Number(id) * 7 % 29 + 1, cut: (Number(id) * 3 % 9) * 36 };
});
const rt = (bs, t, now, id = t) => bs.onLine({ id, channel: '@RT', text: String(t) }, now);
const setup = (t = 100, session = 7, opts = {}) => { const bs = new BarScan(opts); bs.onLine({ channel: '@CS', text: STATE(1, t, session) }, 0); return bs; };

// ---- the way is chosen by the state line; the lines are numbers
{
  const bs = new BarScan();
  check(!bs.useT(), 'no state yet: the numbers are not used');
  bs.onLine({ channel: '@CS', text: '1,1,1,34,190,426,188,0,-6,40,6,12,17,14,0,1920,1080,2,2,128,16,98,14' }, 0);
  check(!bs.useT(), 'a state without the count (an older addon): the ledger way');
  bs.onLine({ channel: '@CS', text: STATE(2, 100, 7) }, 1);
  check(bs.useT() && bs.session === 7, 'a state with the count: the numbers way, the session is kept');
  const e = rt(bs, 96, 2);
  check(e && e.seq === 96 && e.kind === 'R' && bs.rt.length === 1 && bs.sessionSeq === 95, 'the first "@RT" line of a restriction begins a reading: the messages before it are not read');
  check(rt(bs, 96, 2.1) === null && rt(bs, 90, 2.2) === null && bs.rt.length === 1, 'a number that is not new (the same line again, or a few below) is nothing');
  rt(bs, 98, 3); rt(bs, 100, 4);
  eq(bs.rt.map(x => x.seq), [96, 98, 100], 'the lines are kept in order');
  check(bs.onLine({ id: 1, channel: '@RT', text: 'x' }, 5) === null, 'a line that is no number is nothing');
}

// ---- the bars are counted from the bottom: every red bar gets its number, jobs for the ones whose lines have come
{
  const bs = setup();
  [96, 98, 100].forEach(t => rt(bs, t, 10));
  // from the bottom: 100 R (1 row), 99 G, 98 R (2 rows), 97 G, 96 R
  const pic = scene(msgs(['R1', 'G1', 'R2', 'G1', 'R1']));
  let r = bs.scan(pic, REGION, 10.1);
  check(r.status === 'ok' && r.paired === 3 && r.debug.base === 100 && r.jobs.length === 0, 'the first picture: all three lines on red bars, base 100, not read yet (nothing to lead the numbers from, so the picture has to be the same twice): ' + JSON.stringify(r.debug));
  r = bs.scan(pic, REGION, 10.2);
  eq(r.jobs.map(j => j.seq).sort((a, b) => a - b), [96, 98, 100], 'the same picture a moment later: the pictures show that nothing came, the numbers go on from the scan before: the three messages are read at once, with their numbers');
  check(r.jobs.every(j => j.why === 'sight') && r.debug.trust === true, 'read at the first sight (why "sight")');
  eq(r.jobs.map(j => [j.seq, j.geo.rows]).sort((a, b) => a[0] - b[0]), [[96, 1], [98, 2], [100, 1]], 'the rows of each message come from the bars (the one of 98 has two rows)');
  bs.onRead(96, 'a', 11); bs.onRead(98, 'b', 11); bs.onRead(100, 'c', 11);
  eq(bs.collect(11.5).done.map(x => x.text), ['a', 'b', 'c'], 'shown in the order of the numbers');
}

// ---- the addon was loaded again (a new session): its state lines are taken from the first one, whatever their n is; the numbers t start again
{
  const bs = new BarScan();
  for (let n = 1; n <= 13; n++) bs.onLine({ channel: '@CS', text: STATE(n, n, 111) }, 100 + n * 2);
  bs.onLine({ channel: '@RT', text: '12', id: 1 }, 130);
  check(bs.state.n === 13 && bs.session === 111 && bs.rt.length === 1, 'the old addon: n 13, one message told');
  bs.onLine({ channel: '@CS', text: STATE(1, 3, 222) }, 2900);
  check(bs.state.n === 1 && bs.session === 222 && bs.fresh(2900) && bs.rt.length === 0, 'a new session: its first state line (n 1) is taken at once, the numbers of the old one are forgotten: n ' + bs.state.n);
  bs.onLine({ channel: '@RT', text: '4', id: 2 }, 2901);
  check(bs.rt.length === 1 && bs.rt[0].seq === 4, 'and its message 4 (lower than the old 12) counts');
  bs.onLine({ channel: '@CS', text: STATE(1, 3, 222) }, 2902);
  bs.onLine({ channel: '@CS', text: STATE(5, 5, 222) }, 2904);
  bs.onLine({ channel: '@CS', text: STATE(3, 4, 222) }, 2905);
  check(bs.state.n === 5, 'in one session a line with a lower n (that came late) is still an old one: n ' + bs.state.n);
  // a state of an older addon (no session) is replaced by the first one that has a session
  const old = new BarScan();
  old.onLine({ channel: '@CS', text: '1,30,1,34,190,426,188,0,-6,40,6,12,17,14,0,1920,1080,2,2,128,16,98,14' }, 10);
  old.onLine({ channel: '@CS', text: STATE(2, 1, 333) }, 20);
  check(old.state.n === 2 && old.session === 333, 'an older addon without a session: the state of the first addon with a session is taken');
}

// ---- the picture is ahead of the lines: a red bar whose line has not come yet waits, and is read when it has come
{
  const bs = setup();
  [96, 98].forEach(t => rt(bs, t, 10));
  const pic = scene(msgs(['R1', 'G1', 'R2', 'G1', 'R1']));                    // the newest message (100) is drawn, its line has not come
  let r = bs.scan(pic, REGION, 10.1);
  check(r.debug.base === 100 && r.debug.matched === 2 && r.debug.pending === 1 && r.debug.lost === 0, 'the base is 100 (not 98): the fewest red bars without a line that is lost: ' + JSON.stringify(r.debug));
  r = bs.scan(pic, REGION, 10.4);
  eq(r.jobs.map(j => j.seq).sort((a, b) => a - b), [96, 98], 'only the messages with a line are read: the colour of the other is not confirmed');
  rt(bs, 100, 10.6);
  r = bs.scan(pic, REGION, 10.7);
  eq(r.jobs.map(j => j.seq), [100], 'the line comes: the message is read then');
}

// ---- the bars are not where the lines say: the picture does not fit, nothing is read (the lines are old enough that they are not "about to be drawn")
{
  const bs = setup();
  [96, 98, 100].forEach(t => rt(bs, t, 10));
  // red where the lines say green and the other way round
  const pic = scene(msgs(['R1', 'R1', 'G2', 'G1', 'R1']));
  let r = bs.scan(pic, REGION, 12);
  check(r.status === 'mismatch' && r.jobs.length === 0, 'the red bars are not where the lines say: a mismatch, nothing is read: ' + JSON.stringify(r.debug));
  r = bs.scan(pic, REGION, 12.3);
  check(r.jobs.length === 0, 'and still nothing a moment later');
  const good = scene(msgs(['R1', 'G1', 'R2', 'G1', 'R1']));
  bs.scan(good, REGION, 12.5);
  r = bs.scan(good, REGION, 12.8);
  check(r.status === 'ok' && r.jobs.length === 3, 'the right picture: read');
}

// ---- red bars whose lines have not come: a few, and while the newest line is fresh
{
  const bs = setup();
  [98, 100].forEach(t => rt(bs, t, 10));
  // from the bottom: 104 R, 103 R, 102 G, 101 G, 100 R, 99 G, 98 R (the lines of 98 and 100 have come; 103 and 104 are drawn, their lines are a moment behind)
  const pic = scene(msgs(['R1', 'R1', 'G1', 'G1', 'R1', 'G1', 'R1']));
  let r = bs.scan(pic, REGION, 10.2);
  check(r.status === 'ok' && r.debug.base === 104 && r.debug.pending === 2 && r.debug.matched === 2, 'two messages came after the newest line: they wait for their lines: ' + JSON.stringify(r.debug));
  r = bs.scan(pic, REGION, 10.5);
  eq(r.jobs.map(j => j.seq).sort((a, b) => a - b), [98, 100], 'only the messages with a line are read');
  r = bs.scan(pic, REGION, 13);
  check(r.status === 'ok' && r.debug.base === 104 && r.debug.pending === 2, 'three seconds later they still have no line: nothing in the pictures changed, so the numbers stay (their lines were lost; they are not read): ' + JSON.stringify(r.debug));
  rt(bs, 103, 13.1); rt(bs, 104, 13.1);
  r = bs.scan(pic, REGION, 13.2);
  check(r.status === 'ok' && r.paired === 4 && r.debug.base === 104, 'their lines come: they fit');
}

// ---- the reading begins in the middle of a restriction: the red bars that are older than the first line are not paired with the newest lines (a user's log: the lines of the first two messages
// were not there; the line of the third was paired with the oldest red bar, the newest two bars waited for lines that never came, and every message was read two numbers off)
{
  const bs = setup(100, 7);
  bs.onLine({ channel: '@CS', text: STATE(2, 8, 7) }, 0.5);                        // (the count in the state line: 8)
  rt(bs, 9, 10);                                                                   // the line of the third red message; the lines of 7 and 8 never came
  // from the bottom: 9 R, 8 R, 7 R (2 rows), then three readable messages
  let pic = scene(msgs(['R1', 'R1', 'R2', 'G2', 'G1', 'G1']));
  let r = bs.scan(pic, REGION, 10.1);
  check(r.debug.base === 9 && r.debug.pending === 0 && r.debug.before === 2 && r.debug.matched === 1, 'the line of 9 is for the bottom bar; the two red bars above are older than the first line: ' + JSON.stringify(r.debug));
  r = bs.scan(pic, REGION, 10.4);
  check(r.jobs.length === 1 && r.jobs[0].seq === 9 && r.jobs[0].geo.rows === 1, 'only the bottom message (one row) is read as 9, not the message of two rows above it: ' + JSON.stringify(r.jobs.map(j => [j.seq, j.geo.rows])));
  // the next message comes (10): a bar is added at the bottom, the older ones go up one
  bs.onLine({ channel: '@CS', text: STATE(3, 9, 7) }, 14);
  rt(bs, 10, 14);
  pic = scene(msgs(['R1', 'R1', 'R1', 'R2', 'G2', 'G1']));
  r = bs.scan(pic, REGION, 14.1);
  check(r.debug.base === 10 && r.debug.pending === 0 && r.debug.matched === 2, 'with the next line the base is 10 (the world with two waiting bars, 12, does not win): ' + JSON.stringify(r.debug));
  r = bs.scan(pic, REGION, 14.4);
  check(r.jobs.length === 1 && r.jobs[0].seq === 10 && r.jobs[0].geo.rows === 1, 'the new message is read as 10');
}

// ---- the count in the state line is a lower bound for the base: the picture is never older than a state line that came before it
{
  const bs = setup(100, 7);
  [96, 98].forEach(t => rt(bs, t, 10));
  const pic = scene(msgs(['R1', 'G1', 'R2', 'G1', 'R1']));                      // the pattern repeats every two bars: 96 and 98 fit the red bars two places lower too
  const r = bs.scan(pic, REGION, 10.1);
  check(r.debug.base === 100, 'the state says 100: a base of 98, which would also fit, is not taken: ' + JSON.stringify(r.debug));
}

// ---- the older way has read the messages whose lines came up to a time: the way with the numbers does not read them again
{
  const bs = setup();
  rt(bs, 90, 1); rt(bs, 91, 2); rt(bs, 92, 3);
  bs.handledUntil(2.4);
  check(bs.sessionSeq === 91 && bs.releasePtr === 91, 'the lines that came up to the time are handled: ' + bs.sessionSeq);
  rt(bs, 93, 4);
  bs.handledUntil(1);
  check(bs.sessionSeq === 91, 'an earlier time does not take anything back');
  const old = new BarScan();
  old.handledUntil(5);
  check(old.sessionSeq === 0, 'without the numbers nothing happens');
}

// ---- a message that went up out of the window unread is missed, told when it has been so for a moment
{
  const bs = setup();
  [96, 98, 100].forEach(t => rt(bs, t, 10));
  const pic = scene(msgs(['R1', 'G1', 'R2', 'G1']));                         // 97..100 are in the window, 96 is above it
  let r = bs.scan(pic, REGION, 10.1);
  check(r.missed === 0 && r.paired === 2, '96 is above the window, but not for long enough yet: not told');
  r = bs.scan(pic, REGION, 10.5);
  check(r.missed === 1, '96 went up out of the window unread: missed, counted exactly');
  r = bs.scan(pic, REGION, 10.9);
  check(r.missed === 0, 'told once');
}

// ---- the session changes (the addon was loaded again): the numbers start again
{
  const bs = setup(100, 7);
  rt(bs, 100, 10);
  bs.onLine({ channel: '@CS', text: STATE(2, 4, 8) }, 11);
  check(bs.rt.length === 0 && bs.session === 8 && bs.stats.sessions === 1, 'another session: the lines of the old numbers are gone');
  rt(bs, 3, 12); rt(bs, 4, 12.1);
  eq(bs.rt.map(x => x.seq), [3, 4], 'the new numbers are taken');
  // when the state line did not come (or a lost one): numbers far below the last are a new session too
  rt(bs, 200, 13);
  rt(bs, 2, 14);
  check(bs.stats.sessions === 2 && bs.rt.length === 1 && bs.rt[0].seq === 2, 'a number far below the last one: the numbers started again');
}

// ---- a pause of a restriction: the reading begins again, "@RS" ends it
{
  const bs = setup();
  rt(bs, 50, 1);
  check(bs.sessionSeq === 49, 'the first line begins the reading');
  rt(bs, 51, 5);
  check(bs.sessionSeq === 49, 'a line a few seconds later goes on');
  rt(bs, 60, 100);
  check(bs.sessionSeq === 59 && bs.records.size === 0, 'a line after a long pause begins a new reading: the older ones are not read');
  bs.onLine({ channel: '@RS', text: 'chat restriction lifted' }, 101);
  rt(bs, 61, 102);
  check(bs.sessionSeq === 60, 'after the end of a restriction the next line begins a new reading at once');
}

// ---- scrolled up: nothing is read
{
  const bs = setup();
  rt(bs, 100, 10);
  bs.onLine({ channel: '@CS', text: STATE(2, 100, 7, 3) }, 10.5);
  const r = bs.scan(scene(msgs(['R1', 'G1'])), REGION, 10.6);
  check(r.status === 'scrolled' && r.jobs.length === 0, 'the chat is scrolled up: the numbers do not count from the bottom, nothing is read');
}

// ---- nothing red, or no line yet: nothing to do, not a mismatch
{
  const bs = setup();
  let r = bs.scan(scene(msgs(['R1', 'G1', 'G1'])), REGION, 1);
  check(r.status === 'ok' && r.jobs.length === 0 && r.paired === 0, 'a red bar while no line has come at all: wait');
  rt(bs, 100, 2);
  r = bs.scan(scene(msgs(['G1', 'G1', 'G1'])), REGION, 2.1);
  check(r.status === 'ok' && r.jobs.length === 0, 'no red bar: nothing to read');
}

// ---- a bar cut at the top edge is counted but not read
{
  const bs = setup();
  [99, 100].forEach(t => rt(bs, t, 10));
  const many = msgs(['R1', 'R1', ...Array(9).fill('G1')]);               // 11 messages fill the window
  const pic = scene(many);
  bs.scan(pic, REGION, 10.1);
  const r = bs.scan(pic, REGION, 10.4);
  eq(r.jobs.map(j => j.seq).sort((a, b) => a - b), [99, 100], 'the numbers of the two newest messages are right in a full window');
}

// ---- what the log tells about the delay: why a message was read when it was, and what made its picture "not the same"
{
  const bs = setup();
  [96, 98, 100].forEach(t => rt(bs, t, 10));
  const pic = scene(msgs(['R1', 'G1', 'R2', 'G1', 'R1']));
  bs.scan(pic, REGION, 10.1);
  let r = bs.scan(pic, REGION, 10.4);
  check(r.jobs.length === 3 && r.jobs.every(j => j.why === 'sight' && j.firstSeen === 10.1 && j.rtAt === 10), 'the second picture: read at the first sight, with the time the message was first seen and when its line came');
  check(Array.isArray(r.notes) && r.notes.length === 0, 'nothing changed: no notes');
}
{
  // the picture keeps changing (a moving background, say): the message is read at the longest wait, and the notes say that the strokes were not the same
  const bs = setup();
  rt(bs, 100, 10);
  let r, jobs = [];
  const notes = [];
  for (let k = 0; k < 9; k++) { r = bs.scan(scene(msgs(['R1'], k)), REGION, 10.1 + k * 0.3); notes.push(...r.notes); jobs.push(...r.jobs); }
  check(jobs.length === 1 && jobs[0].why === 'max', 'a picture that is never the same twice is read after the longest wait: ' + JSON.stringify(jobs.map(j => j.why)));
  check(notes.length === 3 && notes.every(n => n.kind === 'sig' && n.dist >= 0.05), 'the log hears about the first changes (three at most): ' + JSON.stringify(notes));
}
{
  // the rows from the bars changed: told as that
  const bs = setup();
  [98, 100].forEach(t => rt(bs, t, 10));
  bs.scan(scene(msgs(['R1', 'G1', 'R1'])), REGION, 10.1);
  const r = bs.scan(scene(msgs(['R1', 'G1', 'R2'])), REGION, 10.4);
  check(r.notes.some(n => n.seq === 98 && n.kind === 'rows' && n.from === 1 && n.to === 2), 'a message that has another number of rows: told as rows: ' + JSON.stringify(r.notes));
}

// ---- the numbers go on from the scan before: a message that has just come, its line late (a user's log: in a window full of red bars the new bar was given the number of the newest line)
{
  const bs = setup(44, 7);
  for (let n = 36; n <= 44; n++) rt(bs, n, 10);
  const ids = n => `R1#${n}`;
  const win = top => Array.from({ length: 9 }, (_, i) => ids(top - i));                // from the bottom: top, top-1, ...
  let r = bs.scan(scene(msgs(win(44))), REGION, 10.1);
  check(r.jobs.length === 0 && r.debug.base === 44 && r.debug.trust === false, 'the first picture: no scan before, nothing is read yet');
  r = bs.scan(scene(msgs(win(44))), REGION, 10.2);
  check(r.jobs.length === 9 && r.jobs.every(j => j.why === 'sight') && r.debug.trust === true, 'the second picture: the pictures are the same, the numbers go on, the nine are read at once');
  for (let n = 36; n <= 44; n++) bs.onRead(n, 'm' + n, 11);
  // a message (45) comes, the top one goes up out of the window; its line has not come, and the newest line is old
  r = bs.scan(scene(msgs(win(45))), REGION, 12);
  check(r.status === 'ok' && r.debug.base === 45 && r.debug.pending === 1 && r.debug.trust === true && r.jobs.length === 0, 'the new bar waits for its line (base 45), it is not given the number of the newest line: ' + JSON.stringify(r.debug));
  rt(bs, 45, 12.3);
  r = bs.scan(scene(msgs(win(45))), REGION, 12.4);
  check(r.debug.base === 45 && r.debug.pending === 0 && r.jobs.length === 1 && r.jobs[0].seq === 45 && r.jobs[0].why === 'sight', 'its line comes: it is read at once as 45');
  check(r.lags.length === 1 && r.lags[0].seq === 45 && Math.abs(r.lags[0].lag - 0.3) < 1e-6, 'and the log hears how late the line was: ' + JSON.stringify(r.lags));
}
{
  // two messages come together (44 of one row, 45 of two rows); the line of 44 has come, that of 45 has not: 44 is read as 44, the picture of the bottom message (45) is not
  const bs = setup(43, 7);
  for (let n = 36; n <= 43; n++) rt(bs, n, 10);
  const win = (top, rows) => Array.from({ length: top - 34 }, (_, i) => `R${rows[top - i] || 1}#${top - i}`).slice(0, 8);
  let r = bs.scan(scene(msgs(win(43, {}))), REGION, 10.1);
  r = bs.scan(scene(msgs(win(43, {}))), REGION, 10.2);
  for (let n = 36; n <= 43; n++) bs.onRead(n, 'm' + n, 11);
  rt(bs, 44, 12);
  r = bs.scan(scene(msgs(win(45, { 45: 2 }))), REGION, 12.1);
  check(r.debug.base === 45 && r.debug.pending === 1 && r.jobs.length === 1 && r.jobs[0].seq === 44 && r.jobs[0].geo.rows === 1, 'the message of one row is read as 44 (not the one of two rows at the bottom): ' + JSON.stringify([r.debug, r.jobs.map(j => [j.seq, j.geo.rows])]));
}
{
  // the scan before is old (a long time ago): nothing leads the numbers, so a message that has come since is read only when its picture has been the same twice
  const bs = setup(100, 7);
  rt(bs, 100, 10);
  let r = bs.scan(scene(msgs(['R1#5'])), REGION, 10.1);
  r = bs.scan(scene(msgs(['R1#5'])), REGION, 10.2);
  check(r.jobs.length === 1 && r.jobs[0].seq === 100, 'the first message is read');
  bs.onRead(100, 'a', 10.5);
  rt(bs, 101, 14);
  const pic = scene(msgs(['R1#8', 'R1#5']));
  r = bs.scan(pic, REGION, 14.0);
  check(r.jobs.length === 0 && r.debug.trust === false, 'the scan before is four seconds old: the new message is not read at the first sight: ' + JSON.stringify(r.debug));
  r = bs.scan(pic, REGION, 14.3);
  check(r.jobs.length === 1 && r.jobs[0].seq === 101, 'read when the picture is the same in the next one');
}
{
  // not led (the pictures do not fit the scan before: a bar is covered): the way as before, with the same picture twice
  const bs = setup(100, 7);
  rt(bs, 100, 10);
  let r = bs.scan(scene(msgs(['R1#5', 'G1#6', 'G1#7'])), REGION, 10.1);
  r = bs.scan(scene(msgs(['R1#9', 'G1#6', 'G1#7'])), REGION, 10.2);                // (the bottom picture changed and nothing else: no number of new messages fits)
  check(r.debug.trust === false && r.jobs.length === 0, 'the pictures do not fit the scan before: not read at the first sight');
}
