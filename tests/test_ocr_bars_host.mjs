// The whole of the way with the bars (ocr_host.js): the state of the chat window and the ledger come as lines, the pictures are made by the test, the model is a fake.
import { check, eq } from './helpers.mjs';
const { startOcr } = await import('../app/ocr_host.js');
const { DEFAULTS } = await import('../app/core/config.js');
const { Pipeline } = await import('../app/core/pipeline.js');
const { log } = await import('../app/core/log.js'); log.quiet = true;

const STATE = (n, scroll = 0) => `1,${n},1,34,190,426,188,0,-6,40,6,12,17,14,${scroll},1920,1080,2,2,128,16,98,14`;
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

function harness({ mode = 'ondemand' } = {}) {
  const cfg = { ...structuredClone(DEFAULTS), ocr_enabled: true, ocr_when: mode, ocr_read: 'ai' };
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
    reader: { read: async () => reads.shift() ?? '' },
  });
  let id = 0;
  const feed = (channel, text) => publish(real.onLine({ channel, text, sender: '', id: ++id }));
  return {
    cfg, notes, shown, lost, events, placed: () => { const got = new Map(); for (const e of events) if (e.type === 'LineUpdated') got.set(e.line.id, e.line.plain); return events.filter(e => e.type === 'LineAdded' && e.line.code === '!OCR').map(e => got.get(e.line.id)); }, grabs, ocr, feed,
    state: (n, scroll) => feed('@CS', STATE(n, scroll)),
    set: pic => { current = pic; }, say: (...texts) => { reads.push(...texts); },
    tick: async (dt = 0) => { clock += dt; await ocr.tick(); await ocr.whenReady(); },
    time: () => clock, advance: dt => { clock += dt; },
  };
}

{
  // two restricted messages and a readable one come while the chat is restricted; the pictures show them
  const h = harness();
  h.state(1);
  h.feed('G', 'hello there'); h.feed('G', '[restricted]'); h.feed('G', '[restricted]');
  h.set(scene([{ kind: 'R', rows: 2 }, { kind: 'R', rows: 1 }, { kind: 'G', rows: 1 }]));
  await h.tick(0.1);
  eq(h.grabs[0], [0, 702, 460, 188], 'the part of the window that is grabbed is the chat window and its strip (from the state line)');
  check(h.shown.length === 0, 'the first picture: nothing is read yet');
  h.say('[Boss]: burn it all', 'Run away!');
  await h.tick(0.3);
  eq(h.shown, ['[Boss]: burn it all', 'Run away!'], 'the same picture again: each message is read once and shown, in the order the messages came');
  check(h.notes.some(t => /제한/.test(t)), 'the start of the reading is told');
}
{
  // the state is not there (an old addon, or the bars are off): the older way looks; nothing from the bars
  const h = harness();
  h.feed('G', '[restricted]');
  h.set(scene([{ kind: 'R', rows: 1 }]));
  await h.tick(0.1);
  check(h.grabs.length === 0 || h.grabs[0][1] !== 702, 'no state line: the bars are not used');
}
{
  // the window is scrolled up: nothing is read, and when it is back at the bottom the messages are read
  const h = harness();
  h.state(1, 4);
  h.feed('G', '[restricted]');
  h.set(scene([{ kind: 'R', rows: 1 }]));
  h.say('A boss shouts');
  await h.tick(0.1); await h.tick(0.3);
  check(h.shown.length === 0, 'scrolled up: nothing is read');
  h.state(2, 0);
  await h.tick(0.3); await h.tick(0.3);
  eq(h.shown, ['A boss shouts'], 'at the bottom again: it is read');
}
{
  // more restricted messages came than the window shows: the ones that went up are told as missed
  const h = harness();
  h.state(1);
  for (let i = 0; i < 14; i++) h.feed('G', '[restricted]');
  h.set(scene(Array.from({ length: 11 }, () => ({ kind: 'R', rows: 1 }))));
  await h.tick(0.1); await h.tick(0.4);
  check(h.notes.some(t => /3줄/.test(t)), 'fourteen came, eleven are there: the three that went up are told (the older addon has no places): ' + JSON.stringify(h.notes));
}
{
  // the notice "chat is restricted" for every line is not written while the OCR reads them from the bars, and it is written again when it cannot
  const cfg = { ...structuredClone(DEFAULTS), ocr_enabled: true, ocr_when: 'ondemand', ocr_read: 'ai' };
  let clock = 100;
  const pipe = new Pipeline({ getCfg: () => cfg, translations: { submit: () => true }, getWindows: () => [], clock: () => '12:00:00' });
  const lines = [];
  const ocr = startOcr({ settings: { cfg: () => cfg }, tickMs: 0, now: () => clock, system: () => {}, listen: null, emit: null, http: null,
    capture: { clientSize: () => ({ width: 1920, height: 1080 }), grabClient: async () => null },
    pipeline: pipe, publish: ev => lines.push(...ev), encode: () => ({ mime: 'image/png', base64: '' }), reader: { read: async () => '' } });
  const give = (ch, text) => pipe.onLine({ channel: ch, id: 1, sender: '', text, cls: '', base: -1 });
  check(give('G', '[restricted]').length === 1, 'without a state line (the older way or no OCR): the notice is written');
  give('@CS', STATE(1));
  check(give('G', '[restricted]').length === 0, 'the state line is there and the OCR is on: the notice is not written');
  cfg.ocr_enabled = false;
  check(give('G', '[restricted]').length === 1, 'the OCR is off: it is written');
  ocr.stop();
}
{
  // an addon that gave the bars once: when they are gone (the restriction is over, the test is off) nothing is read the older way, though the watching time is left; the older addon (no state line ever) is read the older way
  const h = harness();
  h.state(1);
  h.feed('G', '[restricted]');
  h.set(scene([{ kind: 'R', rows: 1 }]));
  await h.tick(0.1);
  h.feed('G', '[restricted]');
  await h.tick(20);
  check(!h.notes.some(n => /읽을 구역/.test(n)), 'the bars are gone: the older way is not used (it would say that there is no region)');
  const o = harness();
  o.feed('G', '[restricted]');
  o.set(scene([{ kind: 'R', rows: 1 }]));
  await o.tick(0.1); await o.tick(1.5);
  check(!o.notes.some(n => /읽을 구역/.test(n)) && o.notes.some(n => /막대가 오지 않아/.test(n)), 'no state line ever (the bars are off in the addon, or it is an older one): the older way does not look; it is said that there are no bars');
}
{
  // the state line is not shown as a line of the chat
  const cfg = { ...structuredClone(DEFAULTS) };
  const real = new Pipeline({ getCfg: () => cfg, translations: { submit: () => true }, getWindows: () => [], clock: () => '12:00:00' });
  eq(real.onLine({ channel: '@CS', id: 5, sender: '', text: STATE(1), cls: '', base: -1 }), [], 'a state line makes no line in a window');
  eq(real.onLine({ channel: '@RT', id: 6, sender: '', text: '42', cls: '', base: -1 }), [], 'a censored-message line (@RT) makes no line in a window');
}
