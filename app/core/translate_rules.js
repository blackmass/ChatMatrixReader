// The decisions around translation (no network): languages, "is this line worth translating", the user's skip pattern, and
// which translation method a channel uses. Port of the helpers of translator.py. The requests themselves are in translate_*.js.

import { tr } from './i18n.js';

export class TranslateError extends Error {}
export class TransientError extends TranslateError {}       // probably gone a moment later: worth one more try
export class RateLimited extends TranslateError {           // the server asked us to slow down; delay = seconds to wait
  constructor(message, delay) { super(message); this.delay = delay; }
}

export const LANG_CODES = {
  '한국어': 'ko', English: 'en', '日本語': 'ja', '中文(简体)': 'zh-CN', '中文(繁體)': 'zh-TW',
  Español: 'es', Français: 'fr', Deutsch: 'de', Русский: 'ru',
};
export const LANGS = Object.keys(LANG_CODES);

export const [ROUTE_DEFAULT, ROUTE_GOOGLE_FREE, ROUTE_GOOGLE, ROUTE_OPENAI, ROUTE_CUSTOM, ROUTE_OFF] =
  ['default', 'google_free', 'google', 'openai', 'custom', 'off'];
export const ROUTES = [ROUTE_DEFAULT, ROUTE_GOOGLE_FREE, ROUTE_GOOGLE, ROUTE_OPENAI, ROUTE_CUSTOM, ROUTE_OFF];
const ROUTE_MODE = { [ROUTE_GOOGLE_FREE]: 'google', [ROUTE_GOOGLE]: 'google', [ROUTE_OPENAI]: 'openai', [ROUTE_CUSTOM]: 'custom' };

const LETTER = /\p{L}/u;
const hasLetter = s => LETTER.test(s);

export function langCode(name) {
  name = (name || '').trim();
  if (Object.hasOwn(LANG_CODES, name)) return LANG_CODES[name];
  if (/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(name)) return name;
  const english = { korean: 'ko', english: 'en', japanese: 'ja', chinese: 'zh-CN', spanish: 'es', french: 'fr', german: 'de', russian: 'ru' };
  if (Object.hasOwn(english, name.toLowerCase())) return english[name.toLowerCase()];
  throw new TranslateError(tr("Google 번역에서 알 수 없는 언어: '{name}' (예: ko, en, ja 처럼 코드로 입력)", { name }));
}

// cheap script check, used to skip lines that are already in the target language
export function looksLikeTarget(text, targetLang) {
  const code = LANG_CODES[(targetLang || '').trim()] || '';
  const letters = [...text].filter(c => LETTER.test(c));
  if (!letters.length) return false;
  let ranges, need;
  if (code === 'ko') { ranges = [[0xAC00, 0xD7A3], [0x1100, 0x11FF], [0x3130, 0x318F]]; need = 0.5; }
  else if (code === 'ja') { ranges = [[0x3040, 0x30FF]]; need = 0.3; }
  else if (code.startsWith('zh')) { ranges = [[0x4E00, 0x9FFF]]; need = 0.5; }
  else if (code === 'ru') { ranges = [[0x0400, 0x04FF]]; need = 0.5; }
  else return false;
  const hit = letters.filter(c => { const o = c.codePointAt(0); return ranges.some(([a, b]) => a <= o && o <= b); }).length;
  return hit / letters.length >= need;
}

// The user's 'do not translate' pattern. It was written for Python's re: a leading (?i) / (?s) / (?m) / (?x-less) flag group is
// turned into the matching JS flags; anything else that JS cannot read counts as invalid. null when empty. Throws SyntaxError.
const cache = new Map();
export function compileSkipRegex(pattern) {
  pattern = (pattern || '').trim();
  if (!pattern) return null;
  if (!cache.has(pattern)) {
    if (cache.size > 8) cache.clear();
    let flags = '', src = pattern;
    const m = /^\(\?([aiLmsux]+)\)/.exec(src);
    if (m) {
      src = src.slice(m[0].length);
      for (const f of m[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
    }
    cache.set(pattern, new RegExp(src, flags));
  }
  return cache.get(pattern);
}

export function matchesSkipRegex(text, cfg) {
  let rx;
  try { rx = compileSkipRegex(cfg.skip_regex || ''); } catch { return false; }       // an invalid pattern never blocks translation
  return !!rx && rx.test(text);
}

// check: the text the language / regex tests look at (the line without its links); default = text
export function skipReason(text, cfg, check = null) {
  if ((cfg.translator ?? 'none') === 'none') return 'translation method is off';
  if (!hasLetter(text)) return 'no letters';
  check = check === null ? text : check;
  if ((cfg.skip_same_lang ?? true) && looksLikeTarget(check, cfg.target_lang || '')) return 'already in the target language (option on)';
  if (matchesSkipRegex(check, cfg)) return 'matches the skip pattern';
  return '';
}
export const shouldTranslate = (text, cfg, check = null) => skipReason(text, cfg, check) === '';

// how the lines of one channel code are translated: null = the method of the translation tab, else one of the ROUTE_* names
export function routeFor(cfg, channel) {
  const r = (cfg.channel_route || {})[channel];
  return ROUTES.includes(r) && r !== ROUTE_DEFAULT ? r : null;
}

export function applyRoute(cfg, route) {
  if (route === ROUTE_GOOGLE_FREE) return { ...cfg, translator: 'google', google_free: true, google_api_key: '' };
  if (route === ROUTE_GOOGLE) return { ...cfg, translator: 'google', google_free: false };
  if (Object.hasOwn(ROUTE_MODE, route)) return { ...cfg, translator: ROUTE_MODE[route] };
  return cfg;
}

export function sendRoute(cfg) {
  const r = cfg.send_route;
  return Object.hasOwn(ROUTE_MODE, r) ? r : null;
}

export function modesInUse(cfg, sending = true) {
  const out = new Set([cfg.translator ?? 'none']);
  for (const r of Object.values(cfg.channel_route || {})) if (Object.hasOwn(ROUTE_MODE, r)) out.add(ROUTE_MODE[r]);
  if (sending && (cfg.send_enabled ?? true) && sendRoute(cfg)) out.add(ROUTE_MODE[sendRoute(cfg)]);
  out.delete('none');
  return out;
}

export const onlySendingUses = (cfg, mode) => modesInUse(cfg).has(mode) && !modesInUse(cfg, false).has(mode);
