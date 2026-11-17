// The capture loop: finds the ChatMatrix on the screen and reports the chat lines not seen before. Port of capture.py (CaptureWorker),
// written as a state machine that does not touch the system: everything it needs comes in through `io`, so tests drive it with a fake screen.
//   io.grab(x, y, w, h)  -> picture { px (BGRA), width, height }   (async; may throw)
//   io.screen()          -> [x, y, w, h] of the whole desktop (all monitors together)
//   io.gameRect()        -> [x, y, w, h] of the game window, or null
//   io.now()             -> seconds (any clock that only goes forward)
//   io.sleep(seconds)    -> promise
//   out.lines(lines)     lines not seen before         out.status({kind, text, ...})      out.pos([x, y])  where the matrix was found
// kinds of status: searching, connected, waiting (v3 line hidden), lost, error
import { log } from './log.js';
import { tr } from './i18n.js';
import * as v1 from './decoder.js';
import * as proto2 from './proto2.js';
import * as proto3 from './proto3.js';
import * as scaled from './scaled.js';

const SEEN_MAX = 2000;
const V2_TALLEST = Math.ceil((proto2.RAMP_START + 2 + proto2.N_END + Math.ceil(8 * (proto2.HEADER_BYTES + 320) / (3 * proto2.bitsPerSymbol(2)))) / Math.min(...proto2.COL_CHOICES));  // rows_for(2, cols=16)

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export class CaptureWorker {
  constructor(io, out, getCfg) {
    this.io = io; this.out = out; this.getCfg = getCfg;
    this.stopped = false; this.wantResearch = false;
    this.fullN = 0;
    this.seen = new Set(); this.seenOrder = [];         // keys of lines already passed on: id + channel + sender + text
    this.lastSeq = null; this.seqTime = io.now();
    this.nSeq = 0; this.nNew = 0; this.nGap = 0; this.gapLog = -Infinity;
    this.pos = null; this.mode = 'v1'; this.rows = 0; this.cols = 32; this.geom = null;
    this.fails = 0; this.lastOk = io.now(); this.lastWarn = -Infinity; this.lastSearch = -Infinity; this.lastFull = -Infinity; this.lastV3 = -Infinity;   // (the clock may start near 0)
    this.v3Wait = false; this.remembered = null;
    this.perfN = 0; this.perfT = 0; this.perfLog = io.now();
    this.connected = false;
    try { const lp = getCfg().last_pos; if (lp) this.remembered = [parseInt(lp[0], 10), parseInt(lp[1], 10)]; } catch { /* none */ }
    if (this.remembered && this.remembered.some(Number.isNaN)) this.remembered = null;
  }

  stop() { this.stopped = true; }
  research() { this.wantResearch = true; }                // forget the matrix position and search again

  async run() {
    while (!this.stopped) {
      let wait;
      try { wait = await this.step(); }
      catch (e) { log.error('캡처 오류: ' + (e?.stack || e)); this.out.status({ kind: 'error', text: tr('캡처 오류: {e}', { e: String(e?.message || e) }) }); wait = 1; }
      await this.io.sleep(wait);
    }
  }

  // ------------------------------------------------------------------ looking
  // Screen grabs of a running game are not free, so the whole-window search is done only now and then ("full_scan_sec"); in between only
  // the last known position is read.
  // `full`: a whole search (not the edge bands). The game window when it is known (the matrix can only be inside it); every fourth whole
  // search the whole desktop instead, so that a wrong window rectangle can never blind it for good. (2.0 counted the band searches too,
  // which made the desktop turn come up only by chance.)
  regions(full = false) {
    const [sx, sy, sw, sh] = this.io.screen();
    const rect = this.io.gameRect();
    if (rect && rect[2] >= 200 && rect[3] >= 100) {
      if (!full) return [rect];
      this.fullN++;
      if (this.fullN % 4) return [rect];
    }
    return [[sx, sy, sw, sh]];
  }

  clip([x, y, w, h]) {                                   // cut to the desktop (a grab that reaches past the screen is not needed and may fail)
    const [sx, sy, sw, sh] = this.io.screen();
    const x2 = Math.max(sx, x), y2 = Math.max(sy, y);
    return [x2, y2, Math.max(1, Math.min(x + w, sx + sw) - x2), Math.max(1, Math.min(y + h, sy + sh) - y2)];
  }

  async grab(area) { const [x, y, w, h] = this.clip(area); return this.io.grab(x, y, w, h); }

  async search() {
    for (const [ox, oy, w, h] of this.regions(true)) {
      let img;
      try { img = await this.grab([ox, oy, w, h]); } catch { continue; }
      let p = v1.findMatrixEx(img);                       // protocol v1 first: exact colours, cheap
      if (p) return { x: ox + p.x, y: oy + p.y, mode: 'v1', rows: 0, geom: null, cols: p.cols };
      let hit = proto2.findAndDecode(img);                // then v2 (colour-change tolerant)
      if (hit) return { x: ox + hit.x, y: oy + hit.y, mode: 'v2', rows: hit.frame.rows, geom: null, cols: hit.frame.cols };
      hit = proto3.findAndDecode(img);                    // then v3 (the thin line along a screen edge)
      if (hit) return { x: ox + hit.x, y: oy + hit.y, mode: 'v3', rows: 0, geom: { vertical: hit.vertical, extent: hit.extent }, cols: hit.frame.cells };
      const s = scaled.find(img);                         // v2 with cells of another size / mixed colours
      if (s) {
        const gx = ox + s.x, gy = oy + s.y;
        const left = Math.floor(gx) - 3, top = Math.floor(gy) - 3;
        const geom = { pitch: s.pitch, ox: gx - left, oy: gy - top, rows: s.frame.rows, cols: s.frame.cols,
                       w: Math.ceil(s.frame.cols * s.pitch + gx - left + 4), h: Math.ceil(s.frame.rows * s.pitch + gy - top + 4) };
        return { x: left, y: top, mode: 'v2s', rows: s.frame.rows, geom, cols: s.frame.cols };
      }
    }
    return null;
  }

  // Only the thin bands along the four edges of the game window (or the desktop): cheap, so it can be done every few seconds while nothing
  // is found (a line that hides when there is nothing to say shows up only now and then).
  async searchV3() {
    for (const [ox, oy, w, h] of this.regions()) {
      const b = proto3.BAND, bh = Math.min(b, h >> 1), bw = Math.min(b, w >> 1);
      const bands = [[false, [ox, oy, w, bh]], [false, [ox, oy + h - bh, w, bh]], [true, [ox, oy, bw, h]], [true, [ox + w - bw, oy, bw, h]]];
      for (const [vertical, band] of bands) {
        let img;
        try { img = await this.grab(band); } catch { continue; }
        const hit = proto3.findInBand(img, vertical);
        if (hit) return { x: band[0] + hit.x, y: band[1] + hit.y, mode: 'v3', rows: 0, geom: { vertical, extent: hit.extent }, cols: hit.frame.cells };
      }
    }
    return null;
  }

  // Is the matrix still (or again) where it was found last time? One small grab: cheap enough to do every second while it is missing.
  async probeLast([x, y]) {
    try {
      let img = await this.grab([x, y, v1.sizeFor(32)[0], v1.sizeFor(16)[1]]);        // the tallest v1 shape
      for (const cols of v1.COL_CHOICES) if (v1.decodeRegion(img, cols).frame) return { mode: 'v1', rows: 0, cols, geom: null };
      img = await this.grab([x, y, proto2.COLS * proto2.CELL, V2_TALLEST * proto2.CELL]);
      const f2 = proto2.decode(img, 0, 0).frame;
      if (f2) return { mode: 'v2', rows: f2.rows, cols: f2.cols, geom: null };
      for (const vertical of [false, true]) {                                           // v3: a thin line, along x or along y
        const n = proto3.GRAB_MAX;
        img = await this.grab([x, y, vertical ? proto3.CELL : n, vertical ? n : proto3.CELL]);
        const extent = vertical ? img.height : img.width;
        const f3 = proto3.decode(proto3.oriented(img, 0, 0, vertical, extent), vertical).frame;
        if (f3) return { mode: 'v3', rows: 0, cols: f3.cells, geom: { vertical, extent } };
      }
    } catch { /* not there */ }
    return null;
  }

  adopt(hit, how = '') {
    this.pos = [hit.x, hit.y]; this.mode = hit.mode; this.rows = hit.rows; this.geom = hit.geom; this.cols = hit.cols;
    this.fails = 0; this.lastOk = this.io.now(); this.v3Wait = false;
    let shape;
    if (this.mode === 'v3') shape = ' ' + tr('(한 줄 {cols}칸, {dir})', { cols: this.cols, dir: this.geom.vertical ? tr('세로') : tr('가로') });
    else shape = (this.mode !== 'v1' ? ' ' + tr('({rows}줄)', { rows: this.rows }) : '') + (this.cols !== 32 ? ' ' + tr('폭 {px}px', { px: this.cols * 4 }) : '') + (this.geom ? ' ' + tr('셀 {px}px', { px: this.geom.pitch.toFixed(2) }) : '');
    log.info(`매트릭스 발견 @ ${this.pos[0]},${this.pos[1]} | 프로토콜 ${this.mode}${shape}${how}`);
    this.connected = true;
    this.out.status({ kind: 'connected', text: tr('연결됨 @ {x},{y}', { x: this.pos[0], y: this.pos[1] }), found: true });
    if (this.mode !== 'v2s' && (!this.remembered || this.remembered[0] !== this.pos[0] || this.remembered[1] !== this.pos[1])) {
      this.remembered = [...this.pos];                    // the next start looks here first
      this.out.pos([...this.pos]);
    }
  }

  fullEvery(cfg) { return Math.max(5, Math.min(600, num(cfg.full_scan_sec, 30))); }

  // ------------------------------------------------------------------ one round of the loop -> seconds to wait before the next
  async step() {
    const cfg = this.getCfg();
    const period = 1 / Math.max(1, Math.trunc(num(cfg.poll_hz, 30)));
    const t0 = this.io.now();
    const rest = () => Math.max(0, period - (this.io.now() - t0));

    if (this.wantResearch) {
      this.wantResearch = false; this.pos = null; this.lastSeq = null; this.lastFull = -Infinity; this.lastSearch = -Infinity;
    }

    if (!this.pos) {
      const now = this.io.now();
      if (now - this.lastSearch >= 1) {
        this.lastSearch = now;
        const full = now - this.lastFull >= this.fullEvery(cfg);
        if (full) this.lastFull = now;
        this.out.status({ kind: 'searching', text: tr('매트릭스 찾는 중... (게임을 창 모드로 띄우고 /cm 위치 확인)') });
        let hit = null, how = '';
        if (this.remembered) {                            // every second: is it back where it was?
          const pm = await this.probeLast(this.remembered);
          if (pm) { hit = { x: this.remembered[0], y: this.remembered[1], ...pm }; how = ' ' + tr('(마지막 위치)'); }
        }
        if (!hit && full) hit = await this.search();      // (between the whole-window searches: only the last position)
        else if (!hit && this.io.now() - this.lastV3 >= 1) { this.lastV3 = this.io.now(); hit = await this.searchV3(); }
        if (hit) this.adopt(hit, how);
      }
      if (!this.pos) return 0.2;
    }

    let area;
    if (this.mode === 'v2s') area = [this.pos[0], this.pos[1], this.geom.w, this.geom.h];
    else if (this.mode === 'v3') area = [this.pos[0], this.pos[1], this.geom.vertical ? proto3.CELL : this.geom.extent, this.geom.vertical ? this.geom.extent : proto3.CELL];
    else area = [this.pos[0], this.pos[1], this.cols * 4, this.mode === 'v1' ? v1.sizeFor(this.cols)[1] : this.rows * proto2.CELL];

    let frame = null, why = '';
    try {
      const tg = this.io.now();
      const img = await this.grab(area);
      this.perfN++; this.perfT += this.io.now() - tg;
      let r;
      if (this.mode === 'v1') r = v1.decodeRegion(img, this.cols);
      else if (this.mode === 'v2s') r = scaled.decode(img, this.geom.ox, this.geom.oy, this.geom.pitch, this.geom.rows, this.geom.cols);
      else if (this.mode === 'v3') r = proto3.decode(proto3.oriented(img, 0, 0, this.geom.vertical, this.geom.extent), this.geom.vertical);
      else r = proto2.decode(img, 0, 0, this.cols);
      frame = r.frame; why = r.why;
      if (!frame && why === 'ramp merged' && this.io.now() - this.lastWarn >= 30) {
        this.lastWarn = this.io.now();
        log.warn('v2 매트릭스: 단계가 화면에서 서로 구분되지 않습니다 - 애드온에서 \'색 단계\'를 더 낮추세요');
      }
    } catch (e) { frame = null; why = 'grab error ' + (e?.message || e); }

    const now = this.io.now();
    if (!frame && this.mode === 'v3') {
      // the line is hidden while the addon has nothing to say: that is not a lost matrix. Now and then (the long full-scan period)
      // everything is searched again, in case the addon was set to another place / protocol.
      if (!this.v3Wait) {
        this.v3Wait = true;
        this.out.status({ kind: 'waiting', text: tr('연결됨 @ {x},{y}', { x: this.pos[0], y: this.pos[1] }) + ' | v3 ' + tr('(대기 중: 새 대화가 오면 나타남)') });
      }
      const every = this.fullEvery(cfg);
      if (now - this.lastOk >= every && now - this.lastFull >= every) {
        this.lastFull = now;
        const hit = await this.search();
        if (hit && (hit.x !== this.pos[0] || hit.y !== this.pos[1] || hit.mode !== this.mode)) {
          this.adopt(hit);
          log.info(`매트릭스 위치/프로토콜이 바뀜 @ ${this.pos[0]},${this.pos[1]} | 프로토콜 ${this.mode}`);
        }
      }
    } else if (!frame) {
      this.fails++;
      // a few bad frames are normal (redraw while reading); many in a row = lost. Judged by time as well as by the count: grabbing a game
      // that draws slowly (loading, character selection) can take 100 ms or more per frame.
      if (this.fails >= 10 && now - this.lastOk >= 2.5) {
        log.info(`매트릭스를 잃어버림: 연속 ${this.fails}프레임 실패, 마지막 성공 ${(now - this.lastOk).toFixed(1)}초 전 (${why})`);
        this.connected = false;
        this.out.status({ kind: 'lost', text: tr('매트릭스를 잃어버림 ({reason}) - 다시 찾는 중', { reason: why }) });
        this.pos = null; this.fails = 0;
      }
    } else {
      this.fails = 0; this.lastOk = now; this.v3Wait = false;
      if (frame.seq !== this.lastSeq) this.newFrame(frame, now);
    }

    if (this.perfN && now - this.perfLog >= 60) {          // one line a minute: how expensive is the grabbing?
      log.info(`캡처 | 최근 ${this.perfN}회 평균 ${(this.perfT / this.perfN * 1000).toFixed(2)} ms (최대 초당 ${Math.trunc(1 / period)}회) | 순번 변경 ${this.nSeq}회, 놓친 그림 ${this.nGap}장, 새 줄 ${this.nNew}개 전달 (순번 ${this.lastSeq})`);
      this.perfN = 0; this.perfT = 0; this.perfLog = now; this.nSeq = this.nNew = this.nGap = 0;
    }
    return rest();
  }

  newFrame(frame, now) {
    if (this.lastSeq !== null && frame.seq < this.lastSeq) { this.seen.clear(); this.seenOrder = []; }   // the addon was reloaded: ids restart
    if (this.lastSeq !== null && frame.seq > this.lastSeq + 1) {
      const gap = frame.seq - this.lastSeq - 1;           // matrix pictures that were drawn but never seen
      this.nGap += gap;
      if (now - this.seqTime <= 5 && now - this.gapLog >= 1) { this.gapLog = now; log.info(`매트릭스 그림 ${gap}장을 놓침 (순번 ${this.lastSeq} -> ${frame.seq}, ${(now - this.seqTime).toFixed(2)}초 사이)`); }
      if (now - this.seqTime > 5) log.info(`순번 ${this.lastSeq} -> ${frame.seq}: ${Math.round(now - this.seqTime)}초 동안 그대로이다가 ${frame.seq - this.lastSeq} 건너뜀 (게임이 화면을 느리게 그리고 있었을 수 있음)`);
    }
    this.seqTime = now; this.lastSeq = frame.seq; this.nSeq++;
    const fresh = [];
    for (const line of frame.lines) {
      const key = JSON.stringify([line.id, line.channel, line.sender, line.text]);   // the id alone repeats after an addon reload / id wrap
      if (this.seen.has(key)) continue;
      this.seen.add(key); this.seenOrder.push(key);
      if (this.seenOrder.length > SEEN_MAX) this.seen.delete(this.seenOrder.shift());
      fresh.push(line);
    }
    if (fresh.length) { this.nNew += fresh.length; this.out.lines(fresh); }
    this.out.status({ kind: 'connected', text: tr('연결됨 @ {x},{y}', { x: this.pos[0], y: this.pos[1] }) + ` | seq ${frame.seq}` + (this.mode !== 'v1' ? ` | ${this.mode === 'v3' ? 'v3' : 'v2'}·${frame.levels}` : '') });
  }
}
