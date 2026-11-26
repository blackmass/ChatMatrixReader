// The line pipeline: what happens to a chat line between "the capture read it" and "a window shows it". No window code.
// Port of pipeline.py (see its header and docs/ARCHITECTURE.md).
//
//   const p = new Pipeline({ getCfg, translations, getWindows, clock })
//   p.onLines(pieces, now)  p.onLine(line)  p.onTranslation(id, text, err)  p.onVoice(message)  p.tick(now)
//
// Events are plain objects with a `type`: LineAdded, Translated, Notice, Status, Partial.
import * as chattext from './chattext.js';
import { Joiner } from './joiner.js';
import { log, fmt } from './log.js';
import * as winconf from './winconf.js';
import { tr } from './i18n.js';
import { matchesSkipRegex, shouldTranslate, skipReason, routeFor, ROUTE_OFF } from './translate_rules.js';
import { stripStamp } from './ocr.js';
import { notInstalledText, explainError, LOG_NAME } from './voice_text.js';

export const MAIN = 1;
export const SPEECH_CODES = winconf.SPEECH_CODES;
export const TRANSLATED_CODES = [...SPEECH_CODES, '!VC', '!OCR'];
export const ANNOUNCE_COLOR_CODES = ['!AD', '!UN', '!CN'];
export const PING_SYMBOLS = '◈⚑⚠⚔▼';
export const SHOWN_CODE = { WT: 'W→', BT: 'B→' };

// A part of a line. role: null | "guild" | "protmark" | "ping" | "sender" (cls = class letter when it gets the class colour)
export const piece = (text, o = {}) => ({ text, quality: o.quality ?? null, tip: o.tip ?? [], role: o.role ?? null, cls: o.cls ?? null });

export function withGuild(pieces) {
  const out = [];
  for (const p of pieces) {
    if (p.role === null && p.quality === null && !p.tip.length && p.text.includes('<')) {
      for (const [s, g] of chattext.splitGuild(p.text)) out.push(piece(s, { role: g ? 'guild' : null }));
    } else out.push(p);
  }
  return out;
}

const fromSegments = seq => seq.map(([text, q, tip]) => piece(text, { quality: Object.hasOwn(chattext.QUALITY_COLORS, q) ? q : null, tip: tip || [] }));

// the front of a line read by the OCR: the time and every [..] group at the beginning, with the ": " after them; what is in square brackets inside of the words
export const OCR_BRACKET = /\[[^\[\]\n]{1,60}\]/g;
const LETTER_OCR = /\p{L}/u;
export function ocrFront(text) {
  const m = /^\s*(?:\[[^\[\]\n]{1,60}\]\s*)+(?::\s*)?/u.exec(text);
  return m ? m[0] : '';
}

// what stands in front of a line: nothing, like the game's chat, except "[1]" for numbered channels and an arrow for a whisper you sent
// (square brackets, as the game writes a channel: "[1. General] [Name]: text"; 2.x / 3.0.x used round ones)
export function codePrefix(code, mode) {
  if (mode === 'nochan' || mode === 'body') return '';
  if (code === '!VC') return '[' + tr('음성') + '] ';
  if (code === '!OCR') return '[OCR] ';                                // (a line read from the picture of the screen: marked, it can be wrong)
  if (code === '!PLG') return '[' + tr('플러그인') + '] ';
  if (mode === 'detail') return `[${SHOWN_CODE[code] ?? code}] `;
  if (code === 'WT' || code === 'BT') return '→ ';
  if (code.startsWith('C') && /^\d+$/.test(code.slice(1))) return `[${code.slice(1)}] `;
  return '';
}

// the beginning of a line in the window with the settings `conf` (null = the main window): the time, the channel mark, "[name]: "
export function headPieces(line, conf, cfg) {
  conf = conf || cfg;
  const mode = winconf.headMode(conf, cfg);
  const stamp = winconf.opt(conf, cfg, 'show_time', true) ? line.stamp + ' ' : '';
  const mark = codePrefix(line.code, mode);
  if (line.sender && mode !== 'body') {
    const cls = winconf.opt(conf, cfg, 'class_colors', true) && Object.hasOwn(chattext.CLASS_COLORS, line.cls) ? line.cls : null;
    return [piece(`${stamp}${mark}[`), piece(line.sender, { role: 'sender', cls }), piece(']: ')];
  }
  return [piece(`${stamp}${mark}`)];
}

const hms = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const byteLength = s => new TextEncoder().encode(s).length;

export class Pipeline {
  // getCfg() -> the config; translations: { submit(id, text, route) -> bool }; getWindows() -> settings of the extra windows open now
  constructor({ getCfg, translations, getWindows = () => [], clock = hms, commands = {} }) {
    this.getCfg = getCfg;
    this.translations = translations;
    this.getWindows = getWindows;
    this.clock = clock;
    this.commands = { ...commands };
    this.unknown = new Set();
    this.joiner = new Joiner();
    this.nextLineId = 1;
    this.pending = new Map();
    this.restricted = 0;
    this.ocrHook = null;                                     // { reading(): the OCR reads the restricted lines from the screen now, begin()/end(): the text of the notice (or null) when the reading begins / ends }
    this.ocrSeats = new Map();                               // number t of a censored message -> { id, targets }: the place of its OCR line, kept in the chat from the moment the message came
    this.quietRestricted = null;                             // () -> true while the OCR reads the restricted lines: the notice "chat is restricted" for every line is not needed then
    this.observers = [];                                   // fn(line) for every line that comes in (the plugins that may read the chat): they only watch
    this.lastError = null;
    this.partial = false;
  }

  onLines(pieces, now) {
    const events = [];
    for (const p of pieces) {
      let lines;
      try { lines = this.joiner.feed(p, now); } catch (e) { log.error('줄 합치기 중 오류: ' + String(p && p.text).slice(0, 80), e); continue; }
      for (const line of lines) events.push(...this.safe(line));
    }
    return events;
  }

  tick(now) {
    const events = [];
    for (const line of this.joiner.flushDue(now)) events.push(...this.safe(line));
    return events;
  }

  safe(line) {
    try { return this.onLine(line); } catch (e) { log.error('줄 처리 중 오류: ' + String(line && line.text).slice(0, 80), e); return []; }
  }

  // a chat line that has not been seen before -> events
  // watching the lines that come in: observe(fn) -> the way to stop. A watcher that throws does not disturb the pipeline.
  observe(fn) { this.observers.push(fn); return () => { this.observers = this.observers.filter(f => f !== fn); }; }

  onLine(line) {
    for (const f of this.observers) { try { f(line); } catch (e) { log.error('줄을 보는 쪽에서 오류', e); } }
    const cfg = this.getCfg();
    try { log.info(fmt('수신 #%s %s | %s | %d바이트 | %s', line.id ?? '?', line.channel, line.sender ?? '', byteLength(line.text), chattext.readable(line.text).slice(0, 600))); } catch { /* the log must not stop a line */ }
    if (line.channel === '@CS') return [];                             // (the state of the chat window, for the OCR: not a line)
    if (line.channel === '@TS' || line.channel === '@TH' || line.channel === '@TK') return [];       // (the tooltip of the game to translate: the observers have it, see core/tip_translate.js; not a line)
    if (line.channel === '@RT') return this.reserveOcr(line);          // (a censored message of the first chat window: its place in the chat is kept for the OCR line)
    if (chattext.isCommand(line.channel) && line.channel !== '@RS') { this.command(line); return []; }
    if (cfg.skip_regex_hide && line.text !== '[restricted]' && matchesSkipRegex(chattext.checkText(line.text), cfg)) return [];
    const stamp = this.clock();
    if (line.text === '[restricted]') {
      if (this.quietRestricted && this.quietRestricted()) { this.restricted += 1; return []; }
      return [this.restrictedNotice(stamp)];
    }
    if (line.channel === '@RS') {
      this.restricted = 0;
      if (this.quietRestricted && this.quietRestricted()) {               // (the OCR is reading: it tells the end itself, at once, in the place where the end came; what was passed on is read on, the places are kept)
        const text = this.ocrHook && this.ocrHook.end ? this.ocrHook.end() : null;
        return text ? [{ type: 'Notice', kind: 'system', text, stamp, replace: false, tag: '' }] : [];
      }
      return [{ type: 'Notice', kind: 'restriction_over', text: tr('✓ 채팅 제한이 해제되었습니다'), stamp, replace: false, tag: '' }];
    }
    this.restricted = 0;
    const targets = this.targetsFor(line.channel, cfg);
    if (!targets.length) return [];
    return this.announce(line, cfg, stamp, targets);
  }

  targetsFor(code, cfg) {
    const windows = this.getWindows().filter(w => winconf.accepts(w, code));
    return [...(winconf.parentShows(cfg, code) ? [MAIN] : []), ...windows.map(w => w.id)];
  }

  // The line is built and told to the windows (type 'LineAdded'; 'LineUpdated' for a line that took the place that was kept for it, id = the id of that place) and given to the translation.
  announce(line, cfg, stamp, targets, type = 'LineAdded', id = null) {
    const { chat, masked, names, quals, tips, head } = this.build(line, stamp, cfg);
    if (id !== null) chat.id = id;
    if (!chat.translatable) {
      try { log.info(`번역 안 함 #${line.id ?? '?'} ${line.channel}: ${skipReason(chat.plain, cfg, chattext.checkText(line.text)) || 'not a line that is translated (system / protected ...)'}`); } catch { /* log only */ }
      return [{ type, line: chat, targets, pending: false }];
    }
    const route = routeFor(cfg, SPEECH_CODES.includes(line.channel) ? '!NPC' : line.channel);
    if (route === ROUTE_OFF) return [{ type, line: { ...chat, translatable: false }, targets, pending: false }];
    this.pending.set(chat.id, { targets, names, quals, tips, head });
    // an answer from the cache comes back INSIDE submit(): it is kept until the line itself has been announced (else the window would
    // get the translation of a line it does not have yet)
    this.early = [];
    let queued, early;
    try { queued = this.translations.submit(chat.id, masked, route); }
    finally { early = this.early; this.early = null; }
    const events = [{ type, line: chat, targets, pending: !!queued }];
    for (const r of early) events.push(...this.onTranslation(r.id, r.result, r.err));
    if (!queued) {
      this.pending.delete(chat.id);
      events.push({ type: 'Status', text: tr('번역 대기열이 가득 차서 일부 줄을 번역하지 못했습니다') });
    }
    return events;
  }

  // -> { chat, masked (the text for the translator), names, quals, tips }
  build(line, stamp, cfg) {
    const code = line.channel;
    if (code === '!OCR') return this.buildOcr(line, stamp, cfg);
    let sender = line.sender, body = line.text;
    const perLine = ANNOUNCE_COLOR_CODES.includes(code);
    let style = code;
    if (!sender && code.startsWith('C') && code !== 'CM' && !perLine && !Object.hasOwn(chattext.QUALITY_COLORS, line.base)) style = '!SY';
    let protectedText;
    [body, protectedText] = chattext.hideProtected(body);
    if (protectedText) body = code === 'O' ? tr('⚠ 길드관리자 메시지는 보호되어 있어 읽을 수 없습니다. 게임에서 직접 확인하세요.') : tr('⚠ 보호된 메시지 (게임이 내용을 알려주지 않아 읽을 수 없음)');
    body = chattext.resolveJosa(body);
    body = chattext.markGuilds(body);
    if (code.startsWith('!') && body.includes('%s') && sender) { body = body.split('%s').join(sender); sender = ''; }
    let pieces = fromSegments(chattext.segmentsTips(body, !code.startsWith('!')));
    if (protectedText) pieces = [piece(body.slice(0, 1), { role: 'protmark' }), piece(body.slice(1))];
    if (code === '!PG' && pieces.length && PING_SYMBOLS.includes(pieces[0].text.slice(0, 1)) && pieces[0].text && pieces[0].role === null && pieces[0].quality === null) {
      const first = pieces[0];
      const sym = [...first.text][0];
      pieces.splice(0, 1, piece(sym, { role: 'ping' }), piece(first.text.slice(sym.length), { quality: first.quality, tip: first.tip }));
    }
    if (line.link) for (const p of pieces) if (p.quality === chattext.LIGHT_BLUE && p.tip.length) p.link = String(line.link);          // (a link of a plugin: the id the window sends back when it is clicked)
    const plain = chattext.plain(body);
    const translatable = !protectedText
      && !(code.startsWith('!') && !TRANSLATED_CODES.includes(code) && !chattext.isServerNotice(code, body))
      && !chattext.isUnintelligible(body)
      && shouldTranslate(plain, cfg, chattext.checkText(body));
    const both = !translatable && !protectedText && !code.startsWith('!') && chattext.hasOriginal(body);
    const [masked, names] = translatable ? chattext.maskLinks(body) : [plain, []];
    const quals = translatable ? chattext.linkQualities(body) : [];
    const tips = translatable ? chattext.linkTips(body) : [];
    const chat = {
      id: this.nextLineId++, code, sender, cls: line.cls ?? '', stamp, base: line.base ?? -1, style, per_line: perLine,
      pieces: withGuild(pieces), local: both ? withGuild(fromSegments(chattext.segmentsTips(body, false))) : [],
      plain, plain_original: chattext.plain(body, true), translatable, both, protected: protectedText,
    };
    return { chat, masked, names, quals, tips };
  }

  // A line read from the picture of the screen: what the game wrote in front of the words (the time, the channel, the name, all in square brackets) is not translated and does not
  // count when the language is judged, and a [name] inside of the words (an item, a quest) is kept as it is. Only the words are translated; the front is put back before them.
  buildOcr(line, stamp, cfg) {
    const text = stripStamp(line.text);
    const front = ocrFront(text);
    const rest = text.slice(front.length);
    const names = [];
    const masked = rest.replace(OCR_BRACKET, m => { names.push(m); return `[L${names.length}]`; });
    const words = rest.replace(OCR_BRACKET, ' ');                                  // (what is judged: the words without the bracketed names)
    const translatable = LETTER_OCR.test(words) && shouldTranslate(words, cfg, chattext.checkText(words));
    const pieces = [piece(front), ...fromSegments([[rest, null, []]])].filter(p => p.text);
    const chat = {
      id: this.nextLineId++, code: line.channel, sender: '', cls: '', stamp, base: -1, style: line.channel, per_line: false,
      pieces: withGuild(pieces), local: [], plain: text, plain_original: text, translatable, both: false, protected: false,
    };
    return { chat, masked: translatable ? masked : text, names: translatable ? names : [], quals: names.map(() => null), tips: names.map(() => []), head: front };
  }

  // ---- the OCR lines keep their place. The line "@RT" of a censored message comes in the order of the chat, so the place of its OCR line is known at once: a line "[OCR] …" is put there, and
  // when the picture has been read the words take its place (LineUpdated), however late that is; a line that could not be read says so there.
  reserveOcr(line) {
    const hook = this.ocrHook;
    if (!hook || !hook.reading()) return [];
    const t = Number(String(line.text ?? '').trim());
    if (!Number.isFinite(t) || this.ocrSeats.has(t)) return [];
    const cfg = this.getCfg(), stamp = this.clock(), events = [];
    const note = hook.begin ? hook.begin() : null;
    if (note) events.push({ type: 'Notice', kind: 'system', text: note, stamp, replace: false, tag: '' });
    const targets = this.targetsFor('!OCR', cfg);
    if (!targets.length) return events;
    const { chat } = this.build({ channel: '!OCR', id: 0, sender: '', text: '…', cls: '', base: -1 }, stamp, cfg);
    chat.translatable = false;
    this.ocrSeats.set(t, { id: chat.id, targets });
    if (this.ocrSeats.size > 300) this.ocrSeats.delete(this.ocrSeats.keys().next().value);
    events.push({ type: 'LineAdded', line: chat, targets, pending: false });
    return events;
  }

  fillOcr(t, text) {
    const raw = { channel: '!OCR', id: 0, sender: '', text, cls: '', base: -1 };
    const seat = this.ocrSeats.get(t);
    if (!seat) return this.onLine(raw);                                    // (no place was kept for it: it comes as a new line)
    this.ocrSeats.delete(t);
    return this.announce(raw, this.getCfg(), this.clock(), seat.targets, 'LineUpdated', seat.id);
  }

  lostOcr(t) {
    const seat = this.ocrSeats.get(t);
    if (!seat) return [];
    this.ocrSeats.delete(t);
    const { chat } = this.build({ channel: '!OCR', id: 0, sender: '', text: tr('(읽지 못함)'), cls: '', base: -1 }, this.clock(), this.getCfg());
    chat.id = seat.id; chat.translatable = false;
    return [{ type: 'LineUpdated', line: chat, targets: seat.targets, pending: false }];
  }

  restrictedNotice(stamp) {
    this.restricted += 1;
    const text = this.restricted === 1 ? tr('⚠ 채팅이 제한되어 읽을 수 없음') : tr('⚠ 채팅이 제한되어 읽을 수 없음 ({n}줄)', { n: this.restricted });
    return { type: 'Notice', kind: 'restricted', text, stamp, replace: this.restricted > 1, tag: '' };
  }

  command(line) {
    const handler = this.commands[line.channel.slice(1)];
    if (handler) { try { handler(line); } catch (e) { log.error('명령 처리 오류: ' + line.channel, e); } }
    else if (!this.unknown.has(line.channel)) {
      this.unknown.add(line.channel);
      log.info(`알 수 없는 명령 줄을 무시합니다: ${line.channel} (새 버전의 애드온일 수 있음)`);
    }
  }

  // a result of the translation service
  onTranslation(id, result, err) {
    if (this.early) { this.early.push({ id, result, err }); return []; }
    const pend = this.pending.get(id);
    if (!pend) return [];
    this.pending.delete(id);
    const events = [];
    if (err) {
      events.push({ type: 'Status', text: tr('번역 오류: {err}', { err }) });
      const show = err !== this.lastError;
      this.lastError = err;
      events.push({ type: 'Translated', id, targets: pend.targets, pieces: null, error: tr('번역 오류: {err}', { err }), show_error: show });
      return events;
    }
    this.lastError = null;
    if (!result) return [{ type: 'Translated', id, targets: pend.targets, pieces: null, error: null, show_error: true }];
    let seq;
    if (pend.names.length) {
      const [fixed, lost] = chattext.ensureLinks(result, pend.names);
      result = fixed;
      if (lost.length) log.warn('번역에서 링크 자리표시자가 빠짐: ' + lost.map(i => `[L${i}]`).join(', ') + ' -> 끝에 붙임');
      seq = chattext.splitTranslation(result, pend.names, pend.quals, pend.tips);
    } else seq = chattext.colorBrackets(result, pend.quals, pend.tips);
    const shown = fromSegments(seq);
    if (pend.head) shown.unshift(piece(pend.head));                    // (a line of the OCR: the front stays as it was read)
    return [{ type: 'Translated', id, targets: pend.targets, pieces: withGuild(shown), error: null, show_error: true }];
  }

  // messages of the voice process
  onVoice(m) {
    const events = [];
    switch (m.type) {
      case 'text': {
        events.push(...this.partialEnd());
        const text = (m.text || '').trim();
        if (text) events.push(...this.safe({ channel: '!VC', id: 0, sender: '', text, cls: '', base: -1 }));
        break;
      }
      case 'partial': {
        const text = (m.text || '').trim();
        if (text) { this.partial = true; events.push({ type: 'Partial', text: [...text].slice(-70).join('') }); }
        break;
      }
      case 'status': {
        let msg = m.msg || '';
        log.info(`음성 인식 상태: ${m.state} ${msg}`);
        if (m.state === 'error') {
          if (msg === 'not installed') msg = notInstalledText();
          events.push({ type: 'Notice', kind: 'system', text: '⚠ ' + tr('음성 인식 오류: {msg}', { msg: explainError(msg) }), stamp: this.clock(), replace: false, tag: '' });
        }
        break;
      }
      case 'warn': log.info('음성 인식 경고: ' + (m.msg || '')); break;
      case 'exit':
        events.push(...this.partialEnd());
        // only when it ended by itself: an engine that was stopped on purpose (m.expected, set by voice_host.js) ends without a word
        if (!m.expected) events.push({ type: 'Notice', kind: 'system', text: '⚠ ' + tr('음성 인식이 예상과 달리 종료되었습니다 (코드 {code}). 자세한 내용: {path}', { code: m.code, path: LOG_NAME }), stamp: this.clock(), replace: false, tag: '' });
        break;
      default: break;
    }
    return events;
  }

  partialEnd() {
    if (this.partial) { this.partial = false; return [{ type: 'Partial', text: '' }]; }
    return [];
  }
}
