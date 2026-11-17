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
import { notInstalledText, explainError, LOG_NAME } from './voice_text.js';

export const MAIN = 1;
export const SPEECH_CODES = winconf.SPEECH_CODES;
export const TRANSLATED_CODES = [...SPEECH_CODES, '!VC'];
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

// what stands in front of a line: nothing, like the game's chat, except "(1)" for numbered channels and an arrow for a whisper you sent
export function codePrefix(code, mode) {
  if (mode === 'nochan' || mode === 'body') return '';
  if (code === '!VC') return tr('(음성)') + ' ';
  if (mode === 'detail') return `(${SHOWN_CODE[code] ?? code}) `;
  if (code === 'WT' || code === 'BT') return '→ ';
  if (code.startsWith('C') && /^\d+$/.test(code.slice(1))) return `(${code.slice(1)}) `;
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
  onLine(line) {
    const cfg = this.getCfg();
    try { log.info(fmt('수신 #%s %s | %s | %d바이트 | %s', line.id ?? '?', line.channel, line.sender ?? '', byteLength(line.text), chattext.readable(line.text).slice(0, 600))); } catch { /* the log must not stop a line */ }
    if (chattext.isCommand(line.channel)) { this.command(line); return []; }
    if (cfg.skip_regex_hide && line.text !== '[restricted]' && matchesSkipRegex(chattext.checkText(line.text), cfg)) return [];
    const stamp = this.clock();
    if (line.text === '[restricted]') return [this.restrictedNotice(stamp)];
    if (line.channel === '!RS') {
      this.restricted = 0;
      return [{ type: 'Notice', kind: 'restriction_over', text: tr('✓ 채팅 제한이 해제되었습니다'), stamp, replace: false, tag: '' }];
    }
    this.restricted = 0;
    const windows = this.getWindows().filter(w => winconf.accepts(w, line.channel));
    const targets = [...(winconf.parentShows(cfg, line.channel) ? [MAIN] : []), ...windows.map(w => w.id)];
    if (!targets.length) return [];
    const { chat, masked, names, quals, tips } = this.build(line, stamp, cfg);
    if (!chat.translatable) {
      try { log.info(`번역 안 함 #${line.id ?? '?'} ${line.channel}: ${skipReason(chat.plain, cfg, chattext.checkText(line.text)) || 'not a line that is translated (system / protected ...)'}`); } catch { /* log only */ }
      return [{ type: 'LineAdded', line: chat, targets, pending: false }];
    }
    const route = routeFor(cfg, SPEECH_CODES.includes(line.channel) ? '!NPC' : line.channel);
    if (route === ROUTE_OFF) return [{ type: 'LineAdded', line: { ...chat, translatable: false }, targets, pending: false }];
    this.pending.set(chat.id, { targets, names, quals, tips });
    // an answer from the cache comes back INSIDE submit(): it is kept until the line itself has been announced (else the window would
    // get the translation of a line it does not have yet)
    this.early = [];
    let queued, early;
    try { queued = this.translations.submit(chat.id, masked, route); }
    finally { early = this.early; this.early = null; }
    const events = [{ type: 'LineAdded', line: chat, targets, pending: !!queued }];
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
    return [{ type: 'Translated', id, targets: pend.targets, pieces: withGuild(fromSegments(seq)), error: null, show_error: true }];
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
