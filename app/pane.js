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
    this.el.innerHTML = '<div class="pbar"><span class="ptitle"></span></div><div class="pbody"><div class="pbg"></div><div class="plines" data-notr></div></div><div class="pgrip"></div>';
    this.title = this.el.querySelector('.ptitle');
    this.lines = this.el.querySelector('.plines');
    this.lines.classList.add('lines');
    this.view = new ChatView(this.lines);
    this.feed = new WindowFeed(id, () => this.center.cfg(), () => this.conf());
    document.body.append(this.el);
    this.place();
    this.drag(this.el.querySelector('.pbar'), (s, dx, dy) => { this.rect.x = s.x + dx; this.rect.y = s.y + dy; });
    this.drag(this.el.querySelector('.pgrip'), (s, dx, dy) => { this.rect.w = Math.max(MIN_W, s.w + dx); this.rect.h = Math.max(MIN_H, s.h + dy); });
    this.update();
  }
  conf() { const cfg = this.center.cfg(); return this.id === MAIN ? null : cfg.child_windows.find(c => c.id === this.id) || winconf.newConf(this.id, [...winconf.KNOWN, winconf.ETC]); }
  opt(key, dflt) { const cfg = this.center.cfg(); return this.id === MAIN ? (cfg[winconf.MAIN_KEY[key] || key] ?? dflt) : winconf.opt(this.conf(), cfg, key, dflt); }

  // the first place: the text starts where the window of 3.1.1 starts, a little aside (this is a viewer for now: nothing is saved)
  place() {
    const cfg = this.center.cfg(), g = layout.parseGeometry(this.id === MAIN ? cfg.geometry : (this.conf() || {}).geometry) || { w: 420, h: 300, x: 100, y: 100 };
    const d = this.center.dpr(), [ox, oy] = this.center.origin();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('cmr-center-' + this.id) || 'null'); } catch { /* none */ }
    this.rect = saved || { x: ((g.x ?? 100) - ox) / d + 60, y: ((g.y ?? 100) - oy) / d + 60 + BAR_H, w: g.w / d, h: g.h / d };
    this.layout();
  }
  layout() {
    const r = this.rect;
    this.el.style.left = r.x + 'px'; this.el.style.top = (r.y - BAR_H) + 'px'; this.el.style.width = r.w + 'px'; this.el.style.height = (r.h + BAR_H) + 'px';
  }
  // the box (the bar included) in pixels of the page, for the center
  box() { const r = this.rect, d = this.center.dpr(); return { id: String(this.id), x: r.x * d, y: (r.y - BAR_H) * d, w: r.w * d, h: (r.h + BAR_H) * d }; }

  drag(target, fn) {
    target.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      target.setPointerCapture(e.pointerId);
      const s = { ...this.rect, px: e.clientX, py: e.clientY };
      const move = m => { fn(s, m.clientX - s.px, m.clientY - s.py); this.layout(); this.center.changed(this); };
      const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); try { localStorage.setItem('cmr-center-' + this.id, JSON.stringify(this.rect)); } catch { /* not kept */ } };
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
