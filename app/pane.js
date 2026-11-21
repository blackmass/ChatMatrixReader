// A translation window of the control center (3.2): the chat of one window (its own WindowFeed and ChatView, like a window of 3.1.1) in a box of the page of a center, with a bar above it (the
// bar is OUTSIDE the text: the place and the size of a window are those of its text). The pane asks the center for what a window does by itself (place, order, mouse): center.js.
import { ChatView, lookFrom } from './chatview.js';
import { WindowFeed } from './core/windowfeed.js';
import { MAIN } from './core/pipeline.js';
import * as winconf from './core/winconf.js';
import * as layout from './core/winlayout.js';
import { nameFor } from './winname.js';


export const BAR_H = 22;
const MIN_W = 160, MIN_H = 60;

export class Pane {
  // center: { cfg(), dpr(), origin() -> [ox, oy] in pixels, changed(pane) }
  constructor(id, center) {
    this.id = id; this.center = center; this.label = `c${id}`;
    this.seen = 0; this.firstLive = Infinity; this.replay = true;
    this.el = document.createElement('div'); this.el.className = 'pane';
    this.el.innerHTML = '<div class="pbar"><span class="ptitle"></span><span class="pspace"></span><span class="ptools"><button class="presearch" tabindex="-1" title="매트릭스 다시 찾기">⟳</button><button class="pvoice" tabindex="-1" title="음성인식 켜기" data-state="off"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path class="waves" d="M11.2 5.4a3.6 3.6 0 0 1 0 5.2M13 3.6a6.2 6.2 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button><button class="poptions" tabindex="-1" title="옵션">⚙</button><button class="pclose" tabindex="-1">✕</button></span></div><div class="pbody"><div class="pbg"></div><div class="plines" data-notr></div></div><div class="pgrip"></div>';
    this.title = this.el.querySelector('.ptitle');
    this.lines = this.el.querySelector('.plines');
    this.lines.classList.add('lines');
    this.view = new ChatView(this.lines);
    this.feed = new WindowFeed(id, () => this.center.cfg(), () => this.conf());
    document.body.append(this.el);
    this.el.style.zIndex = String(id);                                // (the first order: a window of a higher number is above)
    this.el.addEventListener('pointerdown', () => this.center.raise(this), true);         // (touched: this pane comes to the front of the center)
    this.place();
    this.drag(this.el.querySelector('.pbar'), (s, dx, dy) => { this.rect.x = s.x + dx; this.rect.y = Math.max(BAR_H, s.y + dy); }, e => !e.target.closest('button'));
    this.tools();
    this.drag(this.el.querySelector('.pgrip'), (s, dx, dy) => { this.rect.w = Math.max(MIN_W, s.w + dx); this.rect.h = Math.max(MIN_H, s.h + dy); });
    this.update();
  }
  conf() { const cfg = this.center.cfg(); return this.id === MAIN ? null : cfg.child_windows.find(c => c.id === this.id) || winconf.newConf(this.id, [...winconf.KNOWN, winconf.ETC]); }
  opt(key, dflt) { const cfg = this.center.cfg(); return this.id === MAIN ? (cfg[winconf.MAIN_KEY[key] || key] ?? dflt) : winconf.opt(this.conf(), cfg, key, dflt); }

  // the buttons of the bar (the same jobs as in a window of 3.1.1)
  tools() {
    const q = c => this.el.querySelector(c);
    q('.presearch').onclick = () => emit('research', {});
    q('.pvoice').onclick = () => emit('voice-toggle', {});
    q('.poptions').onclick = () => {
      try { localStorage.setItem('cmr-options-win', String(this.id)); } catch { /* the options open on the first window */ }
      invoke('open_options').catch(() => {});
    };
    // the main window ends the program, the others only close themselves (the hub keeps them closed: "직접 열 때만")
    q('.pclose').onclick = async () => { this.save(); if (this.id === MAIN) invoke('quit_request').catch(() => {}); else emit('win-closed', { id: this.id }); };
    q('.pbar').addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') e.preventDefault(); });
  }
  lamp(st, title) { const b = this.el.querySelector('.pvoice'); b.dataset.state = st; b.title = title; }

  // the place: the text area is where the window of 3.1.1 was (its saved geometry is the place and the size of the text area); the bar stands above it
  place() {
    const cfg = this.center.cfg(), g = layout.parseGeometry(this.id === MAIN ? cfg.geometry : (this.conf() || {}).geometry) || { w: layout.DEFAULT_SIZE[0], h: layout.DEFAULT_SIZE[1], x: null, y: null };
    const d = this.center.dpr(), [ox, oy] = this.center.origin();
    let { x, y } = g;
    if (x === null || y === null) {                                  // no place saved: next to the main window, a little lower each time (like a window of 3.1.1)
      const m = layout.parseGeometry(cfg.geometry), n = Math.max(1, cfg.child_windows.findIndex(c => c.id === this.id) + 1);
      [x, y] = layout.cascade(m && m.x !== null ? [m.x, m.y] : null, this.id === MAIN ? 0 : n);
    }
    this.rect = { x: (x - ox) / d, y: Math.max(BAR_H, (y - oy) / d), w: g.w / d, h: g.h / d };
    this.layout();
  }
  layout() {
    const r = this.rect;
    this.el.style.left = r.x + 'px'; this.el.style.top = (r.y - BAR_H) + 'px'; this.el.style.width = r.w + 'px'; this.el.style.height = (r.h + BAR_H) + 'px';
  }
  // the box (the bar included) in pixels of the page, for the center
  box() { const r = this.rect, d = this.center.dpr(); return { id: String(this.id), x: r.x * d, y: (r.y - BAR_H) * d, w: r.w * d, h: (r.h + BAR_H) * d, bar: BAR_H * d }; }
  // where the text area is on the screen now: told to the hub, which keeps it in the settings (a window of 3.1.1 did the same)
  save() {
    const r = this.rect, d = this.center.dpr(), [ox, oy] = this.center.origin();
    emit('win-geometry', { id: this.id, geometry: layout.formatGeometry(r.w * d, r.h * d, ox + r.x * d, oy + r.y * d) });
  }

  drag(target, fn, accept = () => true) {
    target.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !accept(e)) return;
      target.setPointerCapture(e.pointerId);
      const s = { ...this.rect, px: e.clientX, py: e.clientY };
      const move = m => { fn(s, m.clientX - s.px, m.clientY - s.py); this.layout(); this.center.changed(this); };
      const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); this.save(); };
      target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
    });
  }

  // the settings changed (or the first time)
  update() {
    const cfg = this.center.cfg();
    this.title.textContent = nameFor(cfg, this.id);
    this.el.style.setProperty('--bg-alpha', String(Number(this.opt('bg_opacity', 1))));
    this.view.setLook(lookFrom((k, d) => this.opt(k, d)), this.feed.model);
    this.view.apply(this.feed.applySettings(), this.feed.model);
  }

  // an event of the hub (`n`: its number; in order; a replay starts the pane again)
  take(n, ev, quiet) {
    if (n <= this.seen) return;
    this.seen = n; if (n < this.firstLive) this.firstLive = n;
    this.view.apply(this.feed.handle(ev), this.feed.model);
  }
  takeReplay(events) {
    if (!this.replay) return;
    this.replay = false;
    const fresh = this.id !== MAIN && !!this.opt('clear_on_open', false), from = this.firstLive;
    this.view.apply(this.feed.clear(), this.feed.model); this.seen = 0;
    for (const x of events) if (!fresh || x.seq >= from) this.take(x.seq, x.event, true);
  }
  destroy() { this.view.stop(); this.el.remove(); }
}
