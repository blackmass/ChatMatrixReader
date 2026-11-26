// The whole of the way with the bars and the numbers of the addon (ocr_host.js, docs/HANDOFF.md 4-0h): the state of the chat window (with the count t and the session) and the lines "@RT" come as lines,
// the pictures are made by the test, the model is a fake.
import { check, eq } from './helpers.mjs';
const { startOcr } = await import('../app/ocr_host.js');
const { DEFAULTS } = await import('../app/core/config.js');
const { Pipeline } = await import('../app/core/pipeline.js');
const { log } = await import('../app/core/log.js'); log.quiet = true;

const STATE = (n, scroll = 0, t = 100, session = 7) => `2,${n},34,190,426,188,-6,40,6,12,17,14,${scroll},1920,1080,${t},${session}`;
const W = 460, H = 188, L = 34, CW = 426, P = 17, F = 14;
function scene(messages) {
  const px = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = 20; px[i * 4 + 1] = 14; px[i * 4 + 2] = 14; px[i * 4 + 3] = 255; }
  const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; px[o] = b; px[o + 1] = g; px[o + 2] = r; };
  let k = 0;
  for (const m of messages) {
    const tops = [];
    for (let j = 0; j < m.rows; j++) tops.push(H - ((k + m.rows - 1 - j) * P + F));
    k += m.rows;
    tops.forEach((top, j) => { for (let y = top; y < top + F; y++) for (let x = L + (j ? 12 : 0); x < L + CW - 20; x++) if (((x * 7 + y * 13 + j * 5) % 11) < 4) put(x, y, 230, 230, 230); });
    for (let y = tops[0] + 1; y < tops[0] + 13; y++) for (let x = L - 17; x < L - 11; x++) if (y >= 0 && y < H) put(x, y, m.kind === 'R' ? 255 : 0, m.kind === 'R' ? 0 : 255, 0);
  }
  return { px, width: W, height: H };
}

function harness({ mode = 'ondemand', reading = 'ai', parallel = 1, readerImpl = null, winFake = null } = {}) {
  const cfg = { ...structuredClone(DEFAULTS), ocr_enabled: true, ocr_when: mode, ocr_read: reading, ocr_ai_parallel: parallel };
  const winCalls = [];
  let clock = 100, current = null, grabs = [], reads = [];
  const notes = [], shown = [], lost = [], events = [];
  const svc = { submit: () => true };
  const real = new Pipeline({ getCfg: () => cfg, translations: svc, getWindows: () => [], clock: () => '12:00:00' });
  const pipeline = real;
  // what the windows would get: the notices of the program, the OCR lines that were read (a place kept for a line says "…" until then), and the lines that could not be read
  const publish = evs => { for (const ev of evs || []) { events.push(ev); if (ev.type === 'Notice' && ev.kind === 'system') notes.push(ev.text); else if (ev.line && ev.line.code === '!OCR') { if (ev.line.plain === '…') continue; if (ev.line.plain === '(읽지 못함)') lost.push(ev.line.id); else shown.push(ev.line.plain); } } };
  const ocr = startOcr({
    settings: { cfg: () => cfg }, tickMs: 0, now: () => clock, system: t => notes.push(t), listen: null, emit: null, http: null,
    capture: { clientSize: () => ({ width: 1920, height: 1080 }), grabClient: async (x, y, w, h) => { grabs.push([x, y, w, h]); return current; } },
    pipeline, publish, encode: () => ({ mime: 'image/png', base64: '' }),
    reader: readerImpl || { read: async () => { if (reading === 'windows') throw new Error('the AI is not to be called'); return reads.shift() ?? ''; } },
    winReader: winFake || { read: async (pic, geo) => { winCalls.push([pic.width, pic.height, geo.rows]); return reads.shift() ?? ''; }, last: { what: 'Windows OCR', build: 3, http: 5, parse: 0 } },
  });
  let id = 0;
  const feed = (channel, text) => publish(real.onLine({ channel, text, sender: '', id: ++id }));
  return {
    cfg, notes, shown, lost, events, placed: () => { const got = new Map(); for (const e of events) if (e.type === 'LineUpdated') got.set(e.line.id, e.line.plain); return events.filter(e => e.type === 'LineAdded' && e.line.code === '!OCR').map(e => got.get(e.line.id)); }, grabs, ocr, feed, winCalls,
    state: (n, scroll, t, session) => feed('@CS', STATE(n, scroll, t, session)),
    rt: t => feed('@RT', String(t)),
    set: pic => { current = pic; }, say: (...texts) => { reads.push(...texts); },
    tick: async (dt = 0) => { clock += dt; await ocr.tick(); await ocr.whenReady(); },
    time: () => clock, advance: dt => { clock += dt; },
  };
}

{
  // two restricted messages (99: two rows, 100: one row) and a readable one come; their lines "@RT" come with the numbers; the pictures show them
  const h = harness();
  h.state(1);
  h.feed('G', 'hello there'); h.rt(99); h.rt(100);
  h.set(scene([{ kind: 'R', rows: 1 }, { kind: 'R', rows: 2 }, { kind: 'G', rows: 1 }]));
  await h.tick(0.1);
  eq(h.grabs[0], [0, 702, 460, 188], 'the part of the window that is grabbed is the chat window and its strip (from the state line)');
  check(h.shown.length === 0, 'the first picture: nothing is read yet');
  h.say('[Boss]: burn it all', 'Run away!');                                     // (the readings go out with the lowest number first: 99, then 100)
  await h.tick(0.3);
  eq(h.shown, ['[Boss]: burn it all', 'Run away!'], 'the same picture again: each message is read once; shown in the order of the numbers (99 first)');
  check(h.notes.some(t => /제한/.test(t)), 'the start of the reading is told');
}
{
  // the matrix filter keeps the event lines "[restricted]" away: the lines "@RT" alone start the reading
  const h = harness();
  h.state(1);
  h.rt(100);
  h.set(scene([{ kind: 'R', rows: 1 }, { kind: 'G', rows: 1 }]));
  h.say('The boss yells');
  await h.tick(0.1); await h.tick(0.3);
  eq(h.shown, ['The boss yells'], 'only "@RT": the message is read');
}
{
  // the window is scrolled up: nothing is read, and when it is back at the bottom the message is read
  const h = harness();
  h.state(1, 4);
  h.rt(100);
  h.set(scene([{ kind: 'R', rows: 1 }]));
  h.say('A boss shouts');
  await h.tick(0.1); await h.tick(0.3);
  check(h.shown.length === 0, 'scrolled up: nothing is read');
  h.state(2, 0);
  await h.tick(0.3); await h.tick(0.3);
  eq(h.shown, ['A boss shouts'], 'at the bottom again: it is read');
}
{
  // fourteen restricted messages came (87..100), eleven are in the window: the three that went up are told as missed, exactly
  const h = harness();
  h.state(1);
  for (let t = 87; t <= 100; t++) h.rt(t);
  h.set(scene(Array.from({ length: 11 }, () => ({ kind: 'R', rows: 1 }))));
  await h.tick(0.1); await h.tick(0.4);
  check(h.lost.length === 3, 'fourteen came, eleven are there: the places of the three that went up say that they could not be read: ' + h.lost.length);
}
{
  // another session of the addon: the numbers start again, and the reading goes on with them
  const h = harness();
  h.state(1, 0, 100, 7);
  h.rt(100);
  h.set(scene([{ kind: 'R', rows: 1 }]));
  h.say('first');
  await h.tick(0.1); await h.tick(0.3);
  eq(h.shown, ['first'], 'before the new session');
  h.state(2, 0, 2, 8);
  h.rt(2);
  h.say('second');
  await h.tick(1); await h.tick(0.3);
  eq(h.shown, ['first', 'second'], 'after the addon was loaded again (the numbers start at 1 again): the next message is read');
}
{
  // the lines "@RT" and the state are no chat lines in a window
  const cfg = { ...structuredClone(DEFAULTS) };
  const real = new Pipeline({ getCfg: () => cfg, translations: { submit: () => true }, getWindows: () => [], clock: () => '12:00:00' });
  eq(real.onLine({ channel: '@RT', id: 6, sender: '', text: '42', cls: '', base: -1 }), [], 'a "@RT" line makes no line in a window');
}
{
  // the end of a restriction: the plain notice is written, unless the OCR is reading (it tells the end itself)
  const cfg = { ...structuredClone(DEFAULTS) };
  const real = new Pipeline({ getCfg: () => cfg, translations: { submit: () => true }, getWindows: () => [], clock: () => '12:00:00' });
  const end = () => real.onLine({ channel: '@RS', id: 7, sender: '', text: 'chat restriction lifted', cls: '', base: -1 });
  check(end().length === 1 && end()[0].kind === 'restriction_over', 'no OCR: the end of the restriction is told');
  real.quietRestricted = () => true;
  eq(end(), [], 'the OCR is reading: the plain notice is not written (the OCR tells the end: "화면에서 읽기를 마쳤습니다")');
  real.quietRestricted = () => false;
  check(end().length === 1, 'the OCR is not reading (any more): told again');
}
{
  // the reader "Windows OCR": the pictures of the messages go to it as they are (BGRA, with their rows), the AI is not asked
  const h = harness({ reading: 'windows' });
  h.state(1);
  h.rt(99); h.rt(100);
  h.set(scene([{ kind: 'R', rows: 1 }, { kind: 'R', rows: 2 }, { kind: 'G', rows: 1 }]));
  await h.tick(0.1);
  h.say('[Boss]: burn it all', 'Run away!');                                     // (the readings go out with the lowest number first: 99, then 100)
  await h.tick(0.3);
  eq(h.shown, ['[Boss]: burn it all', 'Run away!'], 'read by Windows OCR, shown in the order of the numbers');
  check(h.winCalls.length === 2 && h.winCalls.map(c => c[2]).sort().join() === '1,2' && h.winCalls.every(c => c[0] === 426), 'two pictures went to the reader, as they are (426 wide, 1 and 2 rows)');
}
{
  // the OCR with Windows OCR chosen but no way to call the exe (no reader made): it does not read, and does not break
  const cfg = { ...structuredClone(DEFAULTS), ocr_enabled: true, ocr_when: 'ondemand', ocr_read: 'windows' };
  const ocr = startOcr({ settings: { cfg: () => cfg }, tickMs: 0, now: () => 100, system: () => {}, listen: null, emit: null, http: null, invoke: null,
    capture: { clientSize: () => ({ width: 1920, height: 1080 }), grabClient: async () => null }, pipeline: { observe: () => {}, onLine: () => [] }, publish: () => {}, encode: () => ({}), reader: { read: async () => '' } });
  await ocr.tick();
  check(true, 'Windows OCR chosen without the exe call: a tick does nothing and does not throw');
}

// ---- how many readings go to the AI server at the same time (the options), the lowest number first, shown in the order of the numbers
for (const parallel of [1, 2]) {
  let active = 0, maxActive = 0, calls = 0;
  const readerImpl = { read: async () => { const k = ++calls; active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, k === 1 ? 40 : 5)); active--; return 'm' + k; } };
  const h = harness({ parallel, readerImpl });
  h.state(1, 0, 100, 7);
  h.rt(98); h.rt(99); h.rt(100);
  h.set(scene([{ kind: 'R', rows: 1 }, { kind: 'R', rows: 1 }, { kind: 'R', rows: 1 }, { kind: 'G', rows: 1 }]));
  await h.tick(0.1);
  await h.tick(0.3);
  eq(h.placed(), ['m1', 'm2', 'm3'], 'parallel ' + parallel + ': each text is in the place of its number, whichever reading ends first');
  eq(maxActive, parallel, 'parallel ' + parallel + ': that many readings at the same time');
}

// ---- "when it works" and the engine of Windows OCR: resident = ready while the OCR is on; only when needed = from the start of a restriction until it is over; the AI has no engine of ours
const fakeEngine = () => { const e = { calls: [], loaded: false, loading: false, last: null, read: async () => '', warm: async () => { e.calls.push('warm'); e.loaded = true; }, release: async () => { e.calls.push('release'); e.loaded = false; } }; return e; };
const settle = () => new Promise(r => setTimeout(r, 0));
{
  const e = fakeEngine();
  const h = harness({ mode: 'resident', reading: 'windows', winFake: e });
  await h.tick(1); await settle();
  eq(e.calls, ['warm'], 'resident: the engine is made ready as soon as the OCR is on, without a restriction');
  await h.tick(1); await settle();
  eq(e.calls, ['warm'], 'resident: and stays (not made again)');
  h.cfg.ocr_when = 'ondemand';
  await h.tick(1); await settle();
  eq(e.calls, ['warm', 'release'], 'changed to "only when needed" with no restriction: it is let go');
}
{
  const e = fakeEngine();
  const h = harness({ mode: 'ondemand', reading: 'windows', winFake: e });
  await h.tick(1); await settle();
  eq(e.calls, [], 'only when needed: no engine while nothing is restricted');
  h.state(1, 0, 100, 7); h.rt(100);
  h.set(scene([{ kind: 'R', rows: 1 }, { kind: 'G', rows: 1 }]));
  await h.tick(0.3); await settle();
  eq(e.calls, ['warm'], 'only when needed: the restriction begins: the engine is made ready');
  await h.tick(40); await settle();
  eq(e.calls, ['warm', 'release'], 'only when needed: some seconds after the last restricted line it is let go');
}
{
  const e = fakeEngine();
  const h = harness({ mode: 'resident', reading: 'ai', winFake: e });
  await h.tick(1); await settle();
  eq(e.calls, [], 'the AI server reads: no engine of ours is made');
}
