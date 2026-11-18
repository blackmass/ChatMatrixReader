// UI language: the Korean text in the source IS the key (docs/PORTING_NOTES.md). Other languages are locale/<code>.txt files of
// lines "한국어 = English" (\n = line break; {placeholders} stay as they are). Port of i18n.py without the OS lookups:
// the program reads the file (fetch / exe) and hands its text to parseLocale() + setTable().

let table = {};
let current = 'ko-KR';

export const N_ = text => text;                           // marks a constant for translation; show it through tr(variable)

// "{name}" -> value; "{{" and "}}" are literal braces (like Python's str.format); an unknown name leaves the text as it was
function format(s, kw) {
  let ok = true;
  const out = s.replace(/\{\{|\}\}|\{([A-Za-z_]\w*)\}/g, (m, name) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    if (!(name in kw)) { ok = false; return m; }
    return String(kw[name]);
  });
  return ok ? out : null;
}

// A filter every shown text passes at the end (the Mac one: Ctrl -> Control ...; see keyNames below). Nothing by default.
let finish = s => s;
export const setTextFilter = fn => { finish = typeof fn === 'function' ? fn : (s => s); };

export function tr(text, kw = null) {
  const s = Object.hasOwn(table, text) ? table[text] : text;
  if (!kw) return finish(s);
  return finish(format(s, kw) ?? format(text, kw) ?? s);
}

// The names of the keys on a Mac: Ctrl is the Control key (the texts say Ctrl, as Windows does), Alt is the Option key, and the paste (Ctrl+V) is Command+V.
// The settings keep the Windows names ('Ctrl', 'Alt'): only what is SHOWN changes, so a config.json works on both systems.
export function macKeys(text) {
  return String(text)
    .replace(/\bCtrl\+([CVXAZ])(?![A-Za-z])/g, '⌘$1')
    .replace(/\bCtrl\b/g, 'Control')
    .replace(/\bAlt\b/g, 'Option');
}

const unescape = s => s.replace(/\\n/g, '\n');

// the text of a locale file -> { entries, name }
export function parseLocale(text) {
  const entries = {};
  let name = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf(' = ');
    if (i < 0) continue;
    const key = s.slice(0, i).trim(), val = s.slice(i + 3).trim();
    if (key === '@name') name = val;
    else if (key && val) entries[unescape(key)] = unescape(val);
  }
  return { entries, name };
}

export function setTable(entries, code = 'ko-KR') {
  table = entries || {};
  current = Object.keys(table).length ? code : 'ko-KR';
  return current;
}
export const currentLanguage = () => current;

export const DEFAULT_LANG = 'ko-KR';                      // the built-in language (the Korean text in the source)
export const FALLBACK_LANG = 'en-US';                     // used when the system language has no file
// The language to use: the configured one when it exists, else the system language (exact, then the same primary language: en-GB -> en-US),
// else English (a user whose language has no file is better served by English than by the built-in Korean).
// codes: the codes of the locale files (and 'ko-KR'); system: e.g. navigator.language
export function pickLanguage(preferred, codes, system = '') {
  const by = new Map(codes.map(c => [c.toLowerCase(), c]));
  by.set(DEFAULT_LANG.toLowerCase(), DEFAULT_LANG);
  const want = String(preferred || '').toLowerCase();
  if (want && by.has(want)) return by.get(want);
  const sys = String(system || '').replace('_', '-').toLowerCase();
  if (by.has(sys)) return by.get(sys);
  const prim = sys.split('-')[0];
  if (prim) {
    if (prim === DEFAULT_LANG.split('-')[0].toLowerCase()) return DEFAULT_LANG;
    for (const [low, code] of by) if (low.split('-')[0] === prim) return code;
  }
  return by.has(FALLBACK_LANG.toLowerCase()) ? by.get(FALLBACK_LANG.toLowerCase()) : DEFAULT_LANG;
}
