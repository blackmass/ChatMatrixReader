// Puts the pieces of a long chat message together again (docs/PROTOCOL.md, "long messages"). Port of joiner.py.
//   \5 at the end of a piece: the message goes on in the next line. \5 at the start: continues the one before.
//   \6<code> at the start: the same, and the piece starts inside the link marker with this code.
import { log, fmt } from './log.js';

export const CONT = '\x05', CONT_IN = '\x06', ELLIPSIS = '…', TIMEOUT = 1.0;
const JUNK = '\x04\x07\x08\x0b\x0c';

// the rest of a link marker whose start was lost, up to its close -> [what comes after the marker, still open in the next piece]
function junk(text) {
  const close = text.indexOf('\x03');
  if (close < 0) return ['', true];
  const rest = text.slice(close + 1);
  return [rest, rest === ''];
}

const count = (s, ch) => s.split(ch).length - 1;
const closed = body => (count(body, '\x02') > count(body, '\x03') ? body + '\x03' : body);

export class Joiner {
  constructor(timeout = TIMEOUT) {
    this.timeout = timeout;
    this.line = null;            // the message being collected
    this.pieces = 0;
    this.lastId = 0;
    this.deadline = 0;
    this.deadOpen = false;       // the piece before ended inside a link marker whose start was lost
  }

  _finish(why = null) {
    let line = this.line;
    this.line = null;
    if (why) log.warn(fmt('긴 메시지 %d조각에서 끊김 (%s): %s %s, %d자', this.pieces, why, line.channel, line.sender, [...line.text].length));
    else log.info(fmt('긴 메시지 %d조각 합침: %s %s, %d자', this.pieces, line.channel, line.sender, [...line.text].length));
    if (why) line = { ...line, text: closed(line.text) + ELLIPSIS };
    return line;
  }

  pending() { return this.line !== null; }

  // `now` in seconds. -> the lines to show
  feed(line, now) {
    let text = line.text;
    let lead = null;                                  // null, '' (plain continuation) or the link code
    if (text.startsWith(CONT_IN) && text.length >= 2) { lead = text[1]; text = text.slice(2); }
    else if (text.startsWith(CONT)) { lead = ''; text = text.slice(1); }
    const goesOn = text.endsWith(CONT);
    if (goesOn) text = text.slice(0, -1);
    const out = [];
    if (this.line !== null) {
      const next = this.lastId % 65535 + 1;
      if (lead !== null && line.channel === this.line.channel && line.sender === this.line.sender && line.id === next) {
        let body = this.line.text;
        if (lead && this.deadOpen) [text, this.deadOpen] = junk(text);
        else if (lead && body.endsWith('\x03')) body = body.slice(0, -1);
        this.line = { ...this.line, text: body + text };
        this.lastId = line.id;
        this.pieces += 1;
        if (goesOn) { this.deadline = now + this.timeout; return out; }
        return [this._finish()];
      }
      out.push(this._finish(lead === null ? '다음 줄이 이어짐이 아님' : '다음 조각이 아님 (채널/화자/번호 불일치, 조각 유실)'));
    }
    this.deadOpen = false;
    if (lead !== null) {                              // a continuation whose start was lost
      log.warn(`이어지는 조각인데 앞 조각이 없음 (유실): ${line.channel} ${line.sender}`);
      if (lead) {
        const close = text.indexOf('\x03');
        const head = close < 0 ? text : text.slice(0, close);
        if (head.includes('\x04')) text = '\x02' + lead + head.split('\x04')[0] + '\x03' + (close >= 0 ? text.slice(close + 1) : '');
        else if ([...JUNK].some(c => head.includes(c))) [text, this.deadOpen] = junk(text);
        else text = '\x02' + lead + text;
      }
      text = ELLIPSIS + text;
    }
    line = { ...line, text };
    if (goesOn) { this.line = line; this.lastId = line.id; this.deadline = now + this.timeout; this.pieces = 1; return out; }
    out.push(line);
    return out;
  }

  // nothing came after the last piece for a while (or the reader stops): close the message
  flushDue(now, force = false) {
    if (this.line !== null && (force || now >= this.deadline)) return [this._finish(!force ? '1초 안에 다음 조각이 오지 않음' : '종료')];
    return [];
  }
}
