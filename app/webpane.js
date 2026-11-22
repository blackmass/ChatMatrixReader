// A web window (a page of the web in a frameless window of the system: webwin.rs) in a control center (3.2). The page itself is the window of the system; what the center draws is its bar
// (the title and the buttons), the strips along its edges that resize it, and the thin line that shows while the page scrolls. The place is that of the page (`rect`, the bar above it); the
// program puts the window there (center_rects: a box with `web`), under the center, so that the bar and the strips take the mouse and the page gets the rest of it.
import * as winconf from './core/winconf.js';
import * as layout from './core/winlayout.js';
import * as B from './core/browsers.js';
import { BAR_H, dragFrame, sizeEdges } from './frame.js';
import { tr } from './core/i18n.js';

const EDGE = 5, GRIP = 16;                                           // (css pixels: the width of the strips, the size of the corner)
const SCROLL_SHOW_MS = 900;

export class WebPane {
  // info: { win: the number of its entry in the list of windows, label: the label of the window of the system, title, lock }; center: see center.js
  constructor(info, center) {
    this.win = info.win; this.label = info.label; this.center = center; this.lock = !!info.lock; this.title = info.title || ''; this.url = '';
    this.kind = info.kind === 'browser' ? 'browser' : 'web';                // (a window of the mini browser has an address in its bar, a window of a plugin the title of the page)
    this.el = document.createElement('div'); this.el.className = 'pane webpane'; this.el.dataset.web = this.label;
    const head = '<span class="ptabs"><span class="ptab on"></span></span>';
    const row = this.kind === 'browser' ? '<div class="paddrbar"><button class="phome" tabindex="-1" title="처음 주소로">⌂</button><div class="paddr"><span class="phold">주소 또는 검색어</span><span class="ptxt"></span></div><button class="pmode" tabindex="-1"></button></div>' : '';       // (the second line of a window of the mini browser: the address)
    this.head = this.kind === 'browser' ? BAR_H * 2 : BAR_H;                   // (how much of the window is above the page, css pixels)
    this.el.innerHTML = '<div class="pbar">' + head + '<span class="pspace"></span><span class="ptools"><button class="pback" tabindex="-1" title="뒤로">‹</button><button class="preload" tabindex="-1" title="새로고침">↻</button><button class="pclose" tabindex="-1" title="닫기">✕</button></span></div>' + row + '<div class="pbody"><div class="pscroll"></div></div><div class="pgrip"></div><div class="pedge e-l"></div><div class="pedge e-r"></div><div class="pedge e-b"></div><div class="pedge e-bl"></div>';
    document.body.append(this.el);
    this.el.style.zIndex = String((this.kind === 'browser' ? 600 : 500) + (Number(this.win) || 0));       // (the web windows are above the translation windows that have not been touched, below the ones that were)
    this.el.addEventListener('pointerdown', () => this.center.raise(this), true);
    this.el.addEventListener('contextmenu', e => { e.preventDefault(); this.center.menu(e, this); });
    if (this.kind === 'browser') { this.address(); this.setMode(info.mode); }
    this.place();
    dragFrame(this, this.el.querySelector('.pbar'), (s, dx, dy) => { this.rect.x = s.x + dx; this.rect.y = Math.max(this.head, s.y + dy); }, e => !this.lock && !e.target.closest('button'));
    sizeEdges(this, () => !this.lock, [190, 320]);                      // (the smallest a web window can be: a window made too small by mistake is hard to get back)
    const q = s => this.el.querySelector(s);
    q('.pback').onclick = () => invoke('web_cmd', { label: this.label, cmd: 'back' }).catch(() => {});
    q('.preload').onclick = () => invoke('web_cmd', { label: this.label, cmd: 'reload' }).catch(() => {});
    q('.pclose').onclick = () => { this.save(); emit('web-close', { label: this.label }); };                  // (the hub closes it: it keeps the list of what is open)
    q('.pbar').addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') e.preventDefault(); });
    if (this.kind === 'browser') {
      q('.phome').onclick = () => { const c = this.conf() || {}; invoke('web_cmd', { label: this.label, cmd: 'goto', url: B.isWebUrl(c.start_url) ? c.start_url : B.START_URL }).catch(() => {}); };
      q('.pmode').onclick = () => emit('browser-command', { cmd: 'mode', id: this.win });                    // (the hub: it knows what the window is)
      q('.paddrbar').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
      // the title with Shift or Ctrl: this page in the user's own browser
      q('.ptab').addEventListener('click', e => { if (e.shiftKey || e.ctrlKey || e.metaKey) invoke('web_cmd', { label: this.label, cmd: 'external' }).catch(() => {}); });
    }
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
      a.querySelector('.ptxt').textContent = this.url;
      a.classList.toggle('empty', !this.url);
    }
    const t = this.el.querySelector('.ptab');
    t.textContent = this.title || (this.url ? (() => { try { return new URL(this.url).host; } catch { return ''; } })() : '');
    t.title = this.url + (this.kind === 'browser' ? '\n' + tr('Shift 또는 Ctrl+클릭: 내 브라우저에서 열기') : '');
  }
  // The address of a window of the mini browser is drawn here, but typed in a small window of the system (address.js): the center never takes the keyboard. A click on it asks the program to put that
  // window over this place; clicking anywhere else of this window (or closing it) puts it away.
  address() {
    const a = this.el.querySelector('.paddr');
    a.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = a.getBoundingClientRect(), d = this.center.dpr(), [ox, oy] = this.center.origin();
      a.classList.add('editing');
      invoke('address_show', { label: this.label, x: Math.round(ox + r.left * d), y: Math.round(oy + r.top * d), w: Math.round(r.width * d), h: Math.round(r.height * d), text: this.url }).catch(() => {});
    });
    this.el.addEventListener('pointerdown', e => { if (!e.target.closest('.paddr')) { a.classList.remove('editing'); invoke('address_hide').catch(() => {}); } }, true);
    // (the box over it says when it comes and goes: the letters behind are hidden while it is there, and the frame shows that it is the one typed in)
    listen('address-state', ev => { const p = ev.payload || {}; a.classList.toggle('editing', !!p.open && p.label === this.label); });
  }
  // the way the page is seen now: the button shows it (the other one is what a click gives)
  setMode(m) {
    const b = this.el.querySelector('.pmode'); if (!b) return;
    const pc = m === 'pc';
    if (b.dataset.mode === (pc ? 'pc' : 'mobile')) return;
    b.dataset.mode = pc ? 'pc' : 'mobile';
    b.innerHTML = pc ? '<svg viewBox="0 0 16 14" width="14" height="12"><rect x="1" y="1" width="14" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 13h6M8 10v3" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>'
      : '<svg viewBox="0 0 12 16" width="10" height="13"><rect x="2" y="1" width="8" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="12.5" r=".9" fill="currentColor"/></svg>';
    b.title = pc ? tr('PC 화면입니다. 누르면 모바일 화면으로 바꿉니다.') : tr('모바일 화면입니다. 누르면 PC 화면으로 바꿉니다.');
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
    this.rect = { x: (x - ox) / d, y: Math.max(this.head, (y - oy) / d), w: g.w / d, h: g.h / d };
    this.geo = this.seenGeo = this.savedGeometry() || '';
    this.layout();
  }
  layout() {
    const r = this.rect;
    this.el.style.left = r.x + 'px'; this.el.style.top = (r.y - this.head) + 'px'; this.el.style.width = r.w + 'px'; this.el.style.height = (r.h + this.head) + 'px';
  }
  // the boxes for the center, in pixels of the page: the bar and the strips take the mouse (`hit`); the page itself is `web`: the window of the system is put there, and the mouse goes through
  boxes() {
    const r = this.rect, d = this.center.dpr(), id = 'w' + this.win, b = (suffix, x, y, w, h, extra) => ({ id: id + suffix, x: x * d, y: y * d, w: w * d, h: h * d, bar: 0, hit: true, ...extra });
    return [
      { id, x: r.x * d, y: r.y * d, w: r.w * d, h: r.h * d, bar: 0, hit: false, web: this.label },
      b('b', r.x, r.y - this.head, r.w, BAR_H),
      ...(this.kind === 'browser' ? [b('a', r.x, r.y - BAR_H, r.w, BAR_H)] : []),
      ...(this.lock ? [] : [b('l', r.x, r.y, EDGE, r.h), b('r', r.x + r.w - EDGE, r.y, EDGE, r.h), b('s', r.x, r.y + r.h - EDGE, r.w, EDGE), b('g', r.x + r.w - GRIP, r.y + r.h - GRIP, GRIP, GRIP)]),
    ];
  }
  box() { const r = this.rect, d = this.center.dpr(); return { id: 'w' + this.win, x: r.x * d, y: (r.y - this.head) * d, w: r.w * d, h: (r.h + this.head) * d, bar: this.head * d }; }
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
  destroy() { clearTimeout(this.scrollT); if (this.kind === 'browser') invoke('address_hide').catch(() => {}); this.el.remove(); }
}
