// A web window (a page of the web in a frameless window of the system: webwin.rs) in a control center (3.2). The page itself is the window of the system; what the center draws is its bar
// (the title and the buttons), the strips along its edges that resize it, and the thin line that shows while the page scrolls. The place is that of the page (`rect`, the bar above it); the
// program puts the window there (center_rects: a box with `web`), under the center, so that the bar and the strips take the mouse and the page gets the rest of it.
import * as winconf from './core/winconf.js';
import * as layout from './core/winlayout.js';
import * as B from './core/browsers.js';
import { BAR_H, dragFrame, sizeEdges } from './frame.js';

const EDGE = 5, GRIP = 16;                                           // (css pixels: the width of the strips, the size of the corner)
const SCROLL_SHOW_MS = 900;

export class WebPane {
  // info: { win: the number of its entry in the list of windows, label: the label of the window of the system, title, lock }; center: see center.js
  constructor(info, center) {
    this.win = info.win; this.label = info.label; this.center = center; this.lock = !!info.lock; this.title = info.title || ''; this.url = '';
    this.kind = info.kind === 'browser' ? 'browser' : 'web';                // (a window of the mini browser has an address in its bar, a window of a plugin the title of the page)
    this.el = document.createElement('div'); this.el.className = 'pane webpane'; this.el.dataset.web = this.label;
    const head = this.kind === 'browser' ? '<span class="ptabs"><input class="paddr" spellcheck="false" autocomplete="off" placeholder="주소 또는 검색어"></span>' : '<span class="ptabs"><span class="ptab on"></span></span>';
    this.el.innerHTML = '<div class="pbar">' + head + '<span class="pspace"></span><span class="ptools"><button class="pback" tabindex="-1" title="뒤로">‹</button><button class="preload" tabindex="-1" title="새로고침">↻</button><button class="pclose" tabindex="-1" title="닫기">✕</button></span></div><div class="pbody"><div class="pscroll"></div></div><div class="pgrip"></div><div class="pedge e-l"></div><div class="pedge e-r"></div><div class="pedge e-b"></div><div class="pedge e-bl"></div>';
    document.body.append(this.el);
    this.el.style.zIndex = String((this.kind === 'browser' ? 600 : 500) + (Number(this.win) || 0));       // (the web windows are above the translation windows that have not been touched, below the ones that were)
    this.el.addEventListener('pointerdown', () => this.center.raise(this), true);
    this.el.addEventListener('contextmenu', e => { e.preventDefault(); this.center.menu(e, this); });
    if (this.kind === 'browser') this.address();
    this.place();
    dragFrame(this, this.el.querySelector('.pbar'), (s, dx, dy) => { this.rect.x = s.x + dx; this.rect.y = Math.max(BAR_H, s.y + dy); }, e => !this.lock && !e.target.closest('button') && !e.target.closest('input'));
    sizeEdges(this, () => !this.lock, [190, 320]);                      // (the smallest a web window can be: a window made too small by mistake is hard to get back)
    const q = s => this.el.querySelector(s);
    q('.pback').onclick = () => invoke('web_cmd', { label: this.label, cmd: 'back' }).catch(() => {});
    q('.preload').onclick = () => invoke('web_cmd', { label: this.label, cmd: 'reload' }).catch(() => {});
    q('.pclose').onclick = () => { this.save(); emit('web-close', { label: this.label }); };                  // (the hub closes it: it keeps the list of what is open)
    q('.pbar').addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') e.preventDefault(); });
    this.el.classList.toggle('locked', this.lock);
    this.showTitle();
  }
  conf() { const cfg = this.center.cfg(); return (this.kind === 'browser' ? (cfg.browser_windows || []) : cfg.child_windows).find(c => c.id === this.win) || null; }
  opt(key, dflt) { return this.kind === 'browser' ? ((this.conf() || {})[key] ?? dflt) : winconf.opt(this.conf(), this.center.cfg(), key, dflt); }
  savedGeometry() { return (this.conf() || {}).geometry; }

  showTitle() {
    if (this.kind === 'browser') {                                    // (the address: not while it is typed in)
      const a = this.el.querySelector('.paddr');
      a.title = this.title;
      if (document.activeElement !== a) a.value = this.url;
      return;
    }
    const t = this.el.querySelector('.ptab');
    t.textContent = this.title || (this.url ? (() => { try { return new URL(this.url).host; } catch { return ''; } })() : '');
    t.title = this.url;
  }
  // The address bar of a window of the mini browser. A center never takes the keyboard of the game, so typing goes like typing into a text box of a web page: the mouse coming over the box asks
  // the program to lift that for the center ("prep"), a click then activates it by the system and the keys come here; when the box is left (or Enter, Esc) the keyboard goes back to the game.
  address() {
    const a = this.el.querySelector('.paddr'), label = this.center.label;
    let prepared = false, leaveT = 0;
    const prep = on => { if (on !== prepared) { prepared = on; invoke(on ? 'center_prep' : 'center_unprep', { label }).catch(() => {}); } };
    const done = () => { clearTimeout(leaveT); if (prepared) { prepared = false; invoke('center_release', { label }).catch(() => {}); } };
    a.addEventListener('mouseenter', () => { clearTimeout(leaveT); prep(true); });
    a.addEventListener('mouseleave', () => { if (document.activeElement !== a) { clearTimeout(leaveT); leaveT = setTimeout(() => { if (document.activeElement !== a) prep(false); }, 300); } });
    a.addEventListener('mousedown', e => { if (e.button === 0) invoke('center_inputclick', { label }).catch(() => {}); });       // (macOS: asked to make sure the program is active)
    a.addEventListener('focus', () => a.select());
    a.addEventListener('blur', () => { a.value = this.url; done(); });
    a.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const url = B.addressFrom(a.value);
        if (url) invoke('web_cmd', { label: this.label, cmd: 'goto', url }).catch(() => {});
        a.blur();
      } else if (e.key === 'Escape') a.blur();
    });
  }
  setTitle(t) { this.title = String(t || ''); this.showTitle(); }
  setUrl(u) { this.url = String(u || ''); this.showTitle(); }
  // the page scrolls: a thin line at the right edge (p: how far, 0 .. 1; s: how much of the page is in view, 0 .. 1) for a moment
  setScroll(p, s) {
    const bar = this.el.querySelector('.pscroll'), track = Math.max(10, this.rect.h - 8), h = Math.max(24, track * Math.min(1, s)), room = Math.max(0, track - h);
    bar.style.height = h + 'px'; bar.style.top = (4 + room * Math.min(1, Math.max(0, p))) + 'px'; bar.style.opacity = '1';
    clearTimeout(this.scrollT); this.scrollT = setTimeout(() => { bar.style.opacity = '0'; }, SCROLL_SHOW_MS);
  }

  // the place: the page is where its saved geometry says (the outer rectangle of the window of the system); the bar stands above it
  place() {
    const g = layout.parseGeometry(this.savedGeometry()) || { w: 360, h: 640, x: null, y: null };
    const d = this.center.dpr(), [ox, oy] = this.center.origin();
    const m = this.center.mainScreen && this.center.mainScreen();                       // (no saved place: on the main screen; the area of all the screens has holes)
    const x = g.x === null ? (m ? m[0] + 120 : ox + 200) : g.x, y = g.y === null ? (m ? m[1] + 100 : oy + 160) : g.y;
    this.rect = { x: (x - ox) / d, y: Math.max(BAR_H, (y - oy) / d), w: g.w / d, h: g.h / d };
    this.geo = this.seenGeo = this.savedGeometry() || '';
    this.layout();
  }
  layout() {
    const r = this.rect;
    this.el.style.left = r.x + 'px'; this.el.style.top = (r.y - BAR_H) + 'px'; this.el.style.width = r.w + 'px'; this.el.style.height = (r.h + BAR_H) + 'px';
  }
  // the boxes for the center, in pixels of the page: the bar and the strips take the mouse (`hit`); the page itself is `web`: the window of the system is put there, and the mouse goes through
  boxes() {
    const r = this.rect, d = this.center.dpr(), id = 'w' + this.win, b = (suffix, x, y, w, h, extra) => ({ id: id + suffix, x: x * d, y: y * d, w: w * d, h: h * d, bar: 0, hit: true, ...extra });
    return [
      { id, x: r.x * d, y: r.y * d, w: r.w * d, h: r.h * d, bar: 0, hit: false, web: this.label },
      b('b', r.x, r.y - BAR_H, r.w, BAR_H),
      ...(this.lock ? [] : [b('l', r.x, r.y, EDGE, r.h), b('r', r.x + r.w - EDGE, r.y, EDGE, r.h), b('s', r.x, r.y + r.h - EDGE, r.w, EDGE), b('g', r.x + r.w - GRIP, r.y + r.h - GRIP, GRIP, GRIP)]),
    ];
  }
  box() { const r = this.rect, d = this.center.dpr(); return { id: 'w' + this.win, x: r.x * d, y: (r.y - BAR_H) * d, w: r.w * d, h: (r.h + BAR_H) * d, bar: BAR_H * d }; }
  screenBox() { const b = this.box(), [ox, oy] = this.center.origin(); return { x: ox + b.x, y: oy + b.y, w: b.w, h: b.h }; }
  save() {
    const r = this.rect, d = this.center.dpr(), [ox, oy] = this.center.origin();
    this.geo = layout.formatGeometry(r.w * d, r.h * d, ox + r.x * d, oy + r.y * d);
    emit(this.kind === 'browser' ? 'browser-geometry' : 'win-geometry', { id: this.win, geometry: this.geo });
  }
  note() { /* a web window has no lines to write a notice in */ }

  // the settings changed
  update() {
    this.lock = !!this.opt('lock_window', false);
    this.el.classList.toggle('locked', this.lock);
    const sg = this.savedGeometry() || '';
    if (sg !== this.seenGeo) {                                        // (the saved place changed: when it is not this window's own echo, someone else moved it)
      this.seenGeo = sg;
      // (the hub keeps the place of the window of the system too, a moment after it moved: the numbers may differ by a pixel from this box's own: that is not someone else moving it)
      const a = layout.parseGeometry(sg), b = layout.parseGeometry(this.geo), near = a && b && ['w', 'h', 'x', 'y'].every(k => Math.abs(a[k] - b[k]) <= 2);
      if (sg !== this.geo && !near && !this.resizing) { this.place(); this.center.changed(this); }
    }
  }
  destroy() { clearTimeout(this.scrollT); this.el.remove(); }
}
