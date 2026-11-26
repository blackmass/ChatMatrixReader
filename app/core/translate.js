// The translation requests: OpenAI-compatible chat API (LM Studio, OpenAI ...), Google Translate (key-less and Cloud API key) and
// "custom HTTP" services (DeepL, Azure, Papago, LibreTranslate, Claude, Gemini ...). Port of translator.py (everything but the
// queue, which is in translation_service.js).
//
// The program never touches the network itself: every request goes through ONE function, the transport
//     transport({ url, method, headers: [[name, value], ...], body, timeout }) -> { status, body }      (throws on network trouble)
// which in the exe is the Rust command `http_request` (src-tauri/src/main.rs). Google's rules (docs/PORTING_NOTES.md §3: TLS 1.3,
// ALPN http/1.1, 0.4 s spacing, pauses after 429/403) are kept on both sides: spacing and pauses here, TLS in the Rust client.
import { log } from './log.js';
import { tr } from './i18n.js';
import { TranslateError, TransientError, RateLimited, langCode, applyRoute, sendRoute } from './translate_rules.js';
import { PLACEHOLDER, unmaskLinks } from './chattext.js';
import { mode as glossaryMode } from './glossary.js';
import { DEFAULT_PROMPT, DEFAULT_SEND_PROMPT } from './prompts.js';

export { DEFAULT_PROMPT, DEFAULT_SEND_PROMPT };
export const GOOGLE_GTX_URL = 'https://translate.googleapis.com/translate_a/single';       // the key-less endpoint of the web UI
export const GOOGLE_V2_URL = 'https://translation.googleapis.com/language/translate/v2';  // the official one (with an API key)
export const GOOGLE_MIN_INTERVAL = 0.4;          // seconds between two requests to the key-less endpoint
export const DEFAULT_REASONING_OFF = '{"reasoning_effort": "none", "chat_template_kwargs": {"enable_thinking": false}}';
export const TRANSLATOR_LABELS = {
  none: '사용 안 함 (원문만)', openai: 'OpenAI 호환 API (LM Studio 등)', google_free: 'Google 번역 (무료)',
  google: 'Google 번역 (유료, API Key)', custom: '사용자 정의 HTTP (DeepL, Azure 등)',
};

export class SettingsError extends Error {}       // the user's own request settings cannot work (text for the user)

const short = (text, n = 80) => (text || '').replace(/\n/g, ' ').slice(0, n);
// json.dumps(v, ensure_ascii=False) of Python (", " and ": " separators): the answer fragments shown in error messages look as before
function pyDumps(v) {
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + pyDumps(x)).join(', ') + '}';
  return JSON.stringify(v) ?? 'null';
}
const jsonShort = (v, n) => pyDumps(v).slice(0, n);
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// urllib.parse.quote(s, safe="") / quote_plus: letters, digits and _.-~ stay, everything else is %XX of its UTF-8
export const quote = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export const quotePlus = s => quote(s).replace(/%20/g, '+');
export const urlencode = pairs => pairs.map(([k, v]) => quotePlus(String(k)) + '=' + quotePlus(String(v))).join('&');

// ----------------------------------------------------------------------
// prompts
// ----------------------------------------------------------------------
export const EXTRA_PLACEHOLDER = '{{extra_prompt}}';
export const EXTRA_HEADER = 'Additional instructions from the user (they concern the style or wording of the translation only; '
  + 'every rule above still applies, and you still output ONLY the translation):\n';
const EXTRA_MARK = '\x00EXTRA\x00';

// The system prompt. `extra` = the user's own additional instructions: they go where the prompt has {{extra_prompt}} (the default
// prompt: at its very end), else they are appended at the end. Empty = nothing is added.
export async function renderPrompt(glossary, prompt, targetLang, mode = 'full', extra = '', glossaryName = '') {
  extra = (extra || '').trim();
  let text = (prompt || DEFAULT_PROMPT).split(EXTRA_PLACEHOLDER).join(EXTRA_MARK);
  text = text.split('{target_lang}').join(targetLang);                  // plain replace: braces in the user's text can never break it
  text = await glossary.expandPlaceholders(text, mode, glossaryName);   // {{Glossary.txt}} -> file content
  const block = extra ? EXTRA_HEADER + extra : '';                      // inserted last: the user's text is never expanded
  if (text.includes(EXTRA_MARK)) return block ? text.split(EXTRA_MARK).join(block) : text.split(EXTRA_MARK).join('').trimEnd() + '\n';
  return block ? text.trimEnd() + '\n\n' + block + '\n' : text;
}

// the settings the sending direction translates with (before its route is applied)
export function sendCfg(cfg) {
  const lang = (cfg.send_lang || 'English').trim() || 'English';
  const prompt = (cfg.send_prompt || DEFAULT_SEND_PROMPT).split('{send_lang}').join(lang);
  // no Korean-glossary rewriting on the way out; the extra instructions are the sending ones (never those of the received lines)
  return { ...cfg, target_lang: lang, prompt, glossary_google: false, extra_prompt: cfg.send_extra_prompt ?? null };
}

// ----------------------------------------------------------------------
// HTTP: transport -> parsed JSON, the errors of translator.py
// ----------------------------------------------------------------------
const isTimeout = e => e?.timeout === true || e?.name === 'TimeoutError' || /time(d)?[ -]?out/i.test(String(e?.message ?? e));

export function makeHttp(transport, { timerSlack = 3 } = {}) {
  const v4Bad = new Set();            // ports where 127.0.0.1 failed but "localhost" answered (servers on IPv6 only)

  // "localhost" is tried as IPv6 (::1) first by many stacks; a server on IPv4 only costs ~2 s per request then. So a local
  // address is connected as 127.0.0.1 directly.
  function preferV4(url) {
    let u; try { u = new URL(url); } catch { return url; }
    if (u.hostname.toLowerCase() !== 'localhost' || v4Bad.has(u.port)) return url;
    u.hostname = '127.0.0.1';
    return u.toString();
  }

  async function once(url, method, headers, body, timeout) {
    let timer;
    try {
      return await Promise.race([
        transport({ url, method, headers: Object.entries(headers), body: body ?? null, timeout }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timed out'), { timeout: true })), (timeout + timerSlack) * 1000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function request(url, method, headers, body, timeout) {
    const first = preferV4(url);
    let res;
    try {
      try { res = await once(first, method, headers, body, timeout); }
      catch (e) {
        if (first === url || isTimeout(e)) throw e;
        v4Bad.add(new URL(url).port);                            // the server listens on IPv6 only: back to the name "localhost"
        res = await once(url, method, headers, body, timeout);
      }
    } catch (e) {
      if (isTimeout(e)) throw new TransientError(tr('응답 시간 초과'));
      throw new TransientError(tr('연결 실패: {reason}', { reason: String(e?.message ?? e) }));
    }
    const status = Number(res.status), text = String(res.body ?? '');
    if (status >= 400) {
      const snippet = text.slice(0, 200);
      if (status === 403 || status === 429) log.info(`HTTP ${status} 응답 본문: ${text.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).join(' ').slice(0, 400)}`);
      const msg = `HTTP ${status} ${snippet}`.trim();
      throw (status >= 500 || status === 408) ? new TransientError(msg) : new TranslateError(msg);
    }
    try { return JSON.parse(text); } catch { throw new TranslateError(tr('JSON이 아닌 응답') + ': ' + text.slice(0, 100)); }
  }

  const base = { 'User-Agent': 'ChatMatrixReader/3.0', Accept: 'application/json' };
  return {
    // POST a JSON payload (GET when payload is null)
    json: (url, payload = null, headers = null, timeout = 30) => request(url, payload === null ? 'GET' : 'POST',
      { ...base, ...(payload === null ? {} : { 'Content-Type': 'application/json' }), ...(headers || {}) },
      payload === null ? null : JSON.stringify(payload), timeout),
    // POST an already encoded form body
    form: (url, body, headers = null, timeout = 30) => request(url, 'POST', { ...base, ...(headers || {}) }, body, timeout),
  };
}

// ----------------------------------------------------------------------
// small helpers of the backends
// ----------------------------------------------------------------------
export function openaiBase(url) {
  let u = (url || '').trim();
  if (!u) throw new TranslateError(tr('API URL이 비어 있습니다'));
  if (!u.includes('://')) u = 'http://' + u;
  u = u.replace(/\/+$/, '');
  if (u.endsWith('/chat/completions')) u = u.slice(0, -'/chat/completions'.length);
  let path = '';
  try { path = new URL(u).pathname; } catch { /* keep '' */ }
  if (path === '' || path === '/') u += '/v1';                    // "http://localhost:1234" -> ".../v1"
  return u;
}

// <think>...</think> out; thinking that was cut off before it finished leaves nothing
export function cleanLlmOutput(s) {
  s = (s || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (/^\s*<think>/i.test(s)) return '';
  return s.trim();
}

export function reasoningExtras(cfg) {
  if (!(cfg.disable_reasoning ?? true)) return {};
  const raw = (cfg.reasoning_off_body || DEFAULT_REASONING_OFF).trim();
  let extra;
  try { extra = JSON.parse(raw); } catch { throw new TranslateError(tr("'추론 끄기용 JSON'이 올바른 JSON이 아닙니다")); }
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) throw new TranslateError(tr("'추론 끄기용 JSON'은 { } 객체여야 합니다"));
  return extra;
}

// Which chat line keys of the Google answer: "ko" for "한국어" ... (langCode is in translate_rules.js)
export const googleKey = cfg => (cfg.google_free ? '' : (cfg.google_api_key || '').trim());

function googleKeyHint(msg) {
  const m = msg.toLowerCase();
  if (m.includes('api key not valid') || m.includes('api_key_invalid')) return tr('API 키가 올바르지 않습니다 (v3·서비스 계정 JSON이 아니라 Basic v2용 API 키가 필요합니다)');
  if (m.includes('has not been used') || m.includes('service_disabled') || m.includes('accessnotconfigured')) return tr('프로젝트에서 Cloud Translation API가 켜져 있지 않습니다');
  if (m.includes('api_key_service_blocked') || m.includes('referer') || m.includes('ip address')) return tr('API 키 제한 설정 때문에 거부되었습니다 (키의 API 제한에 Cloud Translation API 포함, 앱/IP 제한 없음)');
  if (m.includes('billing')) return tr('프로젝트에 결제 계정이 연결되어 있지 않습니다');
  return '';
}

// ----------------------------------------------------------------------
// custom HTTP: presets, placeholders, answer path
// ----------------------------------------------------------------------
// name: [url, headers, body type, body, answer path, note] - written from the services' public documentation
export const CUSTOM_PRESETS = {
  'DeepL Free': ['https://api-free.deepl.com/v2/translate', '{"Authorization": "DeepL-Auth-Key {key}"}', 'json',
    '{"text": ["{text}"], "target_lang": "{TARGET}"}', 'translations.0.text', '무료 키(끝이 :fx)입니다. 영어는 EN-US 처럼 지역까지 써야 할 수 있습니다.'],
  'DeepL Pro': ['https://api.deepl.com/v2/translate', '{"Authorization": "DeepL-Auth-Key {key}"}', 'json',
    '{"text": ["{text}"], "target_lang": "{TARGET}"}', 'translations.0.text', ''],
  'Azure Translator': ['https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to={target}', '{"Ocp-Apim-Subscription-Key": "{key}"}', 'json',
    '[{"Text": "{text}"}]', '0.translations.0.text', '지역 리소스면 헤더에 "Ocp-Apim-Subscription-Region": "지역" 을 추가하세요. 중국어는 zh-Hans / zh-Hant 입니다.'],
  'Papago (NAVER Cloud)': ['https://papago.apigw.ntruss.com/nmt/v1/translation', '{"X-NCP-APIGW-API-KEY-ID": "{key1}", "X-NCP-APIGW-API-KEY": "{key2}"}', 'form',
    'source=en&target={target}&text={text}', 'message.result.translatedText', "API Key 칸에 '아이디:시크릿' 으로 쓰세요. 원문 언어를 자동 감지하지 않으므로 source= 를 고정해야 합니다."],
  LibreTranslate: ['https://libretranslate.com/translate', '{}', 'json',
    '{"q": "{text}", "source": "auto", "target": "{target}", "format": "text", "api_key": "{key}"}', 'translatedText', '직접 서버를 돌리면 주소만 바꾸세요 (키가 없으면 api_key 를 빼도 됩니다).'],
  'Claude (Anthropic API)': ['https://api.anthropic.com/v1/messages', '{"x-api-key": "{key}", "anthropic-version": "2023-06-01"}', 'json',
    '{"model": "claude-haiku-5-5", "max_tokens": 1024, "thinking": {"type": "disabled"}, "system": "{system}", "messages": [{"role": "user", "content": "{text}"}]}',
    'content.0.text', '프롬프트 칸의 내용이 {system} 자리에 들어갑니다 (단어장도 그 프롬프트로 전달). 모델 이름은 직접 바꿀 수 있습니다.'],
  'Gemini (Google AI Studio)': ['https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent', '{"x-goog-api-key": "{key}"}', 'json',
    '{"systemInstruction": {"parts": [{"text": "{system}"}]}, "contents": [{"role": "user", "parts": [{"text": "{text}"}]}], "generationConfig": {"temperature": 0.2}}',
    'candidates.0.content.parts.0.text',
    '키는 Google AI Studio 에서 무료로 받습니다. 모델 이름은 주소 안(models/ 뒤)에 있고 직접 바꿀 수 있습니다. 프롬프트 칸의 내용이 {system} 자리에 들어갑니다 (단어장도 그 프롬프트로 전달). '
    + '무료 사용은 한도가 낮고 입력한 내용이 구글 서비스 개선에 쓰일 수 있습니다 (유료 결제를 연결하면 쓰이지 않습니다).'],
};
export const CUSTOM_PRESET_MANUAL = '직접 입력';
const CUSTOM_VAR = /\{(text|key|key1|key2|target|TARGET|system)\}/g;

// changes whenever the custom request settings change (part of the cache key)
export const customSignature = cfg => (cfg.translator !== 'custom' ? '' :
  JSON.stringify(['custom_url', 'custom_headers', 'custom_body_type', 'custom_body', 'custom_path'].map(k => cfg[k] ?? null)));

// {text} {key} ... in one pass (a chat line that contains '{key}' is never expanded again)
const fill = (s, vals, quoted = false) => s.replace(CUSTOM_VAR, (_, name) => (quoted ? quote(vals[name]) : vals[name]));
function fillJson(node, vals) {
  if (typeof node === 'string') return fill(node, vals);
  if (Array.isArray(node)) return node.map(x => fillJson(x, vals));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillJson(v, vals)]));
  return node;
}

// throws SettingsError (text for the user) when the custom request settings cannot work
export function customCheck(cfg) {
  if (!/^https?:\/\//i.test((cfg.custom_url || '').trim())) throw new SettingsError(tr('사용자 정의: 주소는 http:// 또는 https:// 로 시작해야 합니다.'));
  try {
    const h = JSON.parse(cfg.custom_headers || '{}');
    if (h === null || typeof h !== 'object' || Array.isArray(h)) throw new Error();
  } catch { throw new SettingsError(tr('사용자 정의: 헤더는 { } 형식의 JSON 이어야 합니다.')); }
  if (cfg.custom_body_type !== 'form') {
    try { JSON.parse(cfg.custom_body || ''); } catch { throw new SettingsError(tr('사용자 정의: 본문이 올바른 JSON 이 아닙니다.')); }
  }
  if (!(cfg.custom_path || '').trim()) throw new SettingsError(tr('사용자 정의: 번역문 위치(예: translations.0.text)를 입력하세요.'));
}

const MISSING = Symbol('missing');

// follows `parts` down into `cur`. A number into a list that fails further down is tried with the other elements of the list, in
// order: "content.0.text" finds the text block of an answer that starts with a {"type": "thinking"} block, and still means "the
// first one" whenever the first one fits.
function walk(cur, parts) {
  if (!parts.length) return cur;
  const [part, ...rest] = parts;
  if (Array.isArray(cur)) {
    if (!/^\s*[+-]?\d+\s*$/.test(part)) return MISSING;
    const i = parseInt(part, 10);
    const order = i >= 0 && i < cur.length ? [i, ...[...cur.keys()].filter(j => j !== i)] : [];
    for (const j of order) { const r = walk(cur[j], rest); if (r !== MISSING) return r; }
    return MISSING;
  }
  if (cur && typeof cur === 'object' && Object.hasOwn(cur, part)) return walk(cur[part], rest);
  return MISSING;
}

export function dig(data, path) {
  const cur = walk(data, path.trim().split('.'));
  if (cur === MISSING) throw new TranslateError(tr("응답에서 '{path}' 를 찾지 못했습니다", { path }) + ': ' + jsonShort(data, 150));
  if (typeof cur !== 'string') throw new TranslateError(tr("응답의 '{path}' 가 글자가 아닙니다", { path }) + ': ' + jsonShort(cur, 100));
  return cur;
}

// The Anthropic API: the newest models think before they answer unless told not to. A request body that says nothing about thinking
// gets "thinking off"; one that does is left alone.
export function anthropicBody(url, body) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* none */ }
  if (body && typeof body === 'object' && !Array.isArray(body) && host === 'api.anthropic.com' && !('thinking' in body)) return { ...body, thinking: { type: 'disabled' } };
  return body;
}

// ----------------------------------------------------------------------
// the translator
// ----------------------------------------------------------------------
export class Translator {
  // http: makeHttp(transport) (or a fake); glossary: Glossary; usage: Usage; now(): monotonic seconds; sleep(seconds)
  constructor({ http, glossary, usage, now = () => performance.now() / 1000, sleep = s => sleepMs(s * 1000), onUsage = null }) {
    Object.assign(this, { http, glossary, usage, now, sleep, onUsage });
    this.extrasRejected = new Set();      // servers that answered HTTP 400 to the reasoning-off fields
    this.loggedSystem = {};               // where -> the system prompt that was written to the log in full last time
    this.gNextSlot = 0; this.gBlockUntil = 0; this.gBlockN = 0;
  }

  // ---- log of the full request (option "log the full request")
  logRequest(cfg, where, payload, head = '') {
    if (!cfg.log_request) return;
    try {
      let p = payload;
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        p = { ...p };
        const shorten = content => {
          if (this.loggedSystem[where] === content) return `(위와 같음, ${[...content].length}글자)`;
          this.loggedSystem[where] = content;
          return content;
        };
        if (typeof p.system === 'string') p.system = shorten(p.system);
        if (Array.isArray(p.messages)) p.messages = p.messages.map(m => (m && m.role === 'system' && typeof m.content === 'string' ? { ...m, content: shorten(m.content) } : m));
      }
      log.info(`요청 전문 [${where}] ${head}${JSON.stringify(p)}`);
    } catch (e) { log.error('요청 전문 기록 실패 ' + (e?.message || e)); }
  }

  // token counts the server reports (written to the log next to the "OK" line only)
  noteUsage(ctx, data) {
    try {
      const u = data && typeof data === 'object' ? data.usage : null;
      if (u && typeof u === 'object') {
        const a = u.prompt_tokens ?? u.input_tokens, b = u.completion_tokens ?? u.output_tokens;
        if (Number.isInteger(a) && Number.isInteger(b)) ctx.usage = [a, b];
      }
    } catch { /* ignore */ }
  }

  // what the AI gets as the user message, by glossary mode (full: the line; list: matching entries, then the line; mixed: single
  // meanings in parentheses, the other entries listed before the line)
  async userText(cfg, text) {
    const m = glossaryMode(cfg), g = this.glossary;
    if (m === 'list') {
      const found = await g.matchedList(text, cfg.glossary_file);
      if (found) {
        log.info(`단어장 목록: ${short(text, 60)} | ${found.split('\n').length}개`);
        return `Glossary for this message:\n${found}\n\nMessage:\n${text}`;
      }
    }
    if (m === 'mixed') {
      const [out, found] = await g.applyMixed(text, cfg.glossary_file);
      if (out !== text || found) log.info(`단어장 복합: ${short(text, 60)} -> ${short(out, 80)} | 목록 ${found ? found.split('\n').length : 0}개`);
      return found ? `Glossary for this message:\n${found}\n\nMessage:\n${out}` : out;
    }
    return text;
  }

  // ---- OpenAI compatible
  async openai(cfg, text, ctx = {}) {
    const base = openaiBase(cfg.api_url);
    const payload = {
      messages: [
        { role: 'system', content: await renderPrompt(this.glossary, cfg.prompt, cfg.target_lang ?? '한국어', glossaryMode(cfg), cfg.extra_prompt, cfg.glossary_file) },
        { role: 'user', content: await this.userText(cfg, text) },
      ],
      temperature: Number(cfg.temperature ?? 0.2),
      max_tokens: Math.trunc(Number(cfg.max_tokens ?? 300)),
      stream: false,
    };
    if ((cfg.api_model || '').trim()) payload.model = cfg.api_model.trim();
    const headers = {};
    if ((cfg.api_key || '').trim()) headers.Authorization = 'Bearer ' + cfg.api_key.trim();
    const timeout = Number(cfg.timeout ?? 30);
    const extras = reasoningExtras(cfg);
    const serverKey = base + '\n' + (payload.model || '');
    const url = base + '/chat/completions';

    const call = async body => {
      const withExtras = Object.keys(extras).length && !this.extrasRejected.has(serverKey);
      this.logRequest(cfg, 'openai', withExtras ? { ...body, ...extras } : body, base + '/chat/completions | ');
      if (withExtras) {
        try { return await this.http.json(url, { ...body, ...extras }, headers, timeout); }
        catch (e) {
          if (!(e instanceof TranslateError) || !String(e.message).startsWith('HTTP 400')) throw e;
          this.extrasRejected.add(serverKey);                // the server dislikes the extra fields: stop sending them
        }
      }
      return this.http.json(url, body, headers, timeout);
    };
    const parse = data => {
      this.noteUsage(ctx, data);
      let choice, msg, out;
      try { choice = data.choices[0]; msg = choice.message; out = msg.content || ''; }
      catch { throw new TranslateError(tr('예상하지 못한 응답 형식') + ': ' + jsonShort(data, 150)); }
      return [cleanLlmOutput(out), !!(msg.reasoning_content || msg.reasoning), choice.finish_reason ?? null];
    };

    let [out, reasoned, finish] = parse(await call(payload));
    if (!out && (reasoned || finish === 'length') && (cfg.retry_on_reasoning ?? true)) {
      // Some models start "thinking" now and then although it is switched off: the small token budget is gone before the answer.
      // One retry with a big budget.
      const big = Math.min(2000, Math.max(payload.max_tokens * 4, 1200));
      log.warn(`모델이 추론을 해서 답이 비었습니다 (finish=${finish}): max_tokens ${payload.max_tokens} -> ${big} 로 한 번 재시도`);
      [out, reasoned, finish] = parse(await call({ ...payload, max_tokens: big }));
    }
    if (!out) {
      if (reasoned || finish === 'length') throw new TranslateError(tr("모델이 추론에 토큰을 다 써서 답이 비었습니다 (finish={finish}). 모델의 추론을 끄거나 '추론 끄기용 JSON'을 모델에 맞게 고치세요", { finish: finish ?? 'None' }));
      throw new TranslateError(tr('빈 응답 (finish={finish})', { finish: finish ?? 'None' }));
    }
    return out;
  }

  async listModels(cfg) {
    const base = openaiBase(cfg.api_url);
    const headers = {};
    if ((cfg.api_key || '').trim()) headers.Authorization = 'Bearer ' + cfg.api_key.trim();
    // kind: 'connect' = the server did not answer (no connection, time out, an error code such as 401) | 'format' = it answered with something that is no model list
    let data;
    try { data = await this.http.json(base + '/models', null, headers, Math.min(Number(cfg.timeout ?? 30), 10)); }
    catch (e) { throw Object.assign(new TranslateError(String((e && e.message) || e)), { kind: 'connect' }); }
    let ids = null;
    try { ids = data.data.map(m => m.id); } catch { /* not the OpenAI shape */ }
    if (!Array.isArray(ids) || ids.some(x => typeof x !== 'string')) throw Object.assign(new TranslateError(tr('모델 목록 형식이 올바르지 않습니다')), { kind: 'format' });
    return [...new Set(ids.filter(Boolean))];
  }

  // ---- Google
  // space requests out, and do not touch the server at all while a rate-limit pause is active
  async googleGate() {
    const now = this.now();
    if (now < this.gBlockUntil) {
      throw new RateLimited(tr('Google 요청 제한 대기 중 ({sec}초 남음) - 그동안 요청을 보내지 않습니다', { sec: Math.trunc(this.gBlockUntil - now) + 1 }), this.gBlockUntil - now);
    }
    const slot = Math.max(now, this.gNextSlot);
    this.gNextSlot = slot + GOOGLE_MIN_INTERVAL;
    if (slot > now) await this.sleep(slot - now);
  }

  googleLimited(reason) {
    this.gBlockN = Math.min(this.gBlockN + 1, 6);
    const secs = Math.min(900, 30 * 2 ** (this.gBlockN - 1));          // 30, 60, 120, 240, 480, 900 seconds
    this.gBlockUntil = this.now() + secs;
    log.warn(`Google이 요청을 제한한 것으로 보임 (${reason}) -> ${secs}초 동안 요청 중지`);
    throw new RateLimited(tr('Google이 요청을 제한했습니다 ({reason}). {secs}초 동안 요청을 멈추고 다시 시도합니다', { reason, secs }), secs);
  }

  // one Google request -> [translation, detected source language or '']
  async googleOnce(key, q, tl, sl, timeout) {
    if (key) {
      const body = { q, target: tl, format: 'text' };
      if (sl !== 'auto') body.source = sl;
      let data;
      try { data = await this.http.json(GOOGLE_V2_URL + '?' + urlencode([['key', key]]), body, null, timeout); }
      catch (e) {
        if (e instanceof TranslateError) {
          const hint = googleKeyHint(String(e.message));
          if (hint) { log.warn(`Google API 키 문제: ${hint}`); throw new TranslateError(`${e.message} | ${hint}`); }
        }
        throw e;
      }
      let out, det;
      try { const t0 = data.data.translations[0]; out = t0.translatedText; det = t0.detectedSourceLanguage || ''; if (out === undefined) throw new Error(); }
      catch { throw new TranslateError(tr('예상하지 못한 Google 응답')); }
      const hit = await this.usage.add([...q].length);                // the official API bills by characters sent
      if (hit !== null && this.onUsage) { try { this.onUsage(hit); } catch { /* ignore */ } }
      return [out, det];
    }
    await this.googleGate();
    const params = urlencode([['client', 'gtx'], ['sl', sl], ['tl', tl], ['dt', 't'], ['q', q]]);
    let data;
    try { data = await this.http.json(GOOGLE_GTX_URL + '?' + params, null, null, timeout); }
    catch (e) {
      if (e instanceof TranslateError) {
        const msg = String(e.message);
        if (msg.startsWith('HTTP 429') || msg.startsWith('HTTP 403') || msg.startsWith(tr('JSON이 아닌 응답'))) this.googleLimited(msg.split(' ').slice(0, 2).join(' '));   // blocked / captcha page
      }
      throw e;
    }
    let out;
    try { out = data[0].map(seg => (seg && seg[0]) || '').join(''); }
    catch { throw new TranslateError(tr('예상하지 못한 Google 응답')); }
    if (!out) throw new TransientError(tr('빈 응답'));
    let det = '';
    try { det = typeof data[2] === 'string' ? data[2] : ''; } catch { det = ''; }
    this.gBlockN = 0;
    return [out, det];
  }

  async google(cfg, text) {
    const tl = langCode(cfg.target_lang ?? '한국어');
    const key = googleKey(cfg);
    const timeout = Math.min(Number(cfg.timeout ?? 30), 10);
    let sent = text, words = [], first = 0;
    if (cfg.glossary_google ?? true) {
      // Glossary terms go through Google as placeholders [L3] ...: Korean words inside an English sentence made Google take the whole
      // text for Korean and return it untranslated. The numbers continue after the link placeholders the window already put in.
      const used = [...text.matchAll(PLACEHOLDER)].map(m => parseInt(m[1], 10));
      first = Math.max(0, ...used);
      [sent, words] = await this.glossary.applyGoogleMasked(text, cfg.glossary_file, cfg.glossary_style || 'paren', first + 1);
      if (words.length) log.info(`단어장 적용: ${short(text, 60)} -> ${short(sent, 60)} | ${words.join(', ')}`);
    }
    let [out] = await this.googleOnce(key, sent, tl, 'auto', timeout);
    if (words.length) out = unmaskLinks(out, [...new Array(first).fill(null), ...words]);
    return out;
  }

  // ---- custom HTTP
  async custom(cfg, text, ctx = {}) {
    try { customCheck(cfg); } catch (e) { if (e instanceof SettingsError) throw new TranslateError(e.message); throw e; }
    const bodyTpl = cfg.custom_body || '';
    const llm = bodyTpl.includes('{system}');                           // an AI service: the glossary travels in the prompt
    const key = (cfg.custom_key || '').trim();
    const templateText = (cfg.custom_url || '') + (cfg.custom_headers || '') + bodyTpl;
    if (/\{key[12]?\}/.test(templateText) && !key) throw new TranslateError(tr('사용자 정의: API Key 가 비어 있습니다'));
    const ci = key.indexOf(':');
    const key1 = ci < 0 ? key : key.slice(0, ci), key2 = ci < 0 ? '' : key.slice(ci + 1);
    const code = langCode(cfg.target_lang ?? '한국어');
    let sent = text, words = [], first = 0;
    if (!llm && (cfg.glossary_google ?? true)) {
      const used = [...text.matchAll(PLACEHOLDER)].map(m => parseInt(m[1], 10));
      first = Math.max(0, ...used);
      [sent, words] = await this.glossary.applyGoogleMasked(text, cfg.glossary_file, cfg.glossary_style || 'paren', first + 1);
      if (words.length) log.info(`단어장 적용: ${short(text, 60)} -> ${short(sent, 60)} | ${words.join(', ')}`);
    }
    if (llm) sent = await this.userText(cfg, text);
    const vals = {
      text: sent, key, key1, key2, target: code, TARGET: code.toUpperCase(),
      system: llm ? await renderPrompt(this.glossary, cfg.prompt, cfg.target_lang ?? '한국어', glossaryMode(cfg), cfg.extra_prompt, cfg.glossary_file) : '',
    };
    const url = fill(cfg.custom_url.trim(), vals, true);
    const headers = Object.fromEntries(Object.entries(JSON.parse(cfg.custom_headers || '{}')).map(([k, v]) => [String(k), fill(String(v), vals)]));
    const timeout = Number(cfg.timeout ?? 30);
    const secrets = [key, key1, key2].filter(Boolean);
    const hide = s => secrets.reduce((acc, x) => acc.split(x).join('***'), s);      // the API key never goes into the log
    const isForm = cfg.custom_body_type === 'form';
    let pairs = [];
    if (isForm) {
      for (const part of bodyTpl.split('&')) {
        const i = part.indexOf('=');
        const k = (i < 0 ? part : part.slice(0, i)).trim(), v = i < 0 ? '' : part.slice(i + 1).trim();
        if (k) pairs.push([k, fill(v, vals)]);
      }
    }
    if (cfg.log_request) {
      const shown = isForm ? Object.fromEntries(pairs) : anthropicBody(url, fillJson(JSON.parse(bodyTpl), vals));
      this.logRequest(cfg, 'custom', shown, hide(url) + ' | ' + hide(JSON.stringify(headers)) + ' | ');
    }
    let data;
    if (isForm) {
      if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      data = await this.http.form(url, urlencode(pairs), headers, timeout);
    } else {
      data = await this.http.json(url, anthropicBody(url, fillJson(JSON.parse(bodyTpl), vals)), headers, timeout);
    }
    this.noteUsage(ctx, data);
    let out = dig(data, cfg.custom_path);
    out = llm ? cleanLlmOutput(out) : out.trim();
    if (!out) throw new TranslateError(tr('빈 응답'));
    if (words.length) out = unmaskLinks(out, [...new Array(first).fill(null), ...words]);
    return out;
  }

  // ---- entry points
  async translate(cfg, text) {
    const mode = cfg.translator ?? 'none';
    let where = '-';
    if (mode === 'google') where = googleKey(cfg) ? 'Google v2(키)' : 'Google gtx(키 없음)';
    else if (mode === 'openai') where = `${cfg.api_url} model=${cfg.api_model || '(기본)'}`;
    else if (mode === 'custom') {
      let host = '?';
      try { host = new URL(cfg.custom_url || '').hostname || '?'; } catch { /* keep ? */ }
      where = (cfg.custom_preset || 'custom') + ' ' + host;
    }
    const t0 = performance.now(), ctx = { usage: null }, ms = () => Math.trunc(performance.now() - t0);
    let out;
    try {
      if (mode === 'openai') out = await this.openai(cfg, text, ctx);
      else if (mode === 'google') out = await this.google(cfg, text);
      else if (mode === 'custom') out = await this.custom(cfg, text, ctx);
      else throw new TranslateError(tr("번역 방식이 '사용 안 함'입니다"));
    } catch (e) {
      log.warn(`${mode} FAIL ${ms()}ms | ${where} | ${short(text)} | ${(String(e?.message) || e?.name || 'Error').slice(0, 300)}`);
      throw e;
    }
    const tokens = ctx.usage ? ` | 토큰 입력 ${ctx.usage[0]} 출력 ${ctx.usage[1]}` : '';
    log.info(`${mode} OK ${ms()}ms | ${where} | ${short(text, 60)} -> ${short(out, 60)}${tokens}`);
    return out;
  }

  // what the player types -> the language of the people they talk to (cfg.send_lang, the source is detected)
  translateOutgoing(cfg, text) { return this.translate(applyRoute(sendCfg(cfg), sendRoute(cfg), true), text); }
}
