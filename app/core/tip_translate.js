// The translation of a tooltip of the game, shown next to it (docs/HANDOFF.md 4-0aa, 4-0ab). The addon tells three lines (the channel codes TIP_CODES), the reader keeps the state:
//   "@TS" show:  sender "kind,serial,leader,left,bottom,width,height,pw,ph[,cleft,cbottom,cwidth,cheight]" = the place of the tooltip in physical screen pixels (y from the bottom; pw, ph = the size
//                of the screen) and the leader (the id: one leader has one listing), and - when the words of the tooltip cannot be read by the addon (a comment of a party finder listing is a protected
//                string "|K..|k") - the place of the words (cleft ..., as it is: the reader makes its picture a little larger) and reads it with OCR. A kind that gives its words (text) needs no picture.
//                Shown at once ("translating..."), the translation takes its place when it is there.
//   "@TK" alive: sender = the serial; comes every second while the tooltip is shown.
//   "@TH" hide:  sender = the serial.
// The tooltip is closed by: "@TH", no "@TK" for ALIVE_S seconds (the matrix cannot be read: a loading screen, the game went away), the game not being in front (it comes back by itself when the game is
// back in front and the "@TK" lines go on), a newer "@TS". What was translated is kept by kind + leader + the words (a leader has one listing: when the words change it is translated again).
// All the outside things are given in (read, canRead, translate, skip, show, hide, front, now), so this is tested without the program around it.

export const TIP_CODES = ['@TS', '@TH', '@TK'];
export const ALIVE_S = 2.5;

const hashOf = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ':' + s.length; };

// "kind,serial,leader,left,bottom,width,height,pw,ph[,cleft,cbottom,cwidth,cheight]" -> the parts, or null
export function parseShow(line) {
  const f = String(line.sender ?? '').split(',');
  if (f.length < 9) return null;
  const n = f.slice(3, 9).map(Number);
  const serial = Number(f[1]);
  if (!f[0] || !Number.isFinite(serial) || n.some(v => !Number.isFinite(v)) || n[2] <= 0 || n[3] <= 0 || n[4] <= 0 || n[5] <= 0) return null;
  let capture = null;                                                           // where the words are (physical screen pixels), when the reader has to read them from the picture
  if (f.length >= 13) {
    const c = f.slice(9, 13).map(Number);
    if (c.every(Number.isFinite) && c[2] > 0 && c[3] > 0) capture = { left: c[0], bottom: c[1], width: c[2], height: c[3] };
  }
  const text = capture ? '' : String(line.text ?? '').replace(/^\s+/g, '').replace(/\s+$/g, '');
  return { kind: f[0], serial, leader: f[2], rect: { left: n[0], bottom: n[1], width: n[2], height: n[3] }, pw: n[4], ph: n[5], capture, text };
}

export class TipTr {
  // read(p, cb): reads the words of the place p.capture (a picture, OCR): cb(text, error) later; canRead(): can it be done now (OCR on and ready)
  // translate(text, cb): asks for the translation, cb(result, error) later (or at once); result null = nothing to add (the same as the original)
  // skip(text): true when the words need no translation (already in the target language, the translation is off)
  // show({ kind, serial, rect, capture, pw, ph, text, busy }) / hide(); front(): is the game in front; now(): seconds
  constructor({ read = null, canRead = () => false, translate, skip = () => false, show, hide, front = () => true, now = () => performance.now() / 1000, cacheMax = 200, aliveS = ALIVE_S }) {
    Object.assign(this, { read, canRead, translate, skip, show, hide, front, now, cacheMax, aliveS });
    this.cache = new Map();          // key -> the translation (a string) or null (nothing to add); the newest last
    this.inflight = new Set();       // keys that are being translated
    this.cur = null;                 // the tooltip that is up now: { kind, serial, leader, rect, pw, ph, text, key, alive, result, closed, visible }
  }

  onLine(line) {
    const ch = String(line.channel ?? '');
    if (ch === '@TS') return this.onShow(line);
    const serial = Number(String(line.sender ?? '').trim() || String(line.text ?? '').trim());
    if (!this.cur || serial !== this.cur.serial) return;
    if (ch === '@TK') { this.cur.alive = this.now(); this.tick(); } else if (ch === '@TH') this.finish('hide');
  }

  onShow(line) {
    const p = parseShow(line);
    if (!p) return;
    if (this.cur) this.finish('replaced');
    this.cur = { ...p, key: null, alive: this.now(), result: undefined, closed: null, visible: false };
    if (p.capture) {                                                                                  // (the words are read from the picture of their place first)
      if (!this.read || !this.canRead()) { this.cur.closed = 'skip'; return; }                        // (OCR is off or cannot read: nothing is shown)
      this.draw();                                                                                    // "translating..." at once
      this.read(p, (text, err) => this.gotWords(p.serial, text, err));
      return;
    }
    this.translateWords();
  }

  // the words that were read from the picture
  gotWords(serial, text, err) {
    const c = this.cur;
    if (!c || c.serial !== serial || c.closed === 'hide' || c.closed === 'timeout') return;           // (an answer for a tooltip that is gone)
    const words = String(text ?? '').trim();
    if (err || !words) { this.finish('error'); return; }
    c.text = words;
    this.translateWords();
  }

  // c.text is known: shown with its translation from the memory, or asked for
  translateWords() {
    const c = this.cur;
    if (!c) return;
    if (!c.text || c.text.length < 1 || this.skip(c.text)) { this.finish('skip'); return; }           // (nothing to translate: nothing is shown)
    const key = `${c.kind}\u0001${c.leader}\u0001${hashOf(c.text)}`;
    c.key = key;
    if (this.cache.has(key)) {
      const v = this.cache.get(key); this.cache.delete(key); this.cache.set(key, v);                  // (used again: the newest)
      c.result = v;
      if (v === null) { this.finish('skip'); return; }
      this.draw();
      return;
    }
    this.draw();                                                                                      // "translating..." at once (when it is not up yet)
    if (this.inflight.has(key)) return;                                                               // (the answer of the one that is on its way comes to this one too: see answer())
    this.inflight.add(key);
    this.translate(c.text, (result, err) => this.answer(key, result, err));
  }

  answer(key, result, err) {
    this.inflight.delete(key);
    if (err) { if (this.cur && this.cur.key === key) this.finish('error'); return; }
    const v = result == null || result === '' ? null : String(result);
    this.cache.set(key, v);
    while (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value);
    const c = this.cur;
    if (!c || c.key !== key || c.closed === 'hide' || c.closed === 'timeout') return;                 // (a later tooltip is up, or this one is closed: only kept for the next time)
    if (v === null) { this.finish('skip'); return; }
    c.result = v;
    this.draw();
  }

  draw() {
    const c = this.cur;
    if (!c) return;
    if (!this.front()) { if (c.closed !== 'skip') c.closed = 'focus'; return; }        // (the game is not in front: it comes up when it is, see tick)
    c.visible = true; c.closed = null;
    this.show({ kind: c.kind, serial: c.serial, rect: c.rect, capture: c.capture, pw: c.pw, ph: c.ph, text: c.result ?? null, busy: c.result === undefined });
  }

  // closed for good (until a new "@TS"): why = 'hide' | 'timeout' | 'skip' | 'error' | 'replaced'
  finish(why) {
    const c = this.cur;
    if (!c) return;
    if (c.visible) { c.visible = false; this.hide(); }
    c.closed = why;
    if (why !== 'skip') this.cur = null;
  }

  // every quarter of a second: the tooltip that is not told to be alive any more is closed; one that the game being away closed comes back
  tick() {
    const c = this.cur;
    if (!c) return;
    if (this.now() - c.alive > this.aliveS) { this.finish('timeout'); return; }
    if (c.closed === 'skip') return;
    if (!this.front()) { if (c.visible) { c.visible = false; c.closed = 'focus'; this.hide(); } return; }
    if (c.closed === 'focus' && c.result !== null) this.draw();
  }
}
