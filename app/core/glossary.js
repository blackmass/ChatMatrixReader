// The glossary file (default: Glossary.txt in the program folder). Port of glossary.py.
//
// One entry per line:   term = meaning        ('#' or '//' starts a comment line; '## text' is a section heading;
//                                               text after " # " on an entry is a note for the AI)
// Used in two ways:
//   * Google & co.: every term in the chat line is replaced before sending (masked as [L<n>], put back afterwards).
//   * AI prompt: {{Glossary.txt}} in the prompt is replaced by the file's lines, or only the entries that apply to the line.
//
// All file access goes through the `files` object of app/fs.js (same six calls as tests/memoryfiles.mjs), so everything stays
// inside the program folder. The file is re-read when its text changed on disk, checked at most once per `recheckMs`.
// Difference to Python: the file must be UTF-8 (the exe reads text as UTF-8; the cp949 fallback of the Python program is gone).
import { log } from './log.js';

export const DEFAULT_NAME = 'Glossary.txt';
export const SAMPLE_NAME = 'Glossary.sample.txt';
export const GLOSSARY_STYLES = { paren: '원문(번역)   예: LFM(구인)', replace: '번역으로 치환   예: 구인' };
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
export const LIST_MAX = 20;          // at most this many entries are listed for one message
export const INLINE_MAX = 10;        // mixed mode: at most this many terms get their meaning in parentheses in one line
export const MODES = ['full', 'list', 'mixed'];
export const LIST_PLACEHOLDER = '(The glossary entries that apply to a message are given with that message.)';
export const MIXED_PLACEHOLDER = '(The glossary meanings that apply to a message are given inside the message, in parentheses behind the term; '
  + 'entries that need a choice or a note are listed before the message.)';

const WORD = /[\p{L}\p{N}_]/u;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
const stripBom = t => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);

// a short fingerprint of a text: changes whenever the file changes (used in cache keys)
export function fingerprint(text) {
  if (text == null) return null;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

export function safeName(name) {
  return !!name && !name.startsWith('/') && !/^[A-Za-z]:/.test(name) && !/[\\/]/.test(name) && !name.includes('..');
}

// the entry lines of a file; headings=true keeps the '## ' section lines (for the AI prompt)
export function contentLines(text, headings = false) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (headings && line.startsWith('##')) out.push(line);
    else if (line && !line.startsWith('#') && !line.startsWith('//')) out.push(line);
  }
  return out;
}

const INLINE_NOTE = /\s+#(?:\s|$).*$/;       // "b4 = before   # a note": whitespace, #, whitespace

// [[term, meaning, note, section]]: the note is the text after " # " on the entry's line, the section the last ## heading above it
export function parseRich(text) {
  const out = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.startsWith('##')) { section = line.replace(/^#+/, '').trim(); continue; }
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    let note = '';
    const m = INLINE_NOTE.exec(line);
    if (m) { note = line.slice(m.index).trim().replace(/^#+/, '').trim(); line = line.slice(0, m.index); }
    const i = line.indexOf('=');
    if (i < 0) continue;
    const term = line.slice(0, i).trim(), meaning = line.slice(i + 1).trim();
    if (term && meaning) out.push([term, meaning, note, section]);
  }
  return out;
}
export const parse = text => parseRich(text).map(([t, m]) => [t, m]);

// regex over all terms (longest first, whole words only) + lookup lowercase term -> meaning (the first one wins)
export function compile(entries) {
  if (!entries.length) return { regex: null, lookup: new Map() };
  const lookup = new Map();
  for (const [term, meaning] of entries) if (!lookup.has(term.toLowerCase())) lookup.set(term.toLowerCase(), meaning);
  const parts = [...lookup.keys()].sort((a, b) => [...b].length - [...a].length).map(term => {
    const cs = [...term];
    const pre = WORD.test(cs[0]) ? '(?<![\\p{L}\\p{N}_])' : '';       // "inv" must not hit "invite"
    const post = WORD.test(cs[cs.length - 1]) ? '(?![\\p{L}\\p{N}_])' : '';   // ...but "M+" may be followed by digits: M+12
    return pre + escapeRegex(term) + post;
  });
  return { regex: new RegExp(parts.join('|'), 'giu'), lookup };
}

function formatList(keys, rich, limit) {
  const sections = new Map();
  let n = 0;
  for (const k of keys) {
    for (const [term, meaning, note, section] of rich.get(k)) {
      if (n >= limit) break;
      n++;
      if (!sections.has(section)) sections.set(section, []);
      sections.get(section).push(`${term} = ${meaning}` + (note ? `    # ${note}` : ''));
    }
  }
  const lines = [];
  for (const [section, items] of sections) { if (section) lines.push('## ' + section); lines.push(...items); }
  return lines.join('\n');
}

const EMPTY = { sig: null, entries: [], regex: null, lookup: new Map(), rich: new Map(), mtRegex: null, mtLookup: new Map() };

function build(text) {
  const richList = parseRich(text);
  const entries = richList.map(([t, m]) => [t, m]);
  const rich = new Map();
  for (const e of richList) { const k = e[0].toLowerCase(); if (!rich.has(k)) rich.set(k, []); rich.get(k).push(e); }
  const { regex, lookup } = compile(entries);
  // machine translators cannot pick a meaning by context: a term with several different meanings is left out for them
  const single = entries.filter(([t]) => new Set(rich.get(t.toLowerCase()).map(e => e[1])).size === 1);
  const { regex: mtRegex, lookup: mtLookup } = compile(single);
  return { sig: fingerprint(text), entries, regex, lookup, rich, mtRegex, mtLookup };
}

// "regex.exec in a loop" without lastIndex surprises
const matches = (re, text) => (re ? [...text.matchAll(re)] : []);

export class Glossary {
  // files: the six-call files API; now: ms clock (injected for tests); recheckMs: how often the file is looked at again
  constructor(files, { now = () => Date.now(), recheckMs = 1000 } = {}) {
    this.files = files; this.now = now; this.recheckMs = recheckMs;
    this.cache = new Map();          // name -> { text, data, checked }
    this.warned = new Set();
    this.sigs = new Map();           // file name -> fingerprint of its text when it was last read (null = no file): for cacheKeySync
    this.sigChecked = 0;
  }

  async readText(name) {
    if (!safeName(name)) {
      if (!this.warned.has('u:' + name)) { this.warned.add('u:' + name); log.warn(`단어장 파일 이름은 프로그램 폴더 안의 파일 이름만 쓸 수 있습니다: ${name}`); }
      return null;
    }
    try {
      const t = await this.files.read(name);
      const text = t == null ? null : stripBom(t);
      this.sigs.set(name, fingerprint(text));
      return text;
    } catch (e) {
      log.warn(`단어장을 읽지 못했습니다: ${e?.message || e}`);
      return null;
    }
  }

  // the parsed file; re-read when its text changed (looked at most once per recheckMs)
  async load(name, force = false) {
    name = (name || DEFAULT_NAME).trim() || DEFAULT_NAME;
    const hit = this.cache.get(name);
    if (!force && hit && this.now() - hit.checked < this.recheckMs) return hit.data;
    const text = await this.readText(name);
    if (hit && hit.text === text) { hit.checked = this.now(); return hit.data; }
    let data;
    if (text == null) {
      if (!this.warned.has(name)) { this.warned.add(name); log.warn(`단어장 파일이 없습니다: ${name}`); }
      data = EMPTY;
    } else {
      data = build(text);
      this.warned.delete(name);
      log.info(`단어장 불러옴: ${name} (${data.entries.length}개)`);
    }
    this.cache.set(name, { text, data, checked: this.now() });
    return data;
  }

  async entries(name, force = false) { return (await this.load(name, force)).entries.map(e => [...e]); }

  // a fingerprint of the glossary file as it is on disk now (null = no file); changes whenever the file changes
  async signature(name) { return fingerprint(await this.readText((name || DEFAULT_NAME).trim() || DEFAULT_NAME)); }

  // 'LFM dungeon' -> 'LFM(구인) dungeon' (style paren) or '구인 dungeon' (replace). Terms with several meanings are skipped.
  async applyGoogle(text, name, style = 'paren') {
    const { mtRegex, mtLookup } = await this.load(name);
    if (!mtRegex) return text;
    return text.replace(mtRegex, m => {
      const meaning = mtLookup.get(m.toLowerCase());
      if (meaning === undefined) return m;
      return style === 'replace' ? meaning : `${m}(${meaning})`;
    });
  }

  // like applyGoogle, but each term becomes a placeholder [L<start>], [L<start+1>] ...: returns [masked text, [words]]. Google never
  // sees the Korean meaning (it would take the whole sentence for Korean and return it untranslated); the words are put back after.
  async applyGoogleMasked(text, name, style = 'paren', start = 1) {
    const { mtRegex, mtLookup } = await this.load(name);
    if (!mtRegex) return [text, []];
    const words = [];
    const out = text.replace(mtRegex, m => {
      const meaning = mtLookup.get(m.toLowerCase());
      if (meaning === undefined) return m;
      words.push(style === 'replace' ? meaning : `${m}(${meaning})`);
      return `[L${start + words.length - 1}]`;
    });
    return [out, words];
  }

  // the entries whose term occurs in `text`, in the file's own format (## headings, notes kept). '' = no hit.
  async matchedList(text, name, limit = LIST_MAX) {
    const { regex, rich } = await this.load(name);
    if (!regex) return '';
    const keys = [];
    for (const m of matches(regex, text)) { const k = m[0].toLowerCase(); if (rich.has(k) && !keys.includes(k)) keys.push(k); }
    return formatList(keys, rich, limit);
  }

  // [text, list]: a term with ONE meaning and no note gets it right behind it ('SFK' -> 'SFK(그림자 송곳니 성채)'); every other term
  // found stays as it is and its entries are listed instead. list '' = nothing to list.
  async applyMixed(text, name, limit = LIST_MAX, inlineMax = INLINE_MAX) {
    const { regex, rich } = await this.load(name);
    if (!regex) return [text, ''];
    const keys = [];
    let n = 0;
    const out = text.replace(regex, m => {
      const k = m.toLowerCase();
      const found = rich.get(k);
      if (!found) return m;
      if (new Set(found.map(e => e[1])).size === 1 && !found.some(e => e[2]) && n < inlineMax) { n++; return `${m}(${found[0][1]})`; }
      if (!keys.includes(k)) keys.push(k);
      return m;
    });
    return [out, formatList(keys, rich, limit)];
  }

  // {{File.txt}} in a prompt -> the file's lines (comments removed; ## headings and notes kept). mode list/mixed: {{Glossary.txt}}
  // gets a one-line hint instead (the matching entries travel with the chat line).
  async expandPlaceholders(prompt, mode = 'full') {
    const names = [...new Set([...(prompt || '').matchAll(PLACEHOLDER)].map(m => m[1].trim()))];
    const rep = new Map();
    for (const name of names) {
      if (mode !== 'full' && name.toLowerCase() === DEFAULT_NAME.toLowerCase()) { rep.set(name, mode === 'mixed' ? MIXED_PLACEHOLDER : LIST_PLACEHOLDER); continue; }
      if (!safeName(name)) { log.warn(`프롬프트의 {{${name}}}: 앱 폴더 안의 파일 이름만 쓸 수 있습니다`); rep.set(name, ''); continue; }
      const text = await this.readText(name);
      if (text == null) {
        if (!this.warned.has(name)) { this.warned.add(name); log.warn(`프롬프트의 {{${name}}} 파일이 없습니다: ${name}`); }
        rep.set(name, '');
      } else rep.set(name, contentLines(text, true).join('\n'));
    }
    return (prompt || '').replace(PLACEHOLDER, (_, name) => rep.get(name.trim()));
  }

  // changes whenever a file that influences the translation changes (so cached translations are not reused)
  async cacheKey(cfg) {
    const names = [...new Set([...(cfg.prompt || '').matchAll(PLACEHOLDER)].map(m => m[1].trim()).filter(n => safeName(n) && n !== 'extra_prompt'))].sort();
    const gname = cfg.glossary_file || DEFAULT_NAME;
    const sigOf = async n => fingerprint(await this.readText(n));
    const google = (cfg.glossary_google ?? true) ? [await sigOf(gname), cfg.glossary_style] : null;
    const m = mode(cfg);
    const own = m !== 'full' ? await sigOf(gname) : null;
    const sigs = [];
    for (const n of names) sigs.push(await sigOf(n));
    return JSON.stringify([google, m, own, sigs]);
  }

  // The same as cacheKey but without reading anything: it uses what the files looked like when they were last read (see refreshKeys), so
  // the translation queue can decide at once. A file that changed on disk shows up one refresh later.
  cacheKeySync(cfg) {
    const names = [...new Set([...(cfg.prompt || '').matchAll(PLACEHOLDER)].map(m => m[1].trim()).filter(n => safeName(n) && n !== 'extra_prompt'))].sort();
    const gname = cfg.glossary_file || DEFAULT_NAME;
    const sig = n => this.sigs.get(n) ?? null;
    const google = (cfg.glossary_google ?? true) ? [sig(gname), cfg.glossary_style] : null;
    const m = mode(cfg);
    return JSON.stringify([google, m, m !== 'full' ? sig(gname) : null, names.map(sig)]);
  }

  // look at the files cacheKeySync depends on again (at most once per recheckMs); the queue calls this without waiting for it
  async refreshKeys(cfg) {
    if (this.now() - this.sigChecked < this.recheckMs) return;
    this.sigChecked = this.now();
    const names = new Set([cfg.glossary_file || DEFAULT_NAME]);
    for (const m of (cfg.prompt || '').matchAll(PLACEHOLDER)) { const n = m[1].trim(); if (safeName(n) && n !== 'extra_prompt') names.add(n); }
    for (const n of names) await this.readText(n);
  }

  // create Glossary.txt from the sample on first start (an existing file is never touched)
  async ensureDefault(name) {
    name = (name || DEFAULT_NAME).trim() || DEFAULT_NAME;
    if (!safeName(name)) return;
    try {
      if (await this.files.kind(name)) return;
      const sample = await this.files.read(SAMPLE_NAME);
      if (sample == null) return;
      await this.files.write(name, sample);
      log.info(`단어장을 새로 만들었습니다: ${name}`);
    } catch (e) { log.warn(`단어장을 만들지 못했습니다: ${e?.message || e}`); }
  }
}

export function mode(cfg) {
  const m = cfg.glossary_mode;
  if (m === 'inline') return 'list';                  // the removed third way (meanings in parentheses): the nearest one left
  return MODES.includes(m) ? m : 'full';
}
