// Item-link markers inside chat text. Port of chattext.py: the addon turns a link into  \x02 <code> [Item Name] \x03 ;
// the code is one byte, chr(48 + n). See the header of chattext.py / docs/PROTOCOL.md.

// Python's $ also matches just before a final newline
const MARK = /\x02([\x30-\x7e])([\s\S]*?)(?:\x03|(?=\n?$))/g;
const STRAY = /[\x02\x03]/g;
export const YELLOW = 10, LIGHT_BLUE = 11, UNINTELLIGIBLE = 20;
const GUILD = /<+[^<>\n]{1,40}>+/g;
export const GUILD_QUALITY = 2;
const LETTER = /\p{L}/u;

const code = m => m[1].charCodeAt(0) - 48;
const partition = (s, sep) => { const i = s.indexOf(sep); return i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)]; };
const stripAngle = s => s.replace(/^[<>]+/, '').replace(/[<>]+$/, '');
const matches = (re, text) => [...text.matchAll(re)];

export function markGuilds(text) {
  const rep = m => (LETTER.test(stripAngle(m)) ? '\x02' + String.fromCharCode(48 + GUILD_QUALITY) + m + '\x03' : m);
  const out = [];
  let pos = 0;
  for (const m of matches(MARK, text)) {
    out.push(text.slice(pos, m.index).replace(GUILD, rep), m[0]);
    pos = m.index + m[0].length;
  }
  out.push(text.slice(pos).replace(GUILD, rep));
  return out.join('');
}

// [[piece, isGuild]]
export function splitGuild(text) {
  const out = [];
  let pos = 0;
  for (const m of matches(GUILD, text)) {
    if (m.index > pos) out.push([text.slice(pos, m.index), false]);
    out.push([m[0], true]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push([text.slice(pos), false]);
  return out.length ? out : [[text, false]];
}

export const CLASS_COLORS = {
  A: '#C69B6D', B: '#F48CBA', C: '#AAD372', D: '#FFF468', E: '#FFFFFF', F: '#C41E3A', G: '#0070DD',
  H: '#3FC7EB', I: '#8788EE', J: '#00FF98', K: '#FF7C0A', L: '#A330C9', M: '#33937F',
};
export const QUALITY_COLORS = {
  0: '#9d9d9d', 1: '#ffffff', 2: '#1eff00', 3: '#0070dd', 4: '#a335ee', 5: '#ff8000', 6: '#e6cc80', 7: '#00ccff',
  10: '#ffff00', 11: '#71d5ff', 12: '#ffd100', 13: '#e86bd0', 14: '#c7c7cf', 15: '#eda55f', 20: '#8c8c8c',
  30: '#c41e3a', 31: '#a330c9', 32: '#ff7c0a', 33: '#33937f', 34: '#aad372', 35: '#3fc7eb', 36: '#00ff98', 37: '#f48cba',
  38: '#ffffff', 39: '#fff468', 40: '#0070dd', 41: '#8788ee', 42: '#c69b6d',
  50: '#0000ff', 51: '#ff0000', 52: '#ff8040', 53: '#ffff00', 54: '#fff569', 55: '#808080', 56: '#00d1ff', 57: '#80528c',
  58: '#4d85e6', 59: '#f2e699', 60: '#0080ff', 61: '#6600cc', 62: '#b5ffeb', 63: '#1a1afa', 64: '#c942fd', 65: '#ff9c00',
  66: '#cc9900', 67: '#008c80', 68: '#85ff85', 69: '#fffab8', 70: '#ff6b6b',
  71: '#40ff40', 72: '#40bf40', 73: '#aaaaff', 74: '#75c7ff', 75: '#ff80ff', 76: '#ff4040', 77: '#ffc0c0', 78: '#ff480a',
};

const QUEST_ID = /\s*\(\d+\)(\]?)(?=\n?$)/;
const JOSA = /\|1([^;|]*);([^;|]*);/g;

function hasFinalConsonant(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0xAC00 && c <= 0xD7A3) return (c - 0xAC00) % 28 !== 0;
  return '013678'.includes(ch);
}

// the Korean client leaves particles as |1이;가; : the first form after a letter with a final consonant, else the second
export function resolveJosa(text) {
  return text.replace(JOSA, (m0, first, second, off) => {
    const prev = off > 0 ? text[off - 1] : '';
    if (!prev || !hasFinalConsonant(prev)) return second;
    const p = prev.codePointAt(0);
    if (first.startsWith('으') && p >= 0xAC00 && p <= 0xD7A3 && (p - 0xAC00) % 28 === 8) return second;
    return first;
  });
}

export const ORIG_SEP = '\x04', TIP_SEP = '\x07', TIP_LINE = '\x08', TIP_RIGHT = '\x0c', TIP_COL = '\x0b';

// [[text, palette code]] of one tooltip line (it starts white, code 1)
export function tipRuns(line) {
  const out = [];
  let c = 1;
  const parts = line.split(TIP_COL);
  if (parts[0]) out.push([parts[0], c]);
  for (const part of parts.slice(1)) {
    if (!part) continue;
    c = part.charCodeAt(0) - 48;
    const t = part.slice(1);
    if (t) out.push([t, c]);
  }
  return out;
}

export const tipPlain = line => tipRuns(line).map(r => r[0]).join('').split(TIP_RIGHT).join('  ');

export function splitTip(content) {
  const [head, sep, tip] = partition(content, TIP_SEP);
  if (!sep) return [head, []];
  const lines = tip.split(TIP_LINE);
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return [head, lines];
}

// a received line for the log: <n:name [orig: ...] [tip: ...]>
export function readable(text) {
  text = text.replace(MARK, (m0, c, inner) => {
    const [head, lines] = splitTip(inner);
    const [name, sep, orig] = partition(head, ORIG_SEP);
    let out = `<${c.charCodeAt(0) - 48}:${name}`;
    if (sep && orig) out += ` [orig: ${orig}]`;
    if (lines.length) {
      const shown = lines.map(ln => tipRuns(ln).map(([t, k]) => (k !== 1 ? `{${k}}` : '') + t).join('').split(TIP_RIGHT).join(' :: '));
      out += ` [tip: ${shown.join(' | ')}]`;
    }
    return out + '>';
  });
  text = text.replace(/\x05/g, '~').replace(/\x06/g, '~~');
  return text.replace(/[\x00-\x1f]/g, ch => `<${ch.charCodeAt(0)}>`);
}

function nameOf(q, content, original = false) {
  const [local, sep, orig] = partition(splitTip(content)[0], ORIG_SEP);
  const name = original && sep && orig ? orig : local;
  return q === YELLOW ? name.replace(QUEST_ID, '$1') : name;
}

export const plain = (text, original = false) => text.replace(MARK, (m0, c, inner) => nameOf(c.charCodeAt(0) - 48, inner, original)).replace(STRAY, '');

export const PLACEHOLDER = /[\[［【(（]\s*[Ll]\s*(\d+)\s*[\]］】)）]/g;
const placeholder = () => new RegExp(PLACEHOLDER.source, 'g');

// -> [text with every link replaced by [L1] [L2] ..., [link names]]
export function maskLinks(text) {
  const names = [];
  const masked = text.replace(MARK, (m0, c, inner) => { names.push(nameOf(c.charCodeAt(0) - 48, inner)); return `[L${names.length}]`; }).replace(STRAY, '');
  if (!names.length || !LETTER.test(masked.replace(placeholder(), ''))) return [plain(text), []];
  return [masked, names];
}

export const isServerNotice = (channel, text) => channel === '!SY' && /^\s*\[SERVER\]/i.test(plain(text || ''));
export const isUnintelligible = text => matches(MARK, text).some(m => code(m) === UNINTELLIGIBLE);
export const linkQualities = text => matches(MARK, text).map(code);

function withName(c, content) {
  const [head, lines] = splitTip(content);
  if (!lines.length) return [];
  let name = partition(head, ORIG_SEP)[0].trim();
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  return [TIP_COL + String.fromCharCode(48 + c) + name, ...lines];
}

export const linkTips = text => matches(MARK, text).map(m => withName(code(m), m[2]));

// -> [text, [numbers of the links the translator lost]]
export function ensureLinks(text, names) {
  const present = new Set(matches(placeholder(), text).map(m => parseInt(m[1], 10)));
  const missing = [];
  names.forEach((n, k) => { if (n && !present.has(k + 1)) missing.push(k + 1); });
  if (missing.length) text = text.replace(/\s+$/, '') + ' ' + missing.map(i => `[L${i}]`).join(' ');
  return [text, missing];
}

// [[piece, quality|null]] (with tips: [piece, quality|null, tooltip lines])
export function splitTranslation(text, names, quals, tips = null) {
  const out = [];
  let pos = 0;
  for (const m of matches(placeholder(), text)) {
    const i = parseInt(m[1], 10);
    if (!(i >= 1 && i <= names.length && names[i - 1])) continue;
    if (m.index > pos) out.push([text.slice(pos, m.index), null, []]);
    out.push([names[i - 1], i - 1 < quals.length ? quals[i - 1] : null, tips && i - 1 < tips.length ? tips[i - 1] : []]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push([text.slice(pos), null, []]);
  return out.filter(p => p[0]).map(([p, q, t]) => (tips !== null ? [p, q, t] : [p, q]));
}

const BRACKETED = /\[[^\[\]]*\]/g;
const PROTECTED = /^\|K[^|]*\|k$/;

// a message that is only a protected token comes back empty with whole=true; inside a longer text it becomes "???"
export function hideProtected(text) {
  if (PROTECTED.test(text.trim())) return ['', true];
  return [text.replace(/\|K[^|]*\|k/g, '???'), false];
}

export const COMMAND_PREFIX = '@';
export const isCommand = channel => channel.startsWith(COMMAND_PREFIX);

export function colorBrackets(text, quals, tips = null) {
  const wrap = list => list.map(([p, q, t]) => (tips !== null ? [p, q, t] : [p, q]));
  const spans = matches(BRACKETED, text);
  if (!spans.length || !quals.length) return wrap([[text, null, []]]);
  let qs;
  if (spans.length === quals.length) qs = [...quals];
  else if (new Set(quals).size === 1) qs = spans.map(() => quals[0]);
  else return wrap([[text, null, []]]);
  const same = spans.length === quals.length;
  const out = [];
  let pos = 0;
  spans.forEach((m, k) => {
    if (m.index > pos) out.push([text.slice(pos, m.index), null, []]);
    out.push([m[0], qs[k], tips && same && k < tips.length ? tips[k] : []]);
    pos = m.index + m[0].length;
  });
  if (pos < text.length) out.push([text.slice(pos), null, []]);
  return wrap(out);
}

export function unmaskLinks(text, names) {
  if (!names || !names.length) return text;
  return text.replace(placeholder(), (m0, n) => { const i = parseInt(n, 10); return i >= 1 && i <= names.length && names[i - 1] ? names[i - 1] : m0; });
}

// the text the "do not translate" checks look at: the line without its links (a line that is only links is checked as it is)
export function checkText(text) {
  const rest = text.replace(MARK, '').replace(STRAY, '');
  return LETTER.test(rest) ? rest : plain(text);
}

export function hasOriginal(text) {
  return matches(MARK, text).some(m => { const [local, sep, orig] = partition(splitTip(m[2])[0], ORIG_SEP); return sep && orig && orig !== local; });
}

export function segmentsTips(text, original = true) {
  const out = [];
  let pos = 0;
  for (const m of matches(MARK, text)) {
    if (m.index > pos) out.push([text.slice(pos, m.index).replace(STRAY, ''), null, []]);
    out.push([nameOf(code(m), m[2], original), code(m), withName(code(m), m[2])]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push([text.slice(pos).replace(STRAY, ''), null, []]);
  return out.filter(t => t[0]);
}

export function segments(text, original = true) {
  const out = [];
  let pos = 0;
  for (const m of matches(MARK, text)) {
    if (m.index > pos) out.push([text.slice(pos, m.index).replace(STRAY, ''), null]);
    out.push([nameOf(code(m), m[2], original), code(m)]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push([text.slice(pos).replace(STRAY, ''), null]);
  return out.filter(p => p[0]);
}
