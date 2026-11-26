// The shared choices of the OCR assist (core/ocr.js): what is on, what is ready, what the matrix does.
import { check, eq } from './helpers.mjs';
const o = await import('../app/core/ocr.js');
check(!o.ocrOn({}) && !o.ocrOn({ ocr_enabled: false }) && o.ocrOn({ ocr_enabled: true }), 'ocrOn: only when the setting is on');
eq(o.WHEN.map(w => w[0]), ['ondemand', 'resident'], 'the two moments');
check(o.WHEN.every(w => o.WHEN_HINTS[w[0]]), 'every moment has its hint');
eq([o.reader({ ocr_read: 'ai' }), o.reader({ ocr_read: 'nope' })], ['ai', 'ai'], 'reader: an unknown one is the AI');
check(o.readerWhy('ai') === '' && o.readerWhy('windows') === '' && o.readerWhy('vision') === '', 'the AI, Windows OCR and macOS Vision are ready');
check(o.SPLITS === undefined, 'there is no choice of who finds the lines any more');

// the region the user picks: kept relative to the game window, cut to it, cleaned when read back
{
  const game = [100, 50, 1920, 1080];
  eq(o.regionFromScreen({ x: 300, y: 250, w: 400, h: 200 }, game), { x: 200, y: 200, w: 400, h: 200, gw: 1920, gh: 1080 }, 'regionFromScreen: relative to the game window');
  eq(o.regionFromScreen({ x: 50, y: 20, w: 200, h: 100 }, game), { x: 0, y: 0, w: 150, h: 70, gw: 1920, gh: 1080 }, 'regionFromScreen: the part outside of the window is cut');
  check(o.regionFromScreen({ x: 5000, y: 5000, w: 100, h: 100 }, game) === null && o.regionFromScreen({ x: 300, y: 300, w: 3, h: 3 }, game) === null && o.regionFromScreen(null, game) === null && o.regionFromScreen({ x: 1, y: 1, w: 50, h: 50 }, [0, 0, 0, 0]) === null, 'regionFromScreen: nothing inside, too small, nothing given: null');
  check(o.cleanRegion({ x: 1, y: 2, w: 30, h: 40, gw: 100, gh: 100 }) !== null && o.cleanRegion({ x: -1, y: 2, w: 30, h: 40, gw: 100, gh: 100 }) === null && o.cleanRegion({ x: 1, y: 2, w: 300, h: 40, gw: 100, gh: 100 }) === null && o.cleanRegion('x') === null && o.cleanRegion({ x: 'a' }) === null, 'cleanRegion: a good one is kept, wrong ones are null');
  eq(o.regionFor({ x: 100, y: 200, w: 400, h: 100, gw: 1000, gh: 1000 }, 2000, 500), { x: 200, y: 100, w: 800, h: 50 }, 'regionFor: the same part of a window of another size');
  check(o.regionFor(null, 100, 100) === null && o.regionFor({ x: 1, y: 1, w: 20, h: 20, gw: 50, gh: 50 }, 0, 100) === null, 'regionFor: nothing to scale: null');
}

// the OCR channel: window 1 shows it by default, it is translated like the others (by channel), and its lines are marked
{
  const wc = await import('../app/core/winconf.js'), pl = await import('../app/core/pipeline.js');
  check(wc.KNOWN.includes('!OCR') && wc.chanKey('!OCR') === '!OCR', 'the OCR channel is a known channel');
  check(pl.TRANSLATED_CODES.includes('!OCR'), 'the lines of the OCR channel are translated');
}

// an OCR line goes through the pipeline like a voice line: marked "[OCR]", translated by its channel
{
  const { Pipeline } = await import('../app/core/pipeline.js');
  const { DEFAULTS } = await import('../app/core/config.js');
  const { log } = await import('../app/core/log.js'); log.quiet = true;
  const sent = [];
  const svc = { submit: (token, text, route) => { sent.push([text, route]); return true; } };
  const cfg = { ...structuredClone(DEFAULTS), translator: 'openai', channel_route: { '!OCR': 'google_free' } };
  const p = new Pipeline({ getCfg: () => cfg, translations: svc, getWindows: () => [], clock: () => '12:00:00' });
  const evs = p.onLine({ channel: '!OCR', id: 0, sender: '', text: '[1] [Bob]: LF2M tank', cls: '', base: -1 });
  const added = evs.find(e => e.type === 'LineAdded');
  check(added && added.pending === true && sent.length === 1 && sent[0][0].includes('LF2M tank'), 'an OCR line is sent to the translation');
  check(sent[0][1] === 'google_free', 'its method is the one of its channel in the translation tab: ' + JSON.stringify(sent[0][1]));
  check(added.line.code === '!OCR' && added.line.plain.includes('LF2M tank') && (await import('../app/core/pipeline.js')).codePrefix('!OCR', 'basic') === '[OCR] ' && (await import('../app/core/pipeline.js')).codePrefix('!OCR', 'body') === '', 'the line is of the OCR channel and shows the "[OCR]" mark in front (not in the "text only" look)');
}

// the front of an OCR line (time, channel, name in brackets) is not translated and does not count for the language; [names] inside of the words are kept
{
  const { Pipeline, ocrFront } = await import('../app/core/pipeline.js');
  const { DEFAULTS } = await import('../app/core/config.js');
  const { log } = await import('../app/core/log.js'); log.quiet = true;
  eq([ocrFront('[16:48:36] [받은귓말] [Wazamano Bankai]: pls'), ocrFront('[1] [Bob] LF2M'), ocrFront('Questie: 오래된'), ocrFront('no front [x] here'), ocrFront('[a][b]')], ['[16:48:36] [받은귓말] [Wazamano Bankai]: ', '[1] [Bob] ', '', '', '[a][b]'], 'ocrFront: the time and the bracket groups at the beginning, with the ": " after them');
  const sent = [];
  const svc = { submit: (token, text) => { sent.push(text); return true; } };
  const cfg = { ...structuredClone(DEFAULTS), translator: 'openai', target_lang: '한국어' };
  const p = new Pipeline({ getCfg: () => cfg, translations: svc, getWindows: () => [], clock: () => '12:00:00' });
  const feed = text => p.onLine({ channel: '!OCR', id: 0, sender: '', text, cls: '', base: -1 });
  let evs = feed('[16:48:36] [받은귓말] [Wazamano Bankai]: pls');
  check(sent.at(-1) === 'pls' && evs[0].pending === true, 'a Korean channel name in the front does not stop the translation, and only the words go to the translator: ' + JSON.stringify(sent.at(-1)));
  const out = p.onTranslation(evs[0].line.id, '제발', null)[0];
  check(out.pieces.map(x => x.text).join('') === '[받은귓말] [Wazamano Bankai]: 제발', 'the front (without the time) is put back before the translation: ' + out.pieces.map(x => x.text).join('|'));
  evs = feed('[55:Wazamano Bankai]: ty');
  check(sent.at(-1) === 'ty', 'a line that is only a front and a short word: the word alone is translated');
  const n = sent.length;
  evs = feed('[16:48:52] Questie: 오래된 퀘스트 비전을 사용 중입니다');
  check(evs[0].pending === false && sent.length === n, 'Korean words in a Korean target are not translated');
  evs = feed('[1] [Bob]: LF2M need [Worn Hooked Claw] cheap');
  check(sent.at(-1) === 'LF2M need [L1] cheap', 'a [name] inside of the words is kept out of the translation: ' + sent.at(-1));
  const out2 = p.onTranslation(evs[0].line.id, '[Worn Hooked Claw] 싸게 구함 [L1]'.replace('[Worn Hooked Claw] ', ''), null)[0];
  check(out2.pieces.map(x => x.text).join('') === '[1] [Bob]: 싸게 구함 [Worn Hooked Claw]', 'the [name] is put back where the placeholder is: ' + out2.pieces.map(x => x.text).join('|'));
  const n2 = sent.length;
  evs = feed('[1] [Bob] [Worn Hooked Claw]');
  check(sent.length === n2 && evs[0].pending === false, 'a line with nothing but brackets is not translated');
}

// the time in front: taken off, with or without brackets, only the first thing of the line
{
  const o2 = await import('../app/core/ocr.js');
  eq(['[17:08:44] [받은귓말] [Kal]: hi', '17:08:44 [받은귓말] [Kal]: hi', '17:08:44[받은귓말] x', '(5:08 PM) hello', '5:08 pm hello', '12:30 hello', '[17:08] hello', '17:08:44'].map(o2.stripStamp),
    ['[받은귓말] [Kal]: hi', '[받은귓말] [Kal]: hi', '[받은귓말] x', 'hello', 'hello', 'hello', 'hello', ''], 'stripStamp: a time at the very beginning goes, with its brackets and the space');
  eq(['raid at 20:00 ok', '[Bob]: see you 18:30', '2024년 5월', '12:3 x', '123:45 x'].map(o2.stripStamp), ['raid at 20:00 ok', '[Bob]: see you 18:30', '2024년 5월', '12:3 x', '123:45 x'], 'stripStamp: a time inside of the words, or something that is not a time, stays');
  const { Pipeline } = await import('../app/core/pipeline.js');
  const { DEFAULTS } = await import('../app/core/config.js');
  const sent = [];
  const p2 = new Pipeline({ getCfg: () => ({ ...structuredClone(DEFAULTS), translator: 'openai' }), translations: { submit: (t, text) => { sent.push(text); return true; } }, getWindows: () => [], clock: () => '12:00:00' });
  const evs = p2.onLine({ channel: '!OCR', id: 0, sender: '', text: '17:08:44 [받은귓말] [Kal Vados]: Greeting mage!', cls: '', base: -1 });
  check(sent.at(-1) === 'Greeting mage!' && evs[0].line.plain === '[받은귓말] [Kal Vados]: Greeting mage!', 'the OCR line has no time of the game any more, the rest is as it was read: ' + evs[0].line.plain);
}
