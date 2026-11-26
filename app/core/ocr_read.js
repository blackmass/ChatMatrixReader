// OCR assist: the reading itself with an AI server that can see pictures (an OpenAI compatible server: LM Studio and the like). A picture of one chat line (the rows
// of it that were cut out by ocr_lines.js, all rows of a line that goes on in the next row) goes in, its text comes out. What the model must not do (translate, explain,
// guess) is in its prompt (prompts.js DEFAULT_OCR_PROMPT); what it does anyway is caught here.
import { openaiBase, reasoningExtras, cleanLlmOutput } from './translate.js';
import { TranslateError } from './translate_rules.js';
import { log } from './log.js';
import { tr } from './i18n.js';

// the server that reads: the one of the OCR tab, and what is empty there is the one of the translation tab
export function aiSettings(cfg) {
  const url = (cfg.ocr_ai_url || '').trim() || cfg.api_url, model = (cfg.ocr_ai_model || '').trim() || (cfg.api_model || '').trim(), key = (cfg.ocr_ai_key || '').trim() || (cfg.api_key || '').trim();
  return { base: openaiBase(url), model, key, timeout: Number(cfg.timeout ?? 30), extras: reasoningExtras(cfg) };
}

// image: { mime, base64 } -> what is sent
export function buildRequest(cfg, image, { maxTokens = 400, prompt = null } = {}) {
  const s = aiSettings(cfg);
  const body = {
    messages: [
      { role: 'system', content: prompt || cfg.ocr_prompt },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }] },
    ],
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
  };
  if (s.model) body.model = s.model;
  const headers = s.key ? { Authorization: 'Bearer ' + s.key } : {};
  return { url: s.base + '/chat/completions', headers, body, extras: s.extras, timeout: s.timeout, serverKey: s.base + '\n' + (s.model || '') };
}

// chatter that is no chat line: the model describes the picture or refuses instead of reading it
const CHATTER = /^(the (image|picture|screenshot|chat)\b|this (image|picture|screenshot)\b|i (can('|no)t|am unable|'m (sorry|unable))|sorry\b|here (is|are)\b|sure\b|certainly\b)/i;

// the time the game writes in front of a line ("[17:08:44]", "17:08:44", "5:08 PM"): our windows have their own time, so it is taken away
const STAMP = /^\s*\[?\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\]?\s*/i;
export const stripStamp = text => String(text ?? '').replace(STAMP, '');

// what the model said -> the text of the chat line (one line: the rows of a line that goes on are joined), '' when it is nothing to use
export function cleanReading(text) {
  let t = cleanLlmOutput(String(text ?? ''));
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  const rows = t.split(/\r?\n/).map(r => r.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!rows.length || CHATTER.test(rows[0])) return '';
  return stripStamp(rows.join(' ')).trim();
}

// what the model said about a picture that is no chat line (the manual capture: a comment of a party finder listing ...) -> its words in one piece, '' when it is nothing to use
// (no time is taken from the front of it: it is not the time of a chat line)
export function cleanFree(text) {
  let t = cleanLlmOutput(String(text ?? ''));
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  const rows = t.split(/\r?\n/).map(r => r.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!rows.length || CHATTER.test(rows[0])) return '';
  return rows.join(' ').trim();
}

// can this text be on a picture of this size? A line of `rows` rows of `lineH` pixels in a picture `w` wide holds at most so many letters (the narrowest letter is about
// a third of the height); a model that makes things up writes more
export function plausible(text, { w, rows = 1, lineH = 12 }) {
  const room = Math.ceil(w / Math.max(3, lineH * 0.3)) * Math.max(1, rows);
  return [...text].length <= Math.ceil(room * 1.3);
}

// text that is no chat line but the noise a model writes when it is shown letters it cannot read: one letter over and over, or loose Korean letter parts (ㅂㅗㅁㅅ...) of many kinds.
// (a real "ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ" is one kind of part and is let through)
export function degenerate(text) {
  const chars = [...String(text).replace(/\s+/g, '')];
  if (chars.length < 12) return false;
  const again = /(.)\1{11,}/u.exec(chars.join(''));
  if (again && !/[ㅋㅎㅠㅜㅡ.!?~\-=_*]/.test(again[1])) return true;                      // (12 of the same letter in a row)
  const jamo = chars.filter(c => /[\u3131-\u318E]/.test(c));
  return jamo.length / chars.length >= 0.3 && new Set(jamo).size >= 6;                  // (loose parts of many kinds)
}

export class AiReader {
  // http: makeHttp(transport) (or a fake); getCfg(): the settings
  constructor({ http, getCfg }) { Object.assign(this, { http, getCfg }); this.extrasRejected = new Set(); this.last = null; }

  // image: { mime, base64 }, geometry: { w, rows, lineH } of the picture (for the check) -> the text, '' when nothing could be read. Rejects with the reason when the server fails.
  // opts: { prompt, free } = the instructions of its own, and the words are no chat line (cleanFree, no check of the length)
  async read(image, geometry = {}, timing = null, opts = {}) {                      // (timing: an object that gets the time of this reading: with readings side by side `last` is the one that ended last)
    const cfg = this.getCfg();
    const t0 = performance.now();
    const rq = buildRequest(cfg, image, { maxTokens: opts.free ? 600 : Math.min(1200, 120 + 60 * Math.max(1, geometry.rows || 1)), prompt: opts.prompt || null });
    const withExtras = Object.keys(rq.extras).length && !this.extrasRejected.has(rq.serverKey);
    const t1 = performance.now();
    let data;
    try { data = await this.http.json(rq.url, withExtras ? { ...rq.body, ...rq.extras } : rq.body, rq.headers, rq.timeout); }
    catch (e) {
      if (!withExtras || !String(e?.message).startsWith('HTTP 400')) throw e;
      this.extrasRejected.add(rq.serverKey);                              // the server dislikes the extra fields: not again
      data = await this.http.json(rq.url, rq.body, rq.headers, rq.timeout);
    }
    const t2 = performance.now();
    // where the time of one reading went (for the log: what the program does before and after the request, and what the server says about itself)
    this.last = { build: t1 - t0, http: t2 - t1, usage: data && data.usage, stats: data && data.stats, bytes: JSON.stringify(rq.body).length };
    let out;
    try { out = data.choices[0].message.content; } catch { throw new TranslateError(tr('예상하지 못한 응답 형식')); }
    const text = opts.free ? cleanFree(out) : cleanReading(out);
    this.last.parse = performance.now() - t2;
    if (timing) Object.assign(timing, this.last);
    if (text && degenerate(text)) { log.info(`OCR: 글자가 아닌 것을 읽은 것 같아서 버렸습니다 | ${text.slice(0, 60)}`); return ''; }
    log.info(`OCR 읽기: 그림 ${geometry.w ?? '?'}px 폭, ${geometry.rows ?? '?'}줄 -> 모델 답: ${String(out ?? '').replace(/\s+/g, ' ').slice(0, 300)}${text ? '' : ' (쓸 수 없는 답: 버림)'}`);
    if (text && geometry.w && !plausible(text, geometry)) { log.info(`OCR: 그림에 들어갈 수 없는 길이라서 버렸습니다 (${[...text].length}글자)`); return ''; }
    return text;
  }
}

// ---- Windows OCR (the text recognition of Windows itself, docs/HANDOFF.md 4-0j): the picture is made ready here, the exe reads it (src-tauri/src/ocr_win.rs)
// A picture of BGRA pixels (the screen) -> the picture Windows OCR reads well: the strongest colour of each pixel is its grey (red, yellow, white, blue letters on a dark ground all become light),
// stretched between the ground and the letters and turned round (dark letters on a light ground; a chat on a light ground is the other way), `scale` times as large (smooth) with a light margin of
// `pad` pixels (a line of letters alone in a thin picture is read badly). -> { width, height, bgra } (every channel the same, alpha 255)
export function prepareForOcr(pic, { scale = 2, pad = 12 } = {}) {
  const { px, width: w, height: h } = pic, n = w * h;
  const g = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const o = i * 4, v = Math.max(px[o], px[o + 1], px[o + 2]); g[i] = v; hist[v]++; }
  const at = q => { let acc = 0; const t = q * n; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= t) return v; } return 255; };
  const ground = at(0.5), light = ground > 140;                         // the ground is most of the picture: its level is the middle one
  const edge = light ? at(0.005) : at(0.995);                             // the letters: the strongest end
  const span = Math.max(24, Math.abs(edge - ground));                      // (a picture with almost no letters is not stretched to noise)
  const grey = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = Math.min(1, Math.max(0, (light ? ground - g[i] : g[i] - ground) / span)); grey[i] = 255 - 255 * t; }
  const s = Math.max(1, Math.round(scale)), ow = w * s + 2 * pad, oh = h * s + 2 * pad;
  const bgra = new Uint8Array(ow * oh * 4).fill(255);
  for (let oy = 0; oy < h * s; oy++) {
    const fy = Math.min(h - 1, Math.max(0, (oy + 0.5) / s - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let ox = 0; ox < w * s; ox++) {
      const fx = Math.min(w - 1, Math.max(0, (ox + 0.5) / s - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const v = (grey[y0 * w + x0] * (1 - tx) + grey[y0 * w + x1] * tx) * (1 - ty) + (grey[y1 * w + x0] * (1 - tx) + grey[y1 * w + x1] * tx) * ty;
      const o = ((oy + pad) * ow + ox + pad) * 4, c = Math.round(v);
      bgra[o] = c; bgra[o + 1] = c; bgra[o + 2] = c;
    }
  }
  return { width: ow, height: oh, bgra };
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// macOS Vision (the exe reads: src-tauri/src/ocr_mac.rs, docs/HANDOFF.md 4-0al). The page gives the picture as a PNG ({ width, height, mime, base64 }, like the AI reader gets it: it is made in the page, which has a canvas); Vision
// reads the file as it is. There is no engine to start or to let go (the host asks `warm` / `release` only of Windows OCR). The languages are the ones of `ocr_win_lang` ("ko, en-US"; empty = Korean and English).
export class VisionReader {
  constructor({ invoke, getCfg }) { Object.assign(this, { invoke, getCfg }); this.last = null; this.asked = false; }

  // image: { base64 } (a PNG), geometry: { w, rows } -> the text, '' when nothing could be read. Rejects with the reason when Vision cannot read (no language ...).
  async read(image, geometry = {}) {
    const cfg = this.getCfg(), t0 = performance.now();
    if (!this.asked) {                                                   // (once: which languages Vision can read, for the log)
      this.asked = true;
      try { const info = await this.invoke('ocr_vision_info', {}); log.info(`OCR: macOS Vision이 읽을 수 있는 언어 ${info && info.languages && info.languages.length ? info.languages.join(', ') : '없음'}${info && info.error ? ' | ' + info.error : ''}`); }
      catch (e) { log.warn('OCR: macOS Vision의 언어를 알지 못했습니다: ' + String(e && e.message || e)); }
    }
    const t1 = performance.now();
    const raw = await this.invoke('ocr_vision', { image: image.base64, lang: String(cfg.ocr_win_lang || '').trim() });
    const t2 = performance.now();
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    this.last = { what: 'macOS Vision', build: t1 - t0, http: t2 - t1, parse: performance.now() - t2, bytes: String(image.base64 || '').length };
    log.info(`OCR 읽기: 그림 ${geometry.w ?? '?'}px 폭, ${geometry.rows ?? '?'}줄 -> macOS Vision 답: ${text.slice(0, 300)}${text ? '' : ' (읽은 것 없음)'}`);
    if (text && degenerate(text)) { log.info(`OCR: 글자가 아닌 것을 읽은 것 같아서 버렸습니다 | ${text.slice(0, 60)}`); return ''; }
    if (text && geometry.w && !plausible(text, geometry)) { log.info(`OCR: 그림에 들어갈 수 없는 길이라서 버렸습니다 (${[...text].length}글자)`); return ''; }
    return text;
  }
}

export class WindowsReader {
  // invoke: the call to the exe ('ocr_windows', 'ocr_windows_info'); getCfg(): the settings
  constructor({ invoke, getCfg }) { Object.assign(this, { invoke, getCfg }); this.last = null; this.asked = false; this.loaded = false; this.loading = false; }

  // the engine of Windows is made ready now / let go (the memory is given back): "resident" keeps it while the OCR is on, "only when needed" has it from the start of a restriction to its end
  async warm() {
    if (this.loaded || this.loading) return;
    this.loading = true;
    const t0 = performance.now();
    try { await this.invoke('ocr_windows_warm', { lang: String(this.getCfg().ocr_win_lang || '').trim() }); this.loaded = true; log.info(`OCR: Windows OCR 엔진을 올렸습니다 (${Math.round(performance.now() - t0)}ms)`); }
    finally { this.loading = false; }
  }
  async release() {
    if (!this.loaded) return;
    this.loaded = false;
    try { await this.invoke('ocr_windows_release', {}); log.info('OCR: Windows OCR 엔진을 내렸습니다 (메모리를 돌려줌)'); } catch { /* it is let go anyway on the next start */ }
  }

  // pic: { px, width, height } (BGRA), geometry: { w, rows, lineH } -> the text, '' when nothing could be read. Rejects with the reason when Windows cannot read (no language pack ...).
  async read(pic, geometry = {}) {
    const cfg = this.getCfg(), t0 = performance.now();
    const p = prepareForOcr(pic, { scale: cfg.ocr_x2 === true ? 2 : 1 }), bgra = toBase64(p.bgra);
    const t1 = performance.now();
    if (!this.asked) {                                                   // (once: which languages Windows can read, for the log: a missing language pack is the usual reason for nothing read)
      this.asked = true;
      try { const info = await this.invoke('ocr_windows_info', {}); log.info(`OCR: Windows OCR이 읽을 수 있는 언어 ${info && info.languages && info.languages.length ? info.languages.join(', ') : '없음'} (기본 ${info && info.current || '-'})${info && info.error ? ` | ${info.error}` : ''}`); } catch { /* the reading says what is wrong */ }
    }
    const t2 = performance.now();
    const raw = await this.invoke('ocr_windows', { bgra, width: p.width, height: p.height, lang: String(cfg.ocr_win_lang || '').trim() });
    const t3 = performance.now();
    this.loaded = true;
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    this.last = { what: 'Windows OCR', build: t1 - t0, http: t3 - t2, parse: performance.now() - t3, bytes: bgra.length };
    log.info(`OCR 읽기: 그림 ${geometry.w ?? '?'}px 폭, ${geometry.rows ?? '?'}줄 -> Windows OCR 답: ${text.slice(0, 300)}${text ? '' : ' (읽은 것 없음)'}`);
    if (text && degenerate(text)) { log.info(`OCR: 글자가 아닌 것을 읽은 것 같아서 버렸습니다 | ${text.slice(0, 60)}`); return ''; }
    if (text && geometry.w && !plausible(text, geometry)) { log.info(`OCR: 그림에 들어갈 수 없는 길이라서 버렸습니다 (${[...text].length}글자)`); return ''; }
    return text;
  }
}
