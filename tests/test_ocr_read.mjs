// Reading a picture of a chat line with an AI server (core/ocr_read.js): the request, what the answer is cleaned of, what is thrown away, the server of the translation tab as the fallback.
import { check, eq } from './helpers.mjs';
const { DEFAULTS } = await import('../app/core/config.js');
const r = await import('../app/core/ocr_read.js');
const cfg = (o = {}) => ({ ...structuredClone(DEFAULTS), api_url: 'http://localhost:1234/v1', api_model: 'gemma', api_key: 'tk', ...o });
const IMG = { mime: 'image/png', base64: 'AAAA' };

// the request
{
  const q = r.buildRequest(cfg(), IMG);
  check(q.url === 'http://localhost:1234/v1/chat/completions' && q.body.model === 'gemma' && q.headers.Authorization === 'Bearer tk', 'it uses the server of the translation tab when the OCR tab has none');
  check(q.body.messages[1].content[0].image_url.url === 'data:image/png;base64,AAAA' && q.body.messages[0].content === DEFAULTS.ocr_prompt && q.body.temperature === 0, 'the picture goes in as a data address, the system text is the reading prompt, no randomness');
  const q2 = r.buildRequest(cfg({ ocr_ai_url: 'http://10.0.0.5:8080', ocr_ai_model: 'vis', ocr_ai_key: '' }), IMG);
  check(q2.url === 'http://10.0.0.5:8080/v1/chat/completions' && q2.body.model === 'vis' && q2.headers.Authorization === 'Bearer tk', 'the OCR tab\'s address and model are used; an empty key follows the translation tab');
}

// what the answer is cleaned of
eq([r.cleanReading('  [1] [Bob]: LF2M  '), r.cleanReading('```\nline one\nline two\n```'), r.cleanReading('<think>hmm</think>real text'), r.cleanReading('a\n\nb  c')], ['[1] [Bob]: LF2M', 'line one line two', 'real text', 'a b c'], 'cleanReading: spaces, a code fence, thinking, the rows of a line that goes on are joined');
eq([r.cleanReading('The image shows a chat window'), r.cleanReading("I can't read this"), r.cleanReading('Sorry, ...'), r.cleanReading(''), r.cleanReading(null)], ['', '', '', '', ''], 'cleanReading: a description or a refusal is nothing');
check(r.plausible('x'.repeat(40), { w: 300, rows: 1, lineH: 12 }) && !r.plausible('x'.repeat(400), { w: 300, rows: 1, lineH: 12 }) && r.plausible('x'.repeat(150), { w: 300, rows: 2, lineH: 12 }), 'plausible: a text that cannot be in the picture is not (rows add room)');

// the reader
{
  let sent = [];
  const http = { json: async (url, body, headers) => { sent.push({ url, body, headers }); return { choices: [{ message: { content: '[1] [Bob]: LF2M tank' } }] }; } };
  const rd = new r.AiReader({ http, getCfg: () => cfg() });
  eq(await rd.read(IMG, { w: 300, rows: 1, lineH: 12 }), '[1] [Bob]: LF2M tank', 'it returns the text');
  check(sent.length === 1 && sent[0].body.chat_template_kwargs !== undefined, 'the fields that switch the thinking off are sent first');
}
{
  let n = 0; const bodies = [];
  const http = { json: async (url, body) => { n++; bodies.push(body); if (body.chat_template_kwargs) throw new Error('HTTP 400 unknown field'); return { choices: [{ message: { content: 'ok' } }] }; } };
  const rd = new r.AiReader({ http, getCfg: () => cfg() });
  eq(await rd.read(IMG), 'ok', 'a server that does not know the extra fields (HTTP 400) is asked again without them');
  await rd.read(IMG);
  check(n === 3 && !bodies[2].chat_template_kwargs, 'and it is not tried with them again');
}
{
  const http = { json: async () => ({ choices: [{ message: { content: 'x'.repeat(900) } }] }) };
  eq(await new r.AiReader({ http, getCfg: () => cfg() }).read(IMG, { w: 200, rows: 1, lineH: 12 }), '', 'a text that is too long for the picture is thrown away');
  const bad = { json: async () => ({ nope: 1 }) };
  let err = ''; try { await new r.AiReader({ http: bad, getCfg: () => cfg() }).read(IMG); } catch (e) { err = String(e.message); }
  check(err.length > 0, 'an answer in a form that is not expected is an error: ' + err);
  const down = { json: async () => { throw new Error('연결 실패'); } };
  err = ''; try { await new r.AiReader({ http: down, getCfg: () => cfg() }).read(IMG); } catch (e) { err = String(e.message); }
  check(err === '연결 실패', 'a server that is down is an error, passed on');
}

// the time of the game in front of a line is taken away
eq(['[17:08:44] [받은귓말] [Kal Vados]: hi', '17:08:44 [받은귓말] hi', '5:08 PM [1] [Bob]: x', '[1] [Bob]: meet at 10:30', '10:30 raid'].map(t => r.cleanReading(t)), ['[받은귓말] [Kal Vados]: hi', '[받은귓말] hi', '[1] [Bob]: x', '[1] [Bob]: meet at 10:30', 'raid'], 'cleanReading: the time at the beginning goes, a time inside of the words stays');

// noise that is no chat line
{
  check(r.degenerate('ㅂㅗㅁㄷㄱㅅㅣㅇㅏㅈㅓㅁㅗㅇㅅㅜㅡ ㅣㅋㅋㅋㅋㅋㅋㅋㅋㅋ 2222222222222222222222 가하기]'), 'degenerate: loose letter parts of many kinds and a row of the same digit');
  check(r.degenerate('2222222222222222222222222222') && r.degenerate('aaaaaaaaaaaaaaaaaaaaa'), 'degenerate: one letter over and over');
  check(!r.degenerate('ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ') && !r.degenerate('...............') && !r.degenerate('LF2M tank and healer for +12') && !r.degenerate('ㅎㅇ') && !r.degenerate('안녕하세요 반갑습니다 오늘도 좋은 하루'), 'degenerate: real chat is let through, also a long "ㅋㅋㅋ"');
  const http = { json: async () => ({ choices: [{ message: { content: 'ㅂㅗㅁㄷㄱㅅㅣㅇㅏㅈㅓㅁㅗㅇㅅㅜㅡ 2222222222222222222222 가하기]' } }] }) };
  eq(await new r.AiReader({ http, getCfg: () => cfg() }).read(IMG, { w: 400, rows: 1, lineH: 12 }), '', 'the reader throws such an answer away');
}

// ---- Windows OCR: the picture is made ready here (docs/HANDOFF.md 4-0j)
{
  const mk = (w, h, ground, letter, strokes) => {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = ground[2]; px[i * 4 + 1] = ground[1]; px[i * 4 + 2] = ground[0]; px[i * 4 + 3] = 255; }
    for (const [x, y] of strokes) { const o = (y * w + x) * 4; px[o] = letter[2]; px[o + 1] = letter[1]; px[o + 2] = letter[0]; }
    return { px, width: w, height: h };
  };
  const strokes = []; for (let x = 4; x < 30; x += 6) for (let dx = 0; dx < 3; dx++) for (let y = 3; y < 12; y++) strokes.push([x + dx, y]);       // (strokes of three pixels, like the letters of a chat)
  const red = r.prepareForOcr(mk(40, 16, [20, 14, 14], [230, 40, 40], strokes), { scale: 2, pad: 12 });
  check(red.width === 40 * 2 + 24 && red.height === 16 * 2 + 24 && red.bgra.length === red.width * red.height * 4, 'the picture is twice as large with a margin of 12 on every side: ' + red.width + 'x' + red.height);
  const px = (p, x, y) => p.bgra[(y * p.width + x) * 4];
  const region = (p, x0, y0, x1, y1) => { const v = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) v.push(px(p, x, y)); return v; };
  check(px(red, 2, 2) === 255 && px(red, red.width - 3, red.height - 3) === 255, 'the margin is light');
  check(Math.min(...region(red, 12 + 2 * 4, 12 + 2 * 3, 12 + 2 * 28, 12 + 2 * 11)) < 30 && Math.min(...region(red, 12, 12, 12 + 5, 12 + 5)) > 240, 'red letters on a dark ground become dark letters on a light ground (the strokes have dark pixels, the ground is light)');
  check([...red.bgra].filter((v, i) => i % 4 === 3).every(a => a === 255), 'alpha is 255 everywhere');
  const light = r.prepareForOcr(mk(40, 16, [230, 230, 230], [40, 30, 30], strokes), { scale: 2, pad: 12 });
  check(Math.min(...region(light, 12 + 2 * 4, 12 + 2 * 3, 12 + 2 * 28, 12 + 2 * 11)) < 30 && Math.min(...region(light, 12, 12, 12 + 5, 12 + 5)) > 240, 'a chat on a light ground: the letters are dark, the ground light');
  const flat = r.prepareForOcr(mk(40, 16, [20, 14, 14], [22, 14, 14], strokes), { scale: 2, pad: 12 });
  check(Math.min(...flat.bgra.filter((v, i) => i % 4 === 0)) > 200, 'a picture with almost no letters is not stretched into noise');
  check(r.toBase64(new Uint8Array([77, 97, 110])) === 'TWFu' && r.toBase64(new Uint8Array(100000)).length === Math.ceil(100000 / 3) * 4, 'base64 of small and large bytes');
}
{
  const calls = [];
  const fake = answer => async (cmd, args) => { calls.push([cmd, args]); if (cmd === 'ocr_windows_info') return { languages: ['ko', 'en-US'], current: 'ko' }; if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer(args) : answer; };
  const pic = { px: new Uint8Array(40 * 16 * 4).fill(30), width: 40, height: 16 };
  const w = new r.WindowsReader({ invoke: fake('  [03:12] 살타리온의 외침:\n 불타라!  '), getCfg: () => cfg({ ocr_win_lang: 'ko', ocr_x2: true }) });
  const text = await w.read(pic, { w: 426, rows: 1, lineH: 14 });
  check(text === '[03:12] 살타리온의 외침: 불타라!', 'the lines are joined and the spaces tidied: ' + text);
  const q = calls.find(c => c[0] === 'ocr_windows')[1];
  check(q.width === 104 && q.height === 56 && q.lang === 'ko' && Buffer.from(q.bgra, 'base64').length === 104 * 56 * 4, 'the call has the size of the made picture, its pixels as base64 and the language of the settings');
  { const c1 = []; const one = new r.WindowsReader({ invoke: async (cmd, args) => { c1.push([cmd, args]); return cmd === 'ocr_windows_info' ? { languages: [], current: '' } : 'x'; }, getCfg: () => cfg({ ocr_win_lang: 'ko' }) }); await one.read(pic, { w: 40, rows: 1, lineH: 14 });
    const q1 = c1.find(c => c[0] === 'ocr_windows')[1]; check(q1.width === 64 && q1.height === 40, 'with the option 2x off (the default) the picture is made as it is, with its margin: ' + q1.width + 'x' + q1.height); }
  check(calls.filter(c => c[0] === 'ocr_windows_info').length === 1, 'the languages are asked once');
  await w.read(pic, { w: 40, rows: 1, lineH: 14 });
  check(calls.filter(c => c[0] === 'ocr_windows_info').length === 1, '... and not again');
  check(w.last && w.last.what === 'Windows OCR' && Number.isFinite(w.last.build) && Number.isFinite(w.last.http) && Number.isFinite(w.last.parse), 'the time of the last reading is kept');
  const none = new r.WindowsReader({ invoke: fake(''), getCfg: () => cfg() });
  check(await none.read(pic, { w: 40, rows: 1, lineH: 14 }) === '' && calls.at(-1)[1].lang === '', 'nothing read: an empty text; no language in the settings: the language of the user (empty)');
  const junk = new r.WindowsReader({ invoke: fake('aaaaaaaaaaaaaaaaaaaa'), getCfg: () => cfg() });
  check(await junk.read(pic, { w: 40, rows: 1, lineH: 14 }) === '', 'a text that is no letters is thrown away');
  const long = new r.WindowsReader({ invoke: fake('abcdefghij '.repeat(40)), getCfg: () => cfg() });
  check(await long.read(pic, { w: 40, rows: 1, lineH: 14 }) === '', 'a text that cannot be in the picture is thrown away');
  let msg = '';
  try { await new r.WindowsReader({ invoke: fake(new Error('Windows OCR cannot read the language ko')), getCfg: () => cfg() }).read(pic, {}); } catch (e) { msg = String(e.message); }
  check(msg.includes('cannot read the language'), 'what Windows says is passed on: ' + msg);
}

// ---- the engine of Windows OCR: ready / let go (resident, only when needed)
{
  const calls = [];
  const invoke = async (cmd, args) => { calls.push([cmd, args]); return cmd === 'ocr_windows_info' ? { languages: ['ko'], current: 'ko' } : cmd === 'ocr_windows' ? 'x' : undefined; };
  const w = new r.WindowsReader({ invoke, getCfg: () => cfg({ ocr_win_lang: 'ko' }) });
  check(!w.loaded, 'not ready at the start');
  await w.warm(); await w.warm();
  check(w.loaded && calls.filter(c => c[0] === 'ocr_windows_warm').length === 1 && calls[0][1].lang === 'ko', 'warm: made ready once, with the language of the settings');
  await w.release(); await w.release();
  check(!w.loaded && calls.filter(c => c[0] === 'ocr_windows_release').length === 1, 'release: let go once');
  await w.read({ px: new Uint8Array(40 * 16 * 4).fill(30), width: 40, height: 16 }, { w: 400, rows: 1, lineH: 14 });
  check(w.loaded, 'a reading makes the engine (the exe does), so it counts as ready');
  const bad = new r.WindowsReader({ invoke: async () => { throw new Error('no language'); }, getCfg: () => cfg() });
  let msg = '';
  try { await bad.warm(); } catch (e) { msg = String(e.message); }
  check(msg === 'no language' && !bad.loaded && !bad.loading, 'a failing warm-up says why, and the reader is not left "loading"');
}

// the reading of a picture that is no chat line (the manual capture: the comment of a party finder listing): a prompt of its own, the words in one piece, no time taken from the front
{
  const q = r.buildRequest(cfg(), IMG, { prompt: DEFAULTS.ocr_cap_prompt });
  check(q.body.messages[0].content === DEFAULTS.ocr_cap_prompt && q.body.messages[0].content !== DEFAULTS.ocr_prompt, 'the request has the prompt of the manual capture when it is given');
  eq(r.cleanFree('12:30 LFM UBRS\nfull, have key'), '12:30 LFM UBRS full, have key', 'free words: the rows are joined, the time at the front is not taken away');
  eq(r.cleanFree('Sure, here is the text'), '', 'chatter that is no reading is thrown away');
  let sent = null;
  const ai = new r.AiReader({ http: { json: async (url, body) => { sent = body; return { choices: [{ message: { content: '9:15 LFM full\nhave key' } }] }; } }, getCfg: () => cfg() });
  const text = await ai.read(IMG, {}, null, { prompt: 'READ IT', free: true });
  check(text === '9:15 LFM full have key' && sent.messages[0].content === 'READ IT', 'the reader uses the prompt and keeps the words as they are: ' + text);
  const line = await ai.read(IMG, { w: 400, rows: 1 });
  check(line === 'LFM full have key', 'a chat line is read as before (the time is taken away, the rows are one line): ' + line);
}
