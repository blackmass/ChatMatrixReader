// The OCR lines keep their place (docs/HANDOFF.md 4-0n): the line "@RT" of a censored message comes in the order of the chat, so a line "[OCR] …" is put there at once; the words take its place when they
// have been read (LineUpdated), however late; a line that could not be read says so there. The end line "@RS" tells the end of the reading in its own place.
import { check, eq } from './helpers.mjs';
const { Pipeline, MAIN } = await import('../app/core/pipeline.js');
const { WindowFeed } = await import('../app/core/windowfeed.js');
const { DEFAULTS } = await import('../app/core/config.js');
const { log } = await import('../app/core/log.js'); log.quiet = true;

function world({ reading = true } = {}) {
  const cfg = { ...structuredClone(DEFAULTS), translator: 'google', target_lang: 'ko' };
  const submitted = [];
  const p = new Pipeline({ getCfg: () => cfg, translations: { submit: (id, text) => { submitted.push([id, text]); return true; } }, getWindows: () => [], clock: () => '12:00:00' });
  let announced = false, isReading = reading;
  p.quietRestricted = () => isReading;
  p.ocrHook = { reading: () => isReading, begin: () => { if (announced) return null; announced = true; return 'START'; }, end: () => { if (!announced) return null; announced = false; return 'END'; } };
  const feed = new WindowFeed(MAIN, () => ({ ...cfg, pending_mark: false }));
  const events = [];
  const give = evs => { for (const ev of evs) { events.push(ev); feed.handle(ev); } return evs; };
  let id = 0;
  const line = (channel, text) => give(p.onLine({ channel, text, sender: channel === 'G' ? 'Bob' : '', id: ++id, cls: '', base: -1 }));
  const texts = () => feed.model.blocks.map(b => b.pieces.map(x => x.text).join(''));
  return { p, cfg, feed, events, give, line, texts, submitted, setReading: v => { isReading = v; } };
}

{
  const w = world();
  const a = w.line('@RT', '5');
  eq(a.map(e => e.type), ['Notice', 'LineAdded'], 'the first censored message of a reading: the beginning is told, and a place is kept for its line');
  check(a[0].text === 'START' && a[1].line.code === '!OCR' && a[1].line.plain === '…', 'the notice and the place "…"');
  const b = w.line('@RT', '6');
  eq(b.map(e => e.type), ['LineAdded'], 'the next one: only its place');
  eq(w.line('@RT', '6'), [], 'the same message again: no second place');
  w.line('G', 'hello there');
  eq(w.texts().length, 4, 'start notice, two places, the line that came after them');
  check(/hello there/.test(w.texts()[3]) && /…/.test(w.texts()[1]) && /…/.test(w.texts()[2]), 'the order of the chat: notice, 5, 6, hello');
  // the later one is read first
  w.give(w.p.fillOcr(6, '[Boss]: second'));
  check(/second/.test(w.texts()[2]) && /…/.test(w.texts()[1]) && w.texts().length === 4, 'the later message is read first: it is in its own place, the earlier one still waits, nothing moved');
  w.give(w.p.fillOcr(5, '[Boss]: first'));
  check(/first/.test(w.texts()[1]) && /second/.test(w.texts()[2]) && /hello there/.test(w.texts()[3]) && w.texts().length === 4, 'then the earlier one: the order is that of the messages, not that of the readings');
  check(/\[OCR\]/.test(w.texts()[1]), 'the line is marked as read by the OCR');
  // the translation of a line that took its place goes under it
  const sub = w.submitted.at(-1);
  check(sub && /first/.test(sub[1]), 'what was read is given to the translation: ' + JSON.stringify(w.submitted));
  w.give(w.p.onTranslation(sub[0], 'translated first'));
  check(/translated first/.test(w.texts()[2]) && /second/.test(w.texts()[3]) && /hello there/.test(w.texts()[4]), 'its translation comes under its own line, before the lines after it: ' + JSON.stringify(w.texts()));
}
{
  // a line that could not be read says so in its place; a read that has no place comes as a new line
  const w = world();
  w.line('@RT', '1'); w.line('@RT', '2');
  w.give(w.p.lostOcr(1));
  check(/읽지 못함/.test(w.texts()[1]) && /…/.test(w.texts()[2]), 'the place of the line that could not be read says so');
  eq(w.p.lostOcr(1), [], 'only once');
  const n = w.texts().length;
  w.give(w.p.fillOcr(77, 'no place was kept'));
  eq(w.texts().length, n + 1, 'a reading that has no place comes at the end as a new line');
}
{
  // the end line: the end is told at once in the place where it came, once
  const w = world();
  w.line('@RT', '1');
  const e = w.line('@RS', '');
  check(e.length === 1 && e[0].type === 'Notice' && e[0].text === 'END', 'the end line: the end of the reading is told in its place');
  eq(w.line('@RS', ''), [], 'and not again');
  w.line('G', 'after');
  w.give(w.p.fillOcr(1, '[Boss]: late reading'));
  check(/late reading/.test(w.texts()[1]) && /END/.test(w.texts()[2]) && /after/.test(w.texts()[3]), 'a reading that is late fills its own place: before the end notice and the chat that came after: ' + JSON.stringify(w.texts()));
}
{
  // the OCR is not reading: no place is kept (the older way of the program stays as it was)
  const w = world({ reading: false });
  eq(w.line('@RT', '5'), [], 'not reading: the line "@RT" makes nothing');
}
{
  // the state line: version 2 has only what the reader uses; version 1 (an older addon) is read as before; both give the same places
  const { parseState, regionOf } = await import('../app/core/ocr_state.js');
  const v1 = parseState('1,455,1,34,190,426,188,0,-6,40,6,12,17,14,0,1920,1080,136,1016,64,32,42,14,38,1065896');
  const v2 = parseState('2,456,34,190,426,188,-6,40,6,12,17,14,0,1920,1080,38,1065896');
  check(v1 && v2 && v1.t === 38 && v2.t === 38 && v2.session === 1065896 && v2.version === 2, 'both versions are read');
  const client = { width: 1920, height: 1080 };
  eq(regionOf(v2, client), regionOf(v1, client), 'the same places from both');
  check(parseState('2,1,2,3') === null && parseState('2,456,34,190,426,188,-6,40,6,12,17,14,0,1920,1080,38') === null, 'a version 2 line that is short is not a state');
}
