// Turns what the player typed into the text that goes to the clipboard (and from there into the game chat box). Port of outgoing.py.
//   3.0: the input line has TWO fields. The left one (`prefix`: "/w Name Surname", "/p" ...) is copied untouched, the right one is the
//   sentence that is translated. The program does not know any chat command (their form differs between game versions).
//   * A sentence that itself starts with "/" is a command, not a sentence: copied untouched, never translated.
//   * The result is one line, never starts with "/", has "|" doubled (WoW's escape character) and fits the 255 bytes of a chat message.
import { tr } from './i18n.js';
import { TranslateError } from './translate_rules.js';

export const MAX_BYTES = 255;
const LABEL = /^\s*(translation|translated|번역)\s*[:：]\s*/i;
const QUOTES = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['«', '»']];
const LETTER = /\p{L}/u;

export class OutgoingError extends Error {}
export class Prepared {
  constructor(text, translated, note = null) { this.text = text; this.translated = translated; this.note = note; }   // text = exactly what goes to the clipboard
}

function unquote(s) {
  for (const [a, b] of QUOTES) if ([...s].length >= 2 && s[0] === a && s[s.length - 1] === b) return s.slice(1, -1).trim();
  return s;
}

export function cleanTranslation(out) {
  let s = (out || '').trim().replace(/\s*[\r\n]+\s*/g, ' ').trim();
  s = unquote(s);
  s = unquote(s.replace(LABEL, '').trim());                // "Translation: ..." label, with or without quotes around it
  return s.replace(/^[/ ]+/, '').trim();                   // a translation must never turn into a game command
}

export const escapePipes = s => s.replace(/\|/g, '||');
const short = (text, n = 70) => ([...text].length <= n ? text : [...text].slice(0, n).join('') + '…');
const bytes = text => new TextEncoder().encode(text).length;

export function fit(text) {
  const n = bytes(text);
  if (n > MAX_BYTES) throw new OutgoingError(tr('번역문이 너무 깁니다 ({n}/{max}바이트). 줄여서 다시 입력하세요: {preview}', { n, max: MAX_BYTES, preview: short(text) }));
}

// translateFn(cfg, text) -> Promise<string> (in the program: translator.translateOutgoing). Throws OutgoingError (a message for the user)
// or returns Prepared. prefix: the left field of the input line ("" = none); the result is prefix + one space + the sentence.
export async function prepare(cfg, raw, translateFn, prefix = '') {
  const body = (raw || '').trim();
  prefix = (prefix || '').trim();
  const join = t => (prefix ? prefix + ' ' + t : t);
  if (!body) throw new OutgoingError(tr('보낼 내용이 비어 있습니다'));
  if (body.startsWith('/')) {
    const text = join(escapePipes(body));
    fit(text);
    return new Prepared(text, false, tr('명령어는 번역하지 않고 그대로 복사했습니다'));
  }
  let out, translated;
  if (!LETTER.test(body)) { out = body; translated = false; }           // numbers / symbols only: nothing to translate
  else {
    try { out = cleanTranslation(await translateFn(cfg, body)); }
    catch (e) {
      if (e instanceof TranslateError) throw new OutgoingError(tr('번역 실패: {err}', { err: e.message }));
      throw e;
    }
    translated = true;
  }
  if (!out) throw new OutgoingError(tr('번역 결과가 비어 있습니다'));
  const text = join(escapePipes(out));
  fit(text);
  return new Prepared(text, translated);
}
