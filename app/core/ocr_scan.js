// OCR assist, the reading of a restricted chat with the help of the addon (docs/HANDOFF.md 4-0g, 4-0h). The addon gives the state of the chat window (a line "@CS") and hangs a bar beside the
// first row of every message (red = restricted). Two ways to tell which messages on the screen are the restricted ones:
//  - with numbers (the addon of 4-0h: "@CS" has the count t and the session, and every restricted message of the window comes as a line "@RT" with its number t): the bars are counted from the
//    bottom, a bar has the number base - (its place from the bottom), and the base is the one for which every "@RT" line in the window falls on a red bar. That gives each red bar its number
//    (also when the picture is ahead of the lines), tells a bar that shows the colour of the message before it (a line has no red bar, or a red bar has no line) and counts exactly how many
//    restricted messages went up out of the window unread.
//  - with the ledger of the messages the addon gave (an older addon): the end of the ledger is matched with the bars (ocr_ledger.js matchTail).
// This file has no screen and no model: it takes the pictures it is given, finds the restricted messages, tells what is to be read (jobs), takes the readings and tells what may be shown.
import { parseState } from './ocr_state.js';
import { findBars } from './ocr_bars.js';
import { Ledger, matchTail } from './ocr_ledger.js';
import { normalize, alike, signatureOf, same, distance } from './ocr_auto.js';
import { sub } from './image.js';

const AGREE = 0.9;              // two readings of a message are the same text when they are this much alike

// How many messages came at the bottom since the scan before: the signatures of the pictures of the bars (from the bottom, null = a bar cut at the edge) of the scan before `prev` and of this one `cur`. The
// messages go up by the ones that came, so the bar at place j of the scan before is the bar at place j + k now (the window is full: the top ones went up out of it). null when no k fits (covered, scrolled ...).
export function detectShift(prev, cur, maxK = 6) {
  for (let k = 0; k <= maxK; k++) {
    const overlap = Math.min(prev.length, cur.length - k);
    if (overlap < 1) break;
    let known = 0, bad = 0;
    for (let j = 0; j < overlap; j++) { const a = prev[j], b = cur[j + k]; if (!a || !b) continue; known++; if (!same(a, b)) bad++; }
    if (known >= Math.min(2, overlap) && bad === 0) return k;
  }
  return null;
}

export const sameReading = (a, b) => { const x = normalize(a), y = normalize(b); return x.length > 0 && y.length > 0 && (x === y || alike(x, y) >= AGREE); };

export class BarScan {
  // A message is read when its picture is the same in two pictures of the window (settle seconds apart at least: the bars of a message that has just come may still show the colour of the
  // message that was there before, or the rows may not have found their place yet); it is read once (readsNeeded 1) or until two readings agree (readsNeeded 2, then confirmGap seconds
  // between the readings, maxReads at most). maxSettle: seconds after which a message that never gets still is read anyway. missedAfter: seconds a message has to be missing from the pictures
  // before it is told as missed. releaseWait: seconds to wait for an earlier message before a later one is shown.
  constructor({ confirmGap = 0.25, settle = 0.2, maxSettle = 2, missedAfter = 0.3, readsNeeded = 1, maxReads = 3, releaseWait = 3, giveUp = 12, periodGap = 30, maxRt = 100, aheadGrace = 1.5, pendingGrace = 1.5, pendingMax = 4, firstSight = true, contFresh = 3 } = {}) {
    Object.assign(this, { confirmGap, settle, maxSettle, missedAfter, readsNeeded, maxReads, releaseWait, giveUp, periodGap, maxRt, aheadGrace, pendingGrace, pendingMax, firstSight, contFresh });
    this.cont = null;                   // the scan before: { sigs (of the bars, from the bottom), base, at }: the numbers go on from it when the pictures of the bars show how many messages came
    this.pendSeen = new Map();          // number -> when a red bar with that number was first seen without its line (for the log of how late the lines come)
    this.ledger = new Ledger();
    this.rt = [];                       // the "@RT" lines, the oldest first: { seq: the number t, id, kind: 'R', channel: '@RT', text: '[restricted]', t: when it came } (at most maxRt)
    this.session = null;                // the session of the addon (it changes every time the addon is loaded: the numbers t start again)
    this.lastRtAt = null;               // when the last "@RT" line came (null: none since a restriction ended): a line after a pause of periodGap seconds begins a new reading
    this.state = null; this.stateAt = -1e9;
    this.records = new Map();           // entry seq -> { entry, reads: [text], inflight, fails, lastReadAt, state: 'open' | 'done' | 'failed' | 'missed', result, best, released }
    this.sessionSeq = 0;                // entries up to this are before the reading began
    this.releasePtr = 0;                // entries up to this are dealt with (shown, or given up)
    this.stats = { scans: 0, jobs: 0, reads: 0, shown: 0, missed: 0, failed: 0, mismatch: 0, sessions: 0 };
  }

  // the numbers are used when the addon tells its count in the state line (an older addon does not)
  useT() { return !!this.state && this.state.t !== undefined; }
  entries() { return this.useT() ? this.rt : this.ledger.list; }          // (the restricted messages to be read: entries with seq = the number t, or the entries of the ledger)
  // the numbers start again (the addon was loaded again): nothing of the old numbers is kept
  newSession() { this.rt = []; this.records.clear(); this.sessionSeq = 0; this.releasePtr = 0; this.lastRtAt = null; this.cont = null; this.pendSeen.clear(); this.stats.sessions++; }

  // a line of the pipeline: a message for the ledger or the state of the chat window
  onLine(line, now) {
    const ch = String(line.channel ?? '');
    if (ch === '@CS') {
      const st = parseState(line.text);
      if (st) {
        // The session of the addon first: it changes every time the addon is loaded, and then its numbers (n of the state lines, t of the messages) start again from the beginning, so they
        // cannot be compared with the old ones. (A state of an older addon, which has no session, is replaced by the first one that has.)
        const another = st.session !== undefined && (this.session !== null ? st.session !== this.session : !!(this.state && this.state.session === undefined));
        if (another) this.newSession();
        // in one session the newest line is the truth: a line with a lower n than the last one is an old one (that came late), unless it is far lower (the numbers began again)
        if (another || !this.state || st.n >= this.state.n || st.n < this.state.n - 50) {
          if (st.session !== undefined) this.session = st.session;
          this.state = st; this.stateAt = now;
        }
      }
      return null;
    }
    if (ch === '@RS') { this.lastRtAt = null; return null; }               // (the restriction is over: the next restricted message begins a new reading)
    if (ch === '@RT') {
      const t = Number(String(line.text ?? '').trim());
      if (!Number.isFinite(t) || t < 0) return null;
      const last = this.rt.length ? this.rt[this.rt.length - 1].seq : -1;
      if (t <= last) { if (t < last - 50) this.newSession(); else return null; }       // (a number that is not new: the same line again; far below: the numbers started again)
      if (this.lastRtAt === null || now - this.lastRtAt > this.periodGap) this.begin(t - 1);        // (the first restricted message of a restriction is read, not the ones before)
      this.lastRtAt = now;
      const e = { seq: t, id: line.id, kind: 'R', channel: '@RT', text: '[restricted]', t: now };
      this.rt.push(e);
      if (this.rt.length > this.maxRt) this.rt.shift();
      return e;
    }
    return this.ledger.add(line, now);                                   // (the entry, or null for a line that is no message of the chat window)
  }
  // the older way (comparing pictures) has read the restricted messages whose lines came up to `time` (a line comes a moment after the message is drawn): the way with the numbers does not read them again
  handledUntil(time) {
    if (!this.useT()) return;
    let seq = this.sessionSeq;
    for (const e of this.rt) if (e.t <= time && e.seq > seq) seq = e.seq;
    if (seq > this.sessionSeq) { this.sessionSeq = seq; this.releasePtr = Math.max(this.releasePtr, seq); }
  }
  fresh(now, maxAge = 6) { return !!this.state && now - this.stateAt <= maxAge; }
  begin(seq = this.useT() ? (this.rt.length ? this.rt[this.rt.length - 1].seq : 0) : this.ledger.n) { this.sessionSeq = seq; this.releasePtr = seq; this.records.clear(); }          // a reading begins: the messages up to `seq` are not read (the first restricted message is read)

  // the restricted entries after the beginning that are not dealt with
  pending() {
    let n = 0;
    for (const e of this.entries()) if (e.seq > this.releasePtr && e.seq > this.sessionSeq && e.kind === 'R') { const r = this.records.get(e.seq); if (!r || r.state === 'open') n++; }
    return n;
  }

  // pic: the picture of `region` (core/ocr_state.js regionOf). -> { status, jobs: [{ seq, pic, geo: { w, rows, lineH } }], missed, marks, paired }
  scan(pic, region, now) {
    this.stats.scans++;
    const st = this.state, out = { status: 'ok', jobs: [], missed: 0, marks: 0, paired: 0, notes: [], lags: [] };      // notes: what changed in the picture of a message since the last time (for the log)
    if (!st || !region) { out.status = 'no state'; return out; }
    if (st.scroll !== 0) { out.status = 'scrolled'; return out; }
    if (this.useT()) return this.scanT(pic, region, now, out);
    const chat = region.chat;
    const strip = { x: region.strip.x, y: Math.max(0, chat.top), w: region.strip.w, h: Math.min(pic.height, chat.top + chat.height) - Math.max(0, chat.top) };
    const bars = findBars(pic, strip, region.barW, region.barH).filter(b => !b.cutTop && !b.cutBottom);
    out.marks = bars.length;
    const m = matchTail(bars, this.ledger.list);
    if (!m.ok) { out.status = 'mismatch'; this.stats.mismatch++; out.debug = { screen: bars.map(b => b.kind).join(''), ledger: this.ledger.list.slice(-14).map(e => e.kind).join('') }; this.giveUpOld(now, out); return out; }
    out.paired = m.pairs.length;
    for (const pr of m.pairs) {
      if (pr.entry.kind !== 'R' || pr.entry.seq <= this.sessionSeq) continue;
      this.consider(pic, region, bars, pr.si, pr.entry, now, out);
    }
    // restricted messages that were never on a picture and are older than the oldest message that is: they went up out of the window before they could be read (told when it has
    // been so in the pictures for a moment: a picture in which a bar has the colour of the message that was there before can pair a message wrongly for a frame)
    const oldest = m.pairs.length ? m.pairs[0].entry.seq : Infinity;
    for (const e of this.ledger.list) {
      if (e.kind !== 'R' || e.seq <= this.sessionSeq || e.seq >= oldest) continue;
      const rec = this.record(e);
      if (rec.state !== 'open' || rec.reads.length > 0 || rec.inflight) continue;
      if (rec.missingAt === null || rec.missingAt === undefined) { rec.missingAt = now; continue; }
      if (now - rec.missingAt >= this.missedAfter) { rec.state = 'missed'; out.missed++; this.stats.missed++; }
    }
    out.debug = { screen: bars.map(b => b.kind).join(''), ledger: this.ledger.list.slice(-14).map(e => e.kind).join(''), paired: m.pairs.map(p => p.entry.seq + '@' + p.si).join(' '), ahead: m.ahead, behind: m.behind, skipped: m.skipped };
    this.giveUpOld(now, out);
    return out;
  }

  // the picture of the rows of the message whose bar is number i (from the top) of `bars`: { crop, rows, w, sig }. The rows come from the distance to the next bar.
  barInfo(pic, region, bars, i, cache) {
    if (cache && cache.has(i)) return cache.get(i);
    const chat = region.chat;
    const P = region.pitch, S = Math.max(0, region.pitch - region.fontH), chatBottom = chat.top + chat.height;
    const rowTop = k => Math.max(0, bars[k].top - 1);
    const top = rowTop(i), next = bars[i + 1] ? rowTop(i + 1) : chatBottom + S;
    const rows = Math.max(1, Math.round((next - top) / P));
    const bottom = Math.min(chatBottom, top + rows * P - S - 1);                 // (the rows of the message: `rows` rows of the pitch, without the space after the last)
    const x = Math.max(0, chat.left), w = Math.min(pic.width - x, chat.width), h = Math.max(1, bottom - top + 1);
    const crop = sub(pic, x, top, w, h);
    const info = { crop, rows, w, sig: signatureOf(crop, 0, crop.height - 1) };
    if (cache) cache.set(i, info);
    return info;
  }

  // the bar number i (from the top) of `bars` is the first row of the restricted message `entry`: take the picture of its rows, and make a job when it is time to read it. trust: the number of the message
  // comes from the pictures of the bars of the scan before (the messages that came are known), so it is read at the first sight; else the picture has to be the same in two pictures first
  consider(pic, region, bars, i, entry, now, out, trust = false, cache = null) {
    const rec = this.record(entry);
    rec.missingAt = null;                                                // (it is on the picture: not missing)
    if (rec.state !== 'open' || rec.inflight) return;
    const { crop, rows, w, sig } = this.barInfo(pic, region, bars, i, cache);
    if (rec.firstSeen === undefined) rec.firstSeen = now;
    let still = false;                                                   // the same picture and the same number of rows as in the picture before (at least `settle` seconds ago)
    if (rec.prevSig && rec.prevRows === rows && same(rec.prevSig, sig)) still = now - rec.prevAt >= this.settle;
    else {
      if (rec.prevSig && rec.reads.length === 0 && (rec.changes = (rec.changes || 0) + 1) <= 3) {      // (what made the picture "not the same": the rows from the bars, or the strokes)
        out.notes.push(rec.prevRows !== rows ? { seq: entry.seq, kind: 'rows', from: rec.prevRows, to: rows } : { seq: entry.seq, kind: 'sig', dist: distance(rec.prevSig, sig) });
      }
      rec.prevSig = sig; rec.prevRows = rows; rec.prevAt = now;
    }
    const sight = trust && this.firstSight;
    const first = rec.reads.length === 0 && (sight || still || now - rec.firstSeen >= this.maxSettle);
    const again = this.readsNeeded > 1 && rec.reads.length > 0 && rec.reads.length < this.maxReads && now - rec.lastReadAt >= this.confirmGap;
    if (!first && !again) return;
    rec.inflight = true;
    out.jobs.push({ seq: entry.seq, id: entry.id, pic: crop, geo: { w, rows, lineH: region.fontH }, why: first ? (sight ? 'sight' : still ? 'still' : 'max') : 'again', firstSeen: rec.firstSeen, rtAt: entry.t });      // (why / firstSeen / rtAt: for the log of the delay)
    this.stats.jobs++;
  }

  // the way with the numbers. The bars are counted from the bottom (place j = 0 is the newest message, scroll 0): the bar at place j is the message with the number base - j. The base is the
  // number for which every "@RT" line that falls into the window (the numbers base - n + 1 .. base) falls on a red bar. A red bar that has no line is a line that has not come yet (its number is
  // above the newest line) or one that was lost; a line that falls on a green bar (or on no bar) means that the picture is not what the addon has told (a bar still shows the colour of the message
  // that was there before, a bar is covered ...): nothing is read from such a picture. -> out
  scanT(pic, region, now, out) {
    const chat = region.chat;
    const strip = { x: region.strip.x, y: Math.max(0, chat.top), w: region.strip.w, h: Math.min(pic.height, chat.top + chat.height) - Math.max(0, chat.top) };
    const bars = findBars(pic, strip, region.barW, region.barH);        // from the top to the bottom, the cut ones too (a bar at the top edge is a message; it is just not read)
    const n = bars.length;
    out.marks = n;
    const at = j => bars[n - 1 - j];                                     // the bar at place j from the bottom
    const red = [];
    for (let j = 0; j < n; j++) if (at(j).kind === 'R') red.push(j);
    const lines = this.rt, byT = new Map(lines.map(e => [e.seq, e]));
    const newest = lines.length ? lines[lines.length - 1].seq : -Infinity;
    const redSet = new Set(red);
    // the continuity: the pictures of the bars now and in the scan before tell how many messages came since (they went up by them): the number of the bottom message is then the one before plus that. A world that
    // has the bar of a message that has just come wait for its line is told from one that gives the newest line to that bar by this alone.
    const cache = new Map();
    const sigs = [];
    for (let j = 0; j < n; j++) { const b = at(j); sigs[j] = b.cutTop || b.cutBottom ? null : this.barInfo(pic, region, bars, n - 1 - j, cache).sig; }
    let expected = null;
    if (this.cont && now - this.cont.at < this.contFresh) { const k = detectShift(this.cont.sigs, sigs); if (k !== null) expected = this.cont.base + k; }
    let best = null, chosen = null;
    if (red.length && lines.length) {
      const first = lines[0].seq, tCs = this.state.t;
      const cand = new Set();
      for (const x of lines.slice(-16)) for (const j of red) cand.add(x.seq + j);
      if (expected !== null) cand.add(expected);
      for (const base of cand) {
        if (typeof tCs === 'number' && base < tCs) continue;          // (the state line was sent before this picture: the newest message of the picture is at least as new as the count in it)
        const lo = base - n + 1;
        let matched = 0, ok = true;
        // a line numbered above the base is about a message that the picture does not show yet: allowed only when the line has just come (the picture is a moment behind), not for a line that is old
        for (const x of lines) {
          if (x.seq > base) { if (now - x.t > this.aheadGrace) { ok = false; break; } continue; }
          if (x.seq < lo) continue;
          if (!redSet.has(base - x.seq)) { ok = false; break; }
          matched++;
        }
        if (!ok || matched === 0) continue;
        // the red bars that have no line: older than the first line we have (they were there before we began: nothing is expected of them), newer than the newest line (the line is a moment behind:
        // "pending"), or between (a line that was lost)
        let lost = 0, pending = 0, before = 0;
        for (const j of red) { const t = base - j; if (!byT.has(t)) { if (t > newest) pending++; else if (t < first) before++; else lost++; } }
        // red bars whose lines have not come: a few, and only while the newest line is fresh (the lines of messages that have just come are a moment behind); else the picture is not trusted
        if (pending > 0 && base !== expected && (pending > this.pendingMax || now - lines[lines.length - 1].t > this.pendingGrace)) continue;      // (the pictures say that messages have come since the scan before: their lines are late, however long ago the newest line was)
        // the fewest red bars that wait for a line (a wait is a short thing: a world in which two bars wait for lines that never come is a wrong one), then the most lines on red bars, then the fewest lost lines,
        // then the newest base
        const better = !best || pending < best.pending || (pending === best.pending && (matched > best.matched || (matched === best.matched && (lost < best.lost || (lost === best.lost && base > best.base)))));
        const c = { base, matched, lost, pending, before };
        if (better) best = c;
        if (base === expected) chosen = c;
      }
    }
    let trust = false;
    if (chosen) { best = chosen; trust = true; }                           // (the number the pictures lead to is taken when the lines do not contradict it)
    out.debug = { screen: bars.map(b => b.kind).join(''), ledger: lines.slice(-14).map(e => e.seq).join(','), base: best ? best.base : null, red: red.join(','), trust };
    if (!best) {
      // nothing is red on the screen, or no line has come yet (the first restricted message: its line is a moment behind its bar): nothing to read yet. Red bars and lines that do not fit
      // each other (a bar still shows the colour of the message before it, a bar is covered ...) are a mismatch: nothing is read from this picture
      if (red.length && lines.length) { out.status = 'mismatch'; this.stats.mismatch++; }
      this.giveUpOld(now, out);
      return out;
    }
    const lo = best.base - n + 1;
    this.cont = { sigs, base: best.base, at: now };
    out.paired = best.matched;
    Object.assign(out.debug, { matched: best.matched, lost: best.lost, pending: best.pending, before: best.before });
    for (let j = 0; j < n; j++) {
      const b = at(j);
      if (b.kind !== 'R' || b.cutTop || b.cutBottom) continue;
      const e = byT.get(best.base - j);
      if (!e || e.seq <= this.sessionSeq) continue;                      // (no line yet: the colour is not confirmed, wait)
      this.consider(pic, region, bars, n - 1 - j, e, now, out, trust, cache);
    }
    // how late the lines come: a red bar seen before its line came -> the line came
    for (let j = 0; j < n; j++) {
      if (at(j).kind !== 'R') continue;
      const t = best.base - j, e = byT.get(t);
      if (!e) { if (t > newest && !this.pendSeen.has(t)) this.pendSeen.set(t, now); }
      else if (this.pendSeen.has(t)) { out.lags.push({ seq: t, lag: Math.max(0, e.t - this.pendSeen.get(t)) }); this.pendSeen.delete(t); }
    }
    for (const t of [...this.pendSeen.keys()]) if (t < best.base - n) this.pendSeen.delete(t);
    // restricted messages that are numbered below the window (they went up out of it) and were never read: missed, when it has been so for a moment
    for (const e of lines) {
      if (e.seq <= this.sessionSeq || e.seq >= lo) continue;
      const rec = this.record(e);
      if (rec.state !== 'open' || rec.reads.length > 0 || rec.inflight) continue;
      if (rec.missingAt === null || rec.missingAt === undefined) { rec.missingAt = now; continue; }
      if (now - rec.missingAt >= this.missedAfter) { rec.state = 'missed'; out.missed++; this.stats.missed++; }
    }
    this.giveUpOld(now, out);
    return out;
  }

  record(entry) {
    let r = this.records.get(entry.seq);
    if (!r) { r = { entry, reads: [], inflight: false, fails: 0, lastReadAt: -1e9, state: 'open', result: null, best: false, released: false }; this.records.set(entry.seq, r); }
    return r;
  }

  // a message that waited too long without a picture that fits (the window did not match the ledger, or it was covered all the time) is given up: counted as missed
  giveUpOld(now, out) {
    for (const e of this.entries()) {
      if (e.kind !== 'R' || e.seq <= this.sessionSeq || now - e.t < this.giveUp) continue;
      const rec = this.record(e);
      if (rec.state === 'open' && !rec.inflight && rec.reads.length === 0) { rec.state = 'missed'; if (out) out.missed++; this.stats.missed++; }
    }
  }

  // the answer of the model for a job ('' = nothing could be read)
  onRead(seq, text, now) {
    const rec = this.records.get(seq);
    if (!rec || rec.state !== 'open') return;
    rec.inflight = false; rec.lastReadAt = now; this.stats.reads++;
    if (!text) { if (++rec.fails >= 3) { rec.state = 'failed'; this.stats.failed++; } return; }
    rec.reads.push(text);
    if (this.readsNeeded <= 1) { rec.state = 'done'; rec.result = text; return; }
    // two readings of the same text are enough; else more readings, up to maxReads, then the last one is shown as it is (it is the newest picture)
    for (let i = 0; i < rec.reads.length - 1; i++) if (sameReading(rec.reads[i], text)) { rec.state = 'done'; rec.result = text; return; }
    if (rec.reads.length >= this.maxReads) { rec.state = 'done'; rec.result = text; rec.best = true; }
  }
  onReadFailed(seq) { const rec = this.records.get(seq); if (rec && rec.state === 'open') { rec.inflight = false; if (++rec.fails >= 3) { rec.state = 'failed'; this.stats.failed++; } } }

  // what is settled now: { done: [{ seq, text, best }] the messages whose reading is ready (each once, whatever the others do: the place of a message in the chat is kept by the program, see Pipeline.reserveOcr),
  // lost: [seq] the messages that could not be read (the model failed, they went off the screen, or it took too long) }
  collect(now) {
    const done = [], lost = [];
    for (const e of this.entries()) {
      if (e.kind !== 'R' || e.seq <= this.sessionSeq) continue;
      let rec = this.records.get(e.seq);
      if (rec && rec.settled) continue;
      if (rec && rec.state === 'done') { rec.settled = true; done.push({ seq: e.seq, text: rec.result, best: rec.best }); this.stats.shown++; continue; }
      if (rec && (rec.state === 'failed' || rec.state === 'missed')) { rec.settled = true; lost.push(e.seq); continue; }
      if (now - e.t > this.releaseWait + this.giveUp) {
        if (!rec) { rec = { entry: e, reads: [], inflight: false, fails: 0, lastReadAt: -1e9 }; this.records.set(e.seq, rec); }
        rec.state = 'failed'; rec.settled = true; this.stats.failed++; lost.push(e.seq);
      }
    }
    // (the entries up to the first one that is not settled are dealt with)
    for (const e of this.entries()) {
      if (e.seq <= this.releasePtr || e.seq <= this.sessionSeq) continue;
      const rec = this.records.get(e.seq);
      if (e.kind === 'R' && !(rec && rec.settled)) break;
      this.releasePtr = e.seq;
    }
    return { done, lost };
  }
}
