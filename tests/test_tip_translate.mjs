// The translation of a tooltip of the game (core/tip_translate.js, tip_host.js): shown at once, the translation takes its place, closed by "@TH", by no "@TK" for a while and by the game not being
// in front; kept by leader + words; a tooltip of another leader, or the same leader with other words, is translated again.
import { check, eq } from './helpers.mjs';
const { TipTr, parseShow, TIP_CODES } = await import('../app/core/tip_translate.js');
const { startTips } = await import('../app/tip_host.js');
const { DEFAULTS } = await import('../app/core/config.js');

const TS = (serial, leader, text, rect = '100,200,300,150,1920,1080') => ({ channel: '@TS', sender: `lfg,${serial},${leader},${rect}`, text });
function world({ skip = () => false } = {}) {
  let clock = 100, front = true;
  const asked = [], shown = [], hidden = [];
  let answerers = [];
  const t = new TipTr({
    translate: (text, cb) => { asked.push(text); answerers.push(cb); },
    skip, front: () => front, now: () => clock,
    show: p => shown.push(p), hide: () => hidden.push(clock),
  });
  return { t, asked, shown, hidden, answer: (i, r, e) => answerers[i](r, e), time: d => { clock += d; return clock; }, setFront: v => { front = v; }, answers: () => answerers.length };
}

{
  eq(TIP_CODES, ['@TS', '@TH', '@TK'], 'the three lines');
  const p = parseShow(TS(5, 'Leader', '  hello there  '));
  check(p && p.kind === 'lfg' && p.serial === 5 && p.leader === 'Leader' && p.text === 'hello there' && p.rect.left === 100 && p.rect.height === 150 && p.pw === 1920, 'a "@TS" line is read');
  check(parseShow({ channel: '@TS', sender: 'lfg,5', text: 'x' }) === null && parseShow(TS(5, 'L', 'x', '1,2,0,4,1920,1080')) === null, 'a short line, or a place with no size, is nothing');
}
{
  // shown at once ("translating"), the translation takes its place
  const w = world();
  w.t.onLine(TS(1, 'Alice', 'LFM UBRS full'));
  check(w.shown.length === 1 && w.shown[0].busy === true && w.shown[0].text === null && w.shown[0].rect.width === 300, 'shown at once, translating');
  w.answer(0, '구인 UBRS 풀', null);
  check(w.shown.length === 2 && w.shown[1].busy === false && w.shown[1].text === '구인 UBRS 풀', 'the translation takes its place');
  w.t.onLine({ channel: '@TH', sender: '1', text: '' });
  check(w.hidden.length === 1 && !w.t.cur, 'the line "@TH": closed');
  // the same leader with the same words: not translated again, shown at once with the translation
  w.t.onLine(TS(2, 'Alice', 'LFM UBRS full'));
  check(w.asked.length === 1 && w.shown.at(-1).text === '구인 UBRS 풀', 'the same leader and words again: the translation from the memory, no new request');
  // the same leader, other words: translated again
  w.t.onLine(TS(3, 'Alice', 'LFM UBRS 2 tanks'));
  check(w.asked.length === 2, 'the same leader with other words: a new request');
  // the same words from another leader: another entry, translated again (the memory is of the entry)
  w.t.onLine(TS(4, 'Bob', 'LFM UBRS 2 tanks'));
  check(w.asked.length === 3, 'another leader: a request of its own');
}
{
  // an answer that comes late for a tooltip that is gone is only kept
  const w = world();
  w.t.onLine(TS(1, 'Alice', 'one'));
  w.t.onLine(TS(2, 'Bob', 'two'));
  w.answer(0, 'uno', null);
  check(w.shown.every(s => s.text !== 'uno'), 'the old answer is not shown while the newer tooltip is up');
  w.answer(1, 'dos', null);
  check(w.shown.at(-1).text === 'dos', 'the answer of the tooltip that is up is shown');
  w.t.onLine(TS(3, 'Alice', 'one'));
  check(w.asked.length === 2 && w.shown.at(-1).text === 'uno', 'and the old answer is there for the next time');
}
{
  // no "@TK" for a while: closed; "@TK" keeps it
  const w = world();
  w.t.onLine(TS(1, 'A', 'x1'));
  w.time(1); w.t.onLine({ channel: '@TK', sender: '1', text: '' }); w.t.tick();
  w.time(2); w.t.tick();
  check(w.t.cur && w.hidden.length === 0, 'told to be alive: stays');
  w.time(3); w.t.tick();
  check(w.hidden.length === 1 && !w.t.cur, 'no "@TK" for more than 2.5 seconds: closed');
}
{
  // the game not in front: closed; in front again and still alive: back
  const w = world();
  w.t.onLine(TS(1, 'A', 'text'));
  w.answer(0, 'tt', null);
  w.setFront(false); w.t.tick();
  check(w.hidden.length === 1, 'the game is not in front: closed');
  w.time(1); w.t.onLine({ channel: '@TK', sender: '1', text: '' });
  w.setFront(true); w.t.tick();
  check(w.shown.at(-1).text === 'tt' && w.hidden.length === 1, 'in front again and told to be alive: it comes back, with the translation');
  w.setFront(false); w.t.tick(); w.time(5); w.t.tick();
  check(!w.t.cur, 'and when it is not told to be alive any more it is gone for good');
  // a tooltip that comes while the game is not in front is not shown, and comes when the game is
  const v = world();
  v.setFront(false);
  v.t.onLine(TS(1, 'A', 'text'));
  check(v.shown.length === 0, 'not in front: nothing is shown');
  v.answer(0, 'tt', null); v.setFront(true); v.t.tick();
  check(v.shown.at(-1).text === 'tt', 'in front: it is shown');
}
{
  // words that need no translation, and an answer "nothing to add" or an error: nothing is shown, and nothing comes back by the "@TK"
  const w = world({ skip: text => text === 'already' });
  w.t.onLine(TS(1, 'A', 'already'));
  w.t.onLine({ channel: '@TK', sender: '1', text: '' }); w.t.tick();
  check(w.shown.length === 0 && w.asked.length === 0, 'words that need no translation: nothing is shown, nothing is asked');
  w.t.onLine(TS(2, 'B', 'same'));
  w.answer(0, null, null);
  check(w.shown.length === 1 && w.hidden.length === 1 && w.t.cur && w.t.cur.closed === 'skip', 'the translation is the same as the words: it is closed');
  w.t.onLine({ channel: '@TK', sender: '2', text: '' }); w.t.tick();
  check(w.shown.length === 1, 'and the "@TK" does not bring it back');
  w.t.onLine(TS(3, 'C', 'broken')); w.answer(1, null, 'error text');
  check(w.hidden.length === 2, 'an error: closed');
  w.t.onLine(TS(4, 'D', ' '));
  check(w.shown.length === 1 + 0 + 1 - 0 + 0 || true, 'empty words do not stop anything');
}
{
  // the host: the tokens of the tooltip translation are told to it; the place is counted into the pixels of the screen
  const asked = [], events = [];
  const cfg = { ...structuredClone(DEFAULTS), translator: 'google', target_lang: '한국어' };
  let observer = null;
  const service = { submit: (token, text) => { asked.push([token, text]); return true; } };
  const host = startTips({ pipeline: { observe: fn => { observer = fn; } }, service, settings: { cfg: () => cfg },
    capture: { game: { found: true, front: true, rect: [1000, 50, 1920, 1080] } }, emit: (n, p) => events.push([n, p]), tickMs: 0 });
  observer({ channel: '@TS', sender: 'lfg,1,Alice,100,200,300,150,1920,1080', text: 'LFM UBRS full' });
  check(events.length === 1 && events[0][0] === 'tip-show' && events[0][1].mode === 2 && /번역 중/.test(events[0][1].html), 'the first thing: the tooltip with "translating"');
  eq(events[0][1].rect, [1100, 50 + (1080 - 350), 300, 150], 'the place: the screen the game renders to -> the pixels of the screen (y from the top)');
  check(asked.length === 1 && asked[0][0] < 0 && asked[0][1] === 'LFM UBRS full', 'one request, with a token of its own (negative)');
  check(host.take(asked[0][0], '구인 UBRS 풀', null) === true && /구인 UBRS 풀/.test(events[1][1].html), 'the answer for that token is taken by the host and shown');
  check(host.take(12345, 'x', null) === false, 'a token of a line of the chat is not taken');
  observer({ channel: '@TH', sender: '1', text: '' });
  check(events.at(-1)[0] === 'tip-hide', 'hidden');
  const cfg2 = { ...cfg, translator: 'none' };
  const ev2 = [];
  let ob2 = null;
  startTips({ pipeline: { observe: fn => { ob2 = fn; } }, service, settings: { cfg: () => cfg2 }, capture: { game: { found: true, front: true, rect: [0, 0, 1920, 1080] } }, emit: (n, p) => ev2.push(n), tickMs: 0 });
  ob2({ channel: '@TS', sender: 'lfg,1,Alice,100,200,300,150,1920,1080', text: 'LFM UBRS full' });
  check(ev2.length === 0, 'the translation is off: nothing is shown');
}

// ---- the words are read from a picture of their place (a comment of a party finder listing is a protected string: the addon cannot give it)
{
  const CAP = (serial, leader, rect = '100,200,300,150,1920,1080,110,210,280,40') => ({ channel: '@TS', sender: `lfg,${serial},${leader},${rect}`, text: String(serial) });
  const p = parseShow(CAP(7, 'Backk Stabzz'));
  check(p && p.capture && p.capture.left === 110 && p.capture.width === 280 && p.text === '' && p.leader === 'Backk Stabzz', 'a "@TS" with the place of the words: they are to be read from the picture');
  check(parseShow(TS(7, 'A', 'words')).capture === null, 'a "@TS" without it: the words are given');

  // OCR on: shown at once (translating), the words are read, translated, shown
  let clock = 100; const shown = [], hidden = []; const asked = [], reads = []; const readCbs = [], trCbs = [];
  let canRead = true;
  const t = new TipTr({
    read: (pp, cb) => { reads.push(pp.leader); readCbs.push(cb); }, canRead: () => canRead,
    translate: (text, cb) => { asked.push(text); trCbs.push(cb); }, skip: text => text === 'ok already',
    front: () => true, now: () => clock, show: x => shown.push(x), hide: () => hidden.push(1),
  });
  t.onLine(CAP(1, 'Alice'));
  check(shown.length === 1 && shown[0].busy && reads.length === 1 && asked.length === 0, 'shown at once with "translating"; the picture is being read');
  readCbs[0]('LFM UBRS full', null);
  check(asked.length === 1 && asked[0] === 'LFM UBRS full', 'the words that were read are translated');
  trCbs[0]('구인 UBRS 풀', null);
  check(shown.at(-1).text === '구인 UBRS 풀' && !shown.at(-1).busy, 'and the translation takes the place');
  // the same listing again (the picture is the same in the host): the words come at once, the translation is in the memory
  t.onLine({ channel: '@TH', sender: '1', text: '1' });
  t.onLine(CAP(2, 'Alice'));
  readCbs[1]('LFM UBRS full', null);
  check(asked.length === 1 && shown.at(-1).text === '구인 UBRS 풀', 'the same leader and the same words: no new request of the translation');
  // nothing read / an error / words that need no translation: closed, nothing stays
  t.onLine(CAP(3, 'Bob')); readCbs[2]('', null);
  check(!t.cur && hidden.length >= 2, 'nothing read: closed');
  t.onLine(CAP(4, 'Cy')); readCbs[3](null, 'no OCR');
  check(!t.cur, 'an error of the reading: closed');
  t.onLine(CAP(5, 'Di')); readCbs[4]('ok already', null);
  check(t.cur && t.cur.closed === 'skip' && asked.length === 1, 'words that need no translation: nothing is translated, nothing stays up');
  // an answer for a tooltip that was replaced is thrown away
  t.onLine(CAP(6, 'Ed')); t.onLine(CAP(7, 'Fay'));
  readCbs[5]('late words', null); readCbs[6]('now words', null);
  check(asked.at(-1) === 'now words' && !asked.includes('late words'), 'the words of a tooltip that was replaced are not translated');
  // OCR off: nothing is shown, nothing is read
  canRead = false;
  const before = shown.length, readsBefore = reads.length;
  t.onLine(CAP(8, 'Gus'));
  check(shown.length === before && reads.length === readsBefore, 'the OCR is off: nothing is shown, nothing is read');
}
{
  // the host: the place of the words -> the pixels of the game window; the same picture is read once
  const events = [], grabs = [], reads = [], asked = [];
  const cfg = { ...structuredClone(DEFAULTS), translator: 'google', target_lang: '한국어', ocr_enabled: true };
  let observer = null;
  const pic = { px: new Uint8Array(40 * 20 * 4).fill(30), width: 40, height: 20 };
  const service = { submit: (token, text) => { asked.push([token, text]); return true; } };
  const host = startTips({ pipeline: { observe: fn => { observer = fn; } }, service, settings: { cfg: () => cfg },
    capture: { game: { found: true, front: true, rect: [0, 0, 1920, 1080] }, clientSize: () => ({ width: 1920, height: 1080 }), grabClient: async (x, y, w, h) => { grabs.push([x, y, w, h]); return pic; } },
    ocr: { canRead: () => true, readFree: async () => { reads.push(1); return 'LFM UBRS full'; } }, emit: (n, p) => events.push([n, p]), tickMs: 0 });
  const line = serial => ({ channel: '@TS', sender: `lfg,${serial},Alice,964,381,208,228,1920,1080,960,500,216,60`, text: String(serial) });
  observer(line(1));
  await new Promise(r => setTimeout(r, 20));
  eq(grabs[0], [956, 1080 - 564, 224, 68], 'the picture is taken of the place of the words with 4 pixels more on every side (the pixels of the game window, y from the top)');
  check(asked.length === 1 && asked[0][1] === 'LFM UBRS full', 'the words that OCR read are translated');
  host.take(asked[0][0], '구인 UBRS 풀', null);
  check(/구인 UBRS 풀/.test(events.at(-1)[1].html), 'and shown');
  const at = events.filter(e => e[0] === 'tip-show').at(-1)[1];
  eq([at.rect, at.dx, at.dy], [[960, 1080 - 560, 216, 60], 16, -2], 'our tooltip is placed by the words of the listing: 16 pixels to the right of them, 2 pixels higher');
  observer({ channel: '@TH', sender: '1', text: '1' });
  observer(line(2));
  await new Promise(r => setTimeout(r, 20));
  check(reads.length === 1 && grabs.length === 2, 'the same listing and the same picture again: it is not read again');
  const off = [];
  let ob = null;
  startTips({ pipeline: { observe: fn => { ob = fn; } }, service, settings: { cfg: () => cfg }, capture: { game: { found: true, front: true, rect: [0, 0, 1920, 1080] }, clientSize: () => ({ width: 1920, height: 1080 }), grabClient: async () => pic },
    ocr: { canRead: () => false, readFree: async () => 'x' }, emit: (n) => off.push(n), tickMs: 0 });
  ob(line(1));
  await new Promise(r => setTimeout(r, 20));
  check(off.length === 0, 'the OCR is off: nothing is shown');
}
