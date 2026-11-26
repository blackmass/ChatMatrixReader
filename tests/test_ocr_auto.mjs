// The OCR that reads by itself (core/ocr_auto.js): which lines of a picture are new, which are in the chat already, when the reading is on.
import { check, eq } from './helpers.mjs';
const A = await import('../app/core/ocr_auto.js');
const { findLines, groupLines } = await import('../app/core/ocr_lines.js');

// a chat picture (BGRA): each line has its own pattern of strokes (its "text"), 12 rows high, 18 rows apart; a scene noise behind when asked
// a line's own text: strokes laid out by a hash of (line, place), with a density that differs from one part of the width to the next (the words and the gaps of a line)
const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const stroke = (pat, x, w) => (x < 9 ? x % 2 === 1 : false) || (x >= 9 && hash(pat * 7 + 1, x) < 0.4 + 0.4 * hash(pat, Math.floor(x * 32 / w) + 100));
function chat(lines, { h = 120, w = 300, noise = 0, seed = 1, ink = 240 } = {}) {
  const px = new Uint8Array(w * h * 4);
  let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < w * h; i++) { const n = noise ? Math.round(rnd() * noise) : 0; px[i * 4] = 14 + n; px[i * 4 + 1] = 10 + n; px[i * 4 + 2] = 10 + n; px[i * 4 + 3] = 255; }
  lines.forEach((pat, i) => { const top = 6 + i * 18; for (let y = top; y < top + 12; y++) for (let x = 5; x < w - 5; x++) if (stroke(pat, x, w)) { const o = (y * w + x) * 4; px[o] = px[o + 1] = px[o + 2] = ink; } });
  return { px, width: w, height: h };
}
const sigs = pic => groupLines(findLines(pic.px, pic.width, pic.height)).filter(m => !m.continued && !m.cutTop && !m.cutBottom).map(m => A.signatureOf(pic, m.coreTop, m.coreBottom));

{
  const p1 = chat([3, 7, 11, 13, 17]), p2 = chat([7, 11, 13, 17, 19]), p3 = chat([3, 7, 11, 13, 17]);
  const s1 = sigs(p1), s2 = sigs(p2), s3 = sigs(p3);
  check(s1.length === 5 && s2.length === 5, 'the test pictures have five lines each: ' + s1.length + ' ' + s2.length);
  eq(A.alignedCount(s1, s2), 4, 'the chat scrolled up by one line: four lines are the same, one is new');
  eq(A.alignedCount(s1, s3), 5, 'the same picture again: nothing is new');
  eq(A.alignedCount(s1, sigs(chat([19, 23, 29, 31, 37]))), 0, 'nothing in common: all new');
  eq(A.alignedCount([], s1), 0, 'no last picture: all new');
  eq(A.alignedCount(s1, sigs(chat([7, 11, 13, 17, 19, 23, 29]))), 4, 'three new lines at once (the end of the old ones is the beginning of the new): ' + A.alignedCount(s1, sigs(chat([7, 11, 13, 17, 19, 23, 29]))));
}
{
  const n1 = sigs(chat([3, 7, 11, 13], { noise: 40, seed: 5 })), n2 = sigs(chat([3, 7, 11, 13], { noise: 40, seed: 99 }));
  check(A.alignedCount(n1, n2) >= 3, 'a see-through chat over a moving scene is still the same line: ' + A.alignedCount(n1, n2));
}
// the lines the addon gave a moment ago: used up by the first twin on the screen, only for a short time; what the screen gave is never kept
{
  const r = new A.Recent();
  r.add('LF2M tank and healer for +12', 100); r.add('안녕하세요 반갑습니다 여러분', 100); r.add('ty', 100);
  check(r.take('[17:08:44] [Bob]: LF2M tank and healer for +12', 101) && r.take('17:08:44 [받은귓말] [Kal]: 안녕하세요 반갑습니다 여러분', 101), 'a line the addon gave is found on the screen whatever the time, the front, the case and the marks are');
  check(!r.take('LF2M tank and healer for +12', 102) && !r.take('안녕하세요 반갑습니다 여러분', 102), 'and it is used up: the same words read again are a new line (a boss that says it again, a message sent twice)');
  check(!r.take('LF2M tank only', 102) && !r.take('완전히 다른 말입니다 정말로', 102), 'another line is not a twin');
  check(r.take('', 102) && r.take('[1] [Bob]: ', 102) && r.take('!!', 102), 'a line with nothing to show is "taken" (it is not shown)');
  check(!r.take('t y u', 102) && r.take('ty', 102), 'a short line is a twin only when it is equal (it would match anything)');
  const t = new A.Recent(); t.add('the boss says burn them all now', 100);
  check(!t.take('the boss says burn them all now', 100 + A.TTL + 1), 'an old line of the addon does not wait for ever: after that time the same words are a new line');
  const r2 = new A.Recent(); r2.add('ok thanks', 100); r2.add('see you at the dungeon entrance', 100);
  check(!r2.take('ok thanks a lot', 101) && r2.take('see you at the dungeon entranc', 101) && !r2.take('see you at the dungeon entrance tonight at eight', 101), 'a line that only holds an older one is new; the same line with its end cut is a twin');
  const small = new A.Recent(2); small.add('aaaaaaaa one', 100); small.add('bbbbbbbb two', 100); small.add('cccccccc three', 100);
  check(!small.take('aaaaaaaa one', 101) && small.take('cccccccc three', 101), 'the oldest are forgotten');
}
// when it is on
{
  const w = new A.Watch();
  check(!w.on(0), 'without a restricted line it is not on');
  w.restricted(10); w.restricted(11);
  check(w.on(11) && w.on(40) && !w.on(41.5) && w.pending === 2, 'on for 30 seconds from the last restricted line; the lines waiting are counted');
  w.ended(20);
  check(w.on(23.9) && !w.on(24.1), 'the end line of the addon: a few more seconds for a last look, then off');
  check(w.idle(100) && w.pending === 0, 'idle forgets the lines waiting');
  for (let i = 0; i < 20; i++) w.restricted(200);
  check(w.pending === 8, 'the lines waiting are counted up to 8');
}

// pictures to trust (judge / steady / alike)
{
  const base = sigs(chat([3, 7, 11, 13, 17]));
  const scrolled = sigs(chat([7, 11, 13, 17, 19]));
  const covered = sigs(chat([3, 7, 41, 43, 47]));                         // (the lower lines have other letters over them: a tooltip)
  const bigger = sigs(chat([3, 7, 11, 13, 17, 19, 23], { h: 150 }));
  eq(A.judge(base, scrolled, 1), { ok: true, first: 4, n: 1 }, 'judge: one new line, one could have come: trusted');
  check(A.judge(base, base, 0).ok && A.judge(base, base, 0).n === 0, 'judge: the same picture is trusted');
  check(!A.judge(base, scrolled, 0).ok, 'judge: a new line when none could have come is not trusted');
  check(!A.judge(base, covered, 1).ok && !A.judge(base, covered, 2).ok, 'judge: lines that changed where they were (a tooltip over the chat) are not trusted: ' + JSON.stringify(A.judge(base, covered, 2)));
  check(A.judge(base, bigger, 2).ok && A.judge(base, bigger, 2).n === 2, 'judge: a window with room for more lines shows the same lines and new ones below: ' + JSON.stringify(A.judge(base, bigger, 2)));
  check(A.steady(base, sigs(chat([3, 7, 11, 13, 17]))) && !A.steady(base, scrolled) && !A.steady(null, base), 'steady: the same twice, not otherwise');
  check(A.alike('lfgraidtonight', 'Ifgraidtonight'.toLowerCase()) >= 0.88 && A.alike('abcdefghijkl', 'xyzuvwqrstop') < 0.2 && A.alike('a', 'a') === 1, 'alike: a few letters read wrong is still the same line');
  const r = new A.Recent(); r.add('anyone for 44 group sometime', 10);
  check(r.take('[1] [Fart]: anyone for [44+] gr0up sometime', 11) || r.take('anyone for 44 gr0up sometime', 11), 'a line read with a letter wrong is still the twin');
}

// ---- the whole of it (ocr_host.js) with a fake game window, a fake reader and a fake chat
{
  const { startOcr } = await import('../app/ocr_host.js');
  const { DEFAULTS } = await import('../app/core/config.js');
  const { log } = await import('../app/core/log.js'); log.quiet = true;
  const cfg = { ...structuredClone(DEFAULTS), ocr_enabled: true, ocr_when: 'ondemand', ocr_read: 'ai', ocr_region: { x: 0, y: 0, w: 300, h: 120, gw: 300, gh: 120 } };
  const settings = { cfg: () => cfg };
  let clock = 1000, pics = [], watchers = [], gameUp = true;
  const notes = [], shown = [];
  let readN = 0, said = {};
  const ocr = startOcr({ oldWay: true,
    settings, tickMs: 0, now: () => clock, system: t => notes.push(t), listen: null, emit: null, http: null,
    capture: { clientSize: () => (gameUp ? { width: 300, height: 120 } : null), grabClient: async () => pics.shift() },
    pipeline: { observe: fn => watchers.push(fn), onLine: line => { shown.push(line.text); return []; } },
    publish: () => {},
    encode: pic => ({ mime: 'image/png', base64: String(pic.height) }),
    reader: { read: async () => { readN++; return said.next || `say${readN}zz`; } },
  });
  const see = (channel, text) => watchers.forEach(fn => fn({ channel, text, sender: '' }));
  const tick = async pic => { pics = [pic]; await ocr.tick(); };
  const P1 = chat([3, 7, 11, 13, 17]), P2 = chat([7, 11, 13, 17, 19]);

  await tick(P1);
  check(shown.length === 0 && pics.length === 1, 'the chat is not restricted: nothing is looked at');
  see('G', '[restricted]'); see('G', '[restricted]');
  await tick(P1);
  check(shown.length === 0 && notes.length === 1 && /제한/.test(notes[0]), 'restricted: the first picture is not read yet, it is trusted when the next one is the same');
  await tick(chat([3, 7, 11, 13, 17]));
  check(shown.length === 2, 'the same twice: the last two lines are read (as many as lines the addon could not give): ' + JSON.stringify(shown));
  see('G', '[restricted]');
  await tick(P2);
  check(shown.length === 3, 'the chat scrolled by one line: only the new one is read: ' + shown.length);
  await tick(chat([7, 11, 13, 17, 19]));
  check(shown.length === 3, 'the same picture: nothing is read again');

  // something over the chat: not read, not kept, and when it goes away no line is read twice
  see('G', 'another line of the chat'); 
  await tick(chat([7, 11, 41, 43, 47]));
  check(shown.length === 3, 'a tooltip over the lower lines: nothing is read from the picture');
  await tick(chat([7, 11, 41, 43, 47]));
  check(shown.length === 3, 'it stays: still nothing');
  await tick(chat([7, 11, 13, 17, 19]));
  check(shown.length === 3, 'it goes away: the chat is as it was, nothing is read twice: ' + shown.length);
  see('G', '[restricted]'); see('G', '[restricted]'); see('G', '[restricted]');
  await tick(chat([17, 19, 23, 29, 31]));
  check(shown.length === 6, 'three new lines come at once, three lines came: all three are read: ' + shown.length);

  // more new lines than could have come: not trusted
  await tick(chat([37, 41, 43, 47, 53]));
  check(shown.length === 6, 'five new lines when none came: not trusted, not read');
  // the chat looks different for good (a bigger window, ...): after a while the picture to compare with is made again, nothing is read from it
  for (let i = 0; i < 8; i++) await tick(chat([37, 41, 43, 47, 53]));
  check(shown.length === 6, 'a picture that is different but steady: nothing read while it is made the picture to compare with');
  see('G', '[restricted]');
  await tick(chat([41, 43, 47, 53, 59]));
  check(shown.length === 7, 'and then new lines are read again: ' + shown.length);

  said = {}; see('@RS', ''); clock += 5;
  await tick(chat([43, 47, 53, 59, 61]));
  check(notes.at(-1) && /마쳤/.test(notes.at(-1)), 'the end line and a few seconds: the reading is over, it says so');
  cfg.ocr_enabled = false; pics = [chat([5, 9])]; await ocr.tick();
  check(pics.length === 1, 'OCR off: nothing is looked at');
  // no game window: nothing is looked at, nothing is said; the same when the window is back
  cfg.ocr_enabled = true; gameUp = false; clock += 120; see('G', '[restricted]');
  const notesBefore = notes.length;
  pics = [chat([3, 7, 11])]; await ocr.tick(); await ocr.tick();
  check(pics.length === 1 && notes.length === notesBefore, 'the game is not running: the OCR waits, no notice');
  gameUp = true; shown.length = 0;
  await tick(chat([3, 7, 11])); await tick(chat([3, 7, 11]));
  check(shown.length === 1, 'the window is back: it starts again by itself, and reads the one line that is waiting: ' + shown.length);
  // a reading that starts with a chat that has no line (faded away), and then it shows five lines: they are read as the first lines of a reading, not thrown away for being too many
  gameUp = false; await ocr.tick(); gameUp = true;                       // (a new reading)
  shown.length = 0; said = {}; readN = 500; for (let i = 0; i < 5; i++) see('G', '[restricted]');
  await tick(chat([])); await tick(chat([]));
  await tick(chat([41, 43, 47, 53, 59])); await tick(chat([41, 43, 47, 53, 59]));
  check(shown.length === 5, 'a chat that was empty and shows five lines: after two steady pictures all five are read: ' + shown.length);
  ocr.stop();
}

// a picture with no line while there were lines: the chat faded away or is covered: not trusted
{
  const base = sigs(chat([3, 7, 11, 13, 17]));
  check(!A.judge(base, [], 4).ok && A.judge([], [], 4).ok && A.judge([], sigs(chat([3, 7])), 4).ok, 'judge: no line at all after lines is not trusted; an empty chat after an empty chat is');
}

// ---- the same words again: a boss says it every time, the line must be shown every time; only the addon's own twin on the screen is hidden (once)
{
  const { startOcr } = await import('../app/ocr_host.js');
  const { DEFAULTS } = await import('../app/core/config.js');
  const cfg = { ...structuredClone(DEFAULTS), ocr_enabled: true, ocr_when: 'resident', ocr_read: 'ai', ocr_region: { x: 0, y: 0, w: 300, h: 120, gw: 300, gh: 120 } };
  let clock = 5000, pics = [], watchers = [], reads = [];
  const shown = [];
  const ocr = startOcr({ oldWay: true,
    settings: { cfg: () => cfg }, tickMs: 0, now: () => clock, system: () => {}, listen: null, emit: null, http: null,
    capture: { clientSize: () => ({ width: 300, height: 120 }), grabClient: async () => pics.shift() },
    pipeline: { observe: fn => watchers.push(fn), onLine: line => { shown.push(line.text); return []; } },
    publish: () => {}, encode: pic => ({ mime: 'image/png', base64: '' }), reader: { read: async () => reads.shift() },
  });
  const see = (channel, text) => watchers.forEach(fn => fn({ channel, text, sender: '' }));
  const tick = async pic => { pics = [pic]; await ocr.tick(); };
  see('G', '[restricted]');
  await tick(chat([3, 7, 11])); reads = ['[Boss]: burn them all now']; await tick(chat([3, 7, 11]));
  check(shown.length === 1 && shown[0].includes('burn them all'), 'the boss line, read while the chat is restricted, is shown');
  clock += 300; see('G', '[restricted]');
  reads = ['[Boss]: burn them all now']; await tick(chat([7, 11, 13]));
  check(shown.length === 2, 'the boss says it again (a new run of the dungeon): shown again: ' + shown.length);
  see('G', 'the addon gives this line itself'); clock += 1;
  reads = ['[17:00:01] the addon gives this line itself']; await tick(chat([11, 13, 17]));
  check(shown.length === 2, 'a line the addon gave a moment ago is not shown a second time');
  see('G', 'the addon gives this line itself'); see('G', '[restricted]'); clock += 1;
  reads = ['the addon gives this line itself', 'the addon gives this line itself']; await tick(chat([17, 19, 23]));
  check(shown.length === 3, 'the addon gave it once more and the screen shows it twice: one twin is hidden, the other shown: ' + shown.length);
  ocr.stop();
}

// lines that go away at the top by themselves (the game lets the old ones fade), lines that come back at the top, a chat that fades all at once
{
  const full = sigs(chat([3, 7, 11, 13, 17]));
  const top3gone = [full[2], full[3], full[4], ...sigs(chat([19, 23]))];                   // (the first two lines are gone, two new ones below)
  eq(A.judge(full, top3gone, 2), { ok: true, first: 3, n: 2 }, 'judge: old lines fade away at the top while new ones come in below: trusted: ' + JSON.stringify(A.judge(full, top3gone, 2)));
  const justGone = [full[3], full[4]];
  eq(A.judge(full, justGone, 0), { ok: true, first: 2, n: 0 }, 'judge: only fading at the top, nothing new: trusted');
  eq(A.judge(justGone, full, 0), { ok: true, first: 5, n: 0 }, 'judge: the lines that were gone are there again at the top: no new line: trusted');
  const faded = sigs(chat([41, 43, 47, 53, 59]));
  check(!A.judge(full, faded, 2).ok, 'judge: every line of the chat is different at once (it is fading, or covered): not trusted');
  eq(A.judge(full, [...full.slice(1), full[0]], 1), { ok: true, first: 4, n: 1 }, 'judge: the newest line is found, what is below it is new: a line of old look below it counts as new');
}
// different lines of a real chat are told apart: the strokes of a line, not only its length (the test pictures are alike in the length of all lines)
{
  const a = sigs(chat([3, 7])), b = sigs(chat([3, 7]));
  check(A.same(a[0], b[0]) && A.same(a[1], b[1]) && !A.same(a[0], a[1]), 'the same line is the same, another line is not');
}

// a line that fades (the game dims the old lines) is still the same line; the strokes decide, not how strong they are
{
  const bright = sigs(chat([3, 7, 11, 13, 17])), dim = sigs(chat([3, 7, 11, 13, 17], { ink: 110 })), dimmer = sigs(chat([3, 7, 11, 13, 17], { ink: 70 }));
  check(bright.every((b, i) => A.same(b, dim[i]) && A.same(b, dimmer[i])), 'a faded line is the same line: ' + bright.map((b, i) => A.distance(b, dimmer[i]).toFixed(3)).join(' '));
  check(bright.every((b, i) => bright.every((c, j) => i === j || !A.same(b, c))), 'and the other lines are still other lines');
}
// the whole of it with the fading of the game: old lines go away at the top by themselves, the new line below is read
{
  const { startOcr } = await import('../app/ocr_host.js');
  const { DEFAULTS } = await import('../app/core/config.js');
  const cfg = { ...structuredClone(DEFAULTS), ocr_enabled: true, ocr_when: 'ondemand', ocr_read: 'ai', ocr_region: { x: 0, y: 0, w: 300, h: 120, gw: 300, gh: 120 } };
  let pics = [], reads = [];
  const shown = [], watchers = [];
  const ocr = startOcr({ oldWay: true,
    settings: { cfg: () => cfg }, tickMs: 0, now: () => 9000, system: () => {}, listen: null, emit: null, http: null,
    capture: { clientSize: () => ({ width: 300, height: 120 }), grabClient: async () => pics.shift() },
    pipeline: { observe: fn => watchers.push(fn), onLine: line => { shown.push(line.text); return []; } },
    publish: () => {}, encode: () => ({ mime: 'image/png', base64: '' }), reader: { read: async () => reads.shift() || 'x' },
  });
  const tick = async pic => { pics = [pic]; await ocr.tick(); };
  for (let i = 0; i < 5; i++) watchers.forEach(fn => fn({ channel: 'G', text: '[restricted]', sender: '' }));
  reads = ['one', 'two', 'three', 'four', 'five'];
  await tick(chat([3, 7, 11, 13, 17])); await tick(chat([3, 7, 11, 13, 17]));
  check(shown.length === 5, 'the five lines are read first');
  // the first two lines have faded away, nothing new: nothing is read, and the picture is kept as the one to compare with
  const faded = chat([11, 13, 17], { ink: 200 });
  await tick(faded);
  check(shown.length === 5, 'the old lines at the top faded away: nothing new, nothing read');
  reads = ['six'];
  await tick(chat([11, 13, 17, 19], { ink: 200 }));
  check(shown.length === 6 && shown[5] === 'six', 'then one new line comes in below: only that line is read: ' + JSON.stringify(shown.slice(5)));
  ocr.stop();
}
