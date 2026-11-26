// macOS Vision OCR (core/ocr_read.js VisionReader, ocr_host.js, docs/HANDOFF.md 4-0al): the page gives the picture as a PNG, the exe reads it. The exe is a fake here.
globalThis.__TAURI__ = { core: { invoke: async c => (c === 'os_kind' ? 'macos' : undefined) } };         // (before the pages are loaded: this one runs on a Mac)
import { check, eq } from './helpers.mjs';
const { VisionReader } = await import('../app/core/ocr_read.js');
const { startOcr } = await import('../app/ocr_host.js');
const { DEFAULTS } = await import('../app/core/config.js');
const o = await import('../app/core/ocr.js');
const { log } = await import('../app/core/log.js'); log.quiet = true;

// ---- the reader
{
  const calls = []; let answer = '안녕하세요\n  반갑습니다 ';
  const invoke = async (cmd, args) => { calls.push([cmd, args]); if (cmd === 'ocr_vision_info') return { available: true, languages: ['ko-KR', 'en-US'] }; if (cmd === 'ocr_vision') { if (answer instanceof Error) throw answer; return answer; } };
  const cfg = { ocr_win_lang: ' ko, en-US ' };
  const r = new VisionReader({ invoke, getCfg: () => cfg });
  const text = await r.read({ width: 10, height: 10, mime: 'image/png', base64: 'QUJD' }, { w: 300, rows: 2 });
  eq(text, '안녕하세요 반갑습니다', 'the lines are one line of text, the spaces are cleaned');
  eq(calls.map(c => c[0]), ['ocr_vision_info', 'ocr_vision'], 'the languages are asked once, then the picture is read');
  eq(calls[1][1], { image: 'QUJD', lang: 'ko, en-US' }, 'the exe gets the PNG in base64 and the languages of the options (trimmed)');
  await r.read({ base64: 'QUJD' }, {});
  eq(calls.map(c => c[0]), ['ocr_vision_info', 'ocr_vision', 'ocr_vision'], 'the languages are not asked again');
  check(r.last && r.last.what === 'macOS Vision', 'the time of the reading is kept for the log');
  answer = '';
  eq(await r.read({ base64: 'QUJD' }, {}), '', 'nothing read: an empty text');
  answer = 'ㅂㅗㅁㅅㅇㅈㅊㅋㅌㅍㅎㄱㄴ';
  eq(await r.read({ base64: 'QUJD' }, { w: 300 }), '', 'loose letter parts of many kinds are thrown away');
  answer = '가나다라마바사아자차카타파하'.repeat(40);
  eq(await r.read({ base64: 'QUJD' }, { w: 100, rows: 1, lineH: 12 }), '', 'a text too long for the picture is thrown away');
  answer = new Error('no language');
  let err = null; try { await r.read({ base64: 'QUJD' }, {}); } catch (e) { err = e; }
  check(err && /no language/.test(err.message), 'what the exe says about a reading that failed is passed on');
  const bad = new VisionReader({ invoke: async c => { if (c === 'ocr_vision_info') throw new Error('x'); return 'ok'; }, getCfg: () => ({}) });
  eq(await bad.read({ base64: 'QUJD' }, {}), 'ok', 'a failed question for the languages does not stop the reading');
}

// ---- the options
{
  eq(o.READERS().map(x => x[0]), ['ai', 'vision'], 'on a Mac the readers are the AI and Vision');
  check(o.readerWhy('vision') === '' && o.reader({ ocr_read: 'vision' }) === 'vision', 'Vision is ready and is chosen as it is');
  check(o.reader({ ocr_read: 'windows' }) === 'ai', 'Windows OCR is not a reader of a Mac');
}

// ---- the host reads with Vision
{
  const cfg = { ...structuredClone(DEFAULTS), ocr_enabled: true, ocr_read: 'vision' };
  const asked = [], said = [];
  const vis = { read: async (image, geo) => { asked.push([image, geo]); return 'LFM 던전'; }, last: { what: 'macOS Vision' } };
  const ai = { read: async () => { throw new Error('the AI is not to be called'); } };
  const ocr = startOcr({ settings: { cfg: () => cfg }, tickMs: 0, system: t => said.push(t), listen: null, emit: null, http: null, capture: { clientSize: () => null }, pipeline: { onLine: () => [], observe: () => () => {} }, publish: () => {},
    encode: (pic, opt) => ({ mime: 'image/png', base64: `PNG${pic.width}x${pic.height}s${opt.scale}` }), reader: ai, visReader: vis });
  eq(ocr.freeProblem(), '', 'Vision is there: a picture can be read as words');
  const text = await ocr.readFree({ px: new Uint8Array(16), width: 2, height: 2 });
  eq(text, 'LFM 던전', 'a picture read as words goes to Vision');
  eq(asked[0][0], { mime: 'image/png', base64: 'PNG2x2s2' }, 'as a PNG, made 2 times as large like the pictures of the AI');
  check(ocr.canRead(), 'the OCR is on and a reader is there');
  cfg.ocr_read = 'ai';
  check(!ocr.freeProblem() && ocr.freeProblem() === '', 'the AI reader still counts as ready');
}
{
  const cfg = { ...structuredClone(DEFAULTS), ocr_enabled: true, ocr_read: 'vision' };
  const ocr = startOcr({ settings: { cfg: () => cfg }, tickMs: 0, system: () => {}, listen: null, emit: null, http: null, capture: { clientSize: () => null }, pipeline: { onLine: () => [], observe: () => () => {} }, publish: () => {}, encode: () => ({ base64: '' }), reader: { read: async () => '' } });
  check(ocr.freeProblem() !== '', 'with no exe to ask (invoke is null) there is no Vision: the reason is told');
}
