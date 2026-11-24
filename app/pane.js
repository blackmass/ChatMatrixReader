// A translation window of the control center (3.2): the chat of one window (its own WindowFeed and ChatView, like a window of 3.1.1) in a box of the page of a center, with a bar above it (the
// bar is OUTSIDE the text: the place and the size of a window are those of its text). The pane asks the center for what a window does by itself (place, order, mouse): center.js.
import { ChatView, lookFrom } from './chatview.js';
import { WindowFeed } from './core/windowfeed.js';
import { MAIN } from './core/pipeline.js';
import * as winconf from './core/winconf.js';
import * as layout from './core/winlayout.js';
import { nameFor } from './winname.js';
import { WidgetLayer } from './widgets/render.js';
import { tr } from './core/i18n.js';
import { isMac } from './platform.js';
import { T } from './core/timings.js';
import { PageView } from './pageview.js';
import * as settings from './settings.js';
import { BAR_H, dragFrame, sizeEdges, moveBy, barBelow, tileBox, untileBox } from './frame.js';

export { BAR_H };

export class Pane {
  // center: { cfg(), dpr(), origin() -> [ox, oy] in pixels, changed(pane) }
  constructor(id, center) {
    this.id = id; this.center = center; this.label = `c${id}`;
    this.head = BAR_H; this.flip = false; this.tiled = ''; this.restoreRect = null;                              // (the bar: how high it is, and whether it is below the text: frame.js barBelow)
    this.lags = []; this.lmbAt = 0; this.lastDown = -1e9; this.wheelCount = 0;                  // (how long a click takes to reach the page: for the diagnosis in the options)
    this.review = false; this.reviewIdle = 0; this.reviewShown = false; this.zone = false; this.lastInput = -1e9;      // (reading the old chat: see userScrolled)
    this.interactive = true; this.outside = true; this.hover = false; this.wasThrough = null;      // (the state of the mouse: see tick)
    this.chats = new Map(); this.active = id;                         // the chats of the pane: its own window and the windows docked to it as tabs
    this.el = document.createElement('div'); this.el.className = 'pane'; this.el.dataset.id = String(id);
    this.el.innerHTML = '<div class="pbar"><span class="ptabs"></span><span class="pspace"></span><span class="ptools"><button class="presearch" tabindex="-1" title="매트릭스 다시 찾기">⟳</button><button class="pvoice" tabindex="-1" title="음성인식 켜기" data-state="off"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path class="waves" d="M11.2 5.4a3.6 3.6 0 0 1 0 5.2M13 3.6a6.2 6.2 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button><button class="poptions" tabindex="-1" title="옵션">⚙</button><button class="pclose" tabindex="-1">✕</button></span></div><div class="pbody"><div class="pbg"></div><div class="pwidgets" data-notr></div></div><div class="pgrip"></div><div class="pedge e-l"></div><div class="pedge e-r"></div><div class="pedge e-b"></div><div class="pedge e-bl"></div><button class="ptobottom" tabindex="-1" title="이전 대화를 보는 중입니다. 누르면 맨 아래(최신 글)로 돌아갑니다">↓ 맨 아래로</button>';
    this.tabs = this.el.querySelector('.ptabs');
    document.body.append(this.el);
    this.widgets = new WidgetLayer({ root: this.el.querySelector('.pwidgets'), registry: center.registry });     // (the widgets of the window: its host's, like in 3.1.1)
    this.widgetIds = '';
    this.widgets.sink = center.widgetSink;
    this.widgets.onAction = (id, type, item) => emit('widget-action', { id, type, ...(item ? { item } : {}) });
    this.el.addEventListener('pointermove', e => this.widgets.pointer(e.clientX, e.clientY));
    this.el.addEventListener('pointerleave', () => this.widgets.pointer(null, null));
    for (const ev of ['wheel', 'pointerdown', 'pointermove']) this.el.addEventListener(ev, e => { if ((ev !== 'pointermove' || e.buttons) && e.target.closest && e.target.closest('.pbody')) this.lastInput = performance.now(); }, { capture: true, passive: true });       // (what the user does to the lines: not the bar, the edges, the corner: the size of the window moves the lines by itself)
    this.el.querySelector('.ptobottom').onclick = () => { const c = this.chats.get(this.active); c.lines.scrollTop = c.lines.scrollHeight; this.review = false; this.reviewIdle = 0; c.view.touch(); };
    this.el.addEventListener('contextmenu', e => { e.preventDefault(); this.center.menu(e, this); });
    this.syncChats();
    this.el.style.zIndex = String(1000 + (Number(id) || 0));          // (the first order: a window of a higher number is above. A translation window is always above the web windows: their numbers are below 1000, see center.js)
    this.el.addEventListener('pointerdown', e => {
      this.center.raise(this);
      if (e.button !== 0) return;                                  // the click as the page gets it: how long after the system saw the button go down?
      if (this.lmbAt) { this.noteLag(performance.now() - this.lmbAt); this.lmbAt = 0; } else this.lastDown = performance.now();
    }, true);         // (touched: this pane comes to the front of the center)
    this.place();
    // the bar moves the window (a tab only changes the chat when there are several: like 3.1.1)
    this.drag(this.el.querySelector('.pbar'), (s, dx, dy, ev) => moveBy(this, s, dx, dy, ev), e => !this.opt('lock_window', false) && !this.tiled && !e.target.closest('button') && !(this.chats.size > 1 && e.target.closest('.ptab')));
    // (the option "위쪽 바 더블클릭으로 전체 화면"): a double click on the bar lays the window on its monitor, another one puts it back. Not on a button, not on a tab that has others next to it (a quick second click on a tab is a tab), not while locked.
    this.el.querySelector('.pbar').addEventListener('dblclick', e => {
      if (!this.center.cfg().bar_fullscreen || this.opt('lock_window', false) || e.target.closest('button') || (this.chats.size > 1 && e.target.closest('.ptab'))) return;
      if (this.tiled) this.untile(); else this.tile('full');
    });
    this.tools();
    sizeEdges(this, () => !this.opt('lock_window', false) && !this.tiled);         // (the corner at the bottom right and the edges left, right, bottom and the corner bottom left; the top is the bar)
    this.update();
  }
  confOf(id) { const cfg = this.center.cfg(); return id === MAIN ? null : cfg.child_windows.find(c => c.id === id) || winconf.newConf(id, [...winconf.KNOWN, winconf.ETC]); }
  optOf(id, key, dflt) { const cfg = this.center.cfg(); return id === MAIN ? (cfg[winconf.MAIN_KEY[key] || key] ?? dflt) : winconf.opt(this.confOf(id), cfg, key, dflt); }
  conf() { return this.confOf(this.id); }
  // (a window of the system, center.js `native`: the system moves it, sizes it and has it in front: locked for our own frame, and nothing to go through)
  opt(key, dflt) { if (this.center.native && (key === 'lock_window' || key === 'click_through' || key === 'hover_clear')) return key === 'lock_window'; return this.optOf(this.id, key, dflt); }
  // an option of a chat: what belongs to the window (place, order, blur, ...) follows the host of the tabs, the rest (the look of the text, the filter) is its own
  copt(id, key, dflt) { return id === this.id || winconf.HOST_KEYS.has(key) ? this.opt(key, dflt) : this.optOf(id, key, dflt); }

  // the chats follow the settings: the windows docked to this one are its tabs (the active one shows its lines, the others are hidden)
  syncChats() {
    const cfg = this.center.cfg(), want = [this.id, ...winconf.dockedOf(cfg.child_windows, this.id).filter(i => cfg.child_windows.some(c => c.id === i && c.kind !== 'web'))];
    for (const id of want) if (!this.chats.has(id)) { const c = new Chat(this, id); this.chats.set(id, c); if (this.ready) emit('feed-hello', { label: c.label }); }
    for (const [id, c] of [...this.chats]) if (!want.includes(id)) { c.destroy(); this.chats.delete(id); }
    if (!this.chats.has(this.active)) this.active = this.id;
    this.showTabs();
  }
  showTabs() {
    this.el.classList.toggle('has-alert', [...this.chats.values()].some(x => x.alert && x.id !== this.active));
    this.tabs.textContent = '';
    for (const c of this.chats.values()) {
      const t = document.createElement('span'); t.className = 'ptab' + (c.id === this.active ? ' on' : '') + (c.alert ? ' alert' : ''); t.textContent = nameFor(this.center.cfg(), c.id); t.dataset.chat = String(c.id);
      t.addEventListener('pointerdown', e => { if (e.button === 0 && this.chats.size > 1) { this.activate(c.id); e.stopPropagation(); } });
      this.tabs.append(t);
    }
    for (const c of this.chats.values()) c.lines.classList.toggle('off', c.id !== this.active);
  }
  note(text) { const h = this.chats.get(this.id); h.view.apply(h.feed.model.addNote(text, 'system'), h.feed.model); }
  activate(id) {
    if (!this.chats.has(id)) return;
    this.active = id; const c = this.chats.get(id); c.alert = false; this.showTabs(); c.view.apply(c.feed.applySettings(), c.feed.model);
  }

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
  savedGeometry() { return this.id === MAIN ? this.center.cfg().geometry : (this.conf() || {}).geometry; }
  place() {
    if (this.center.native) {                                                // (a window of the system: the text area is the window below the bar, whatever its size is now)
      this.tiled = ''; this.restoreRect = null;
      this.rect = { x: 0, y: BAR_H, w: Math.max(40, innerWidth), h: Math.max(40, innerHeight - BAR_H) };
      this.geo = this.seenGeo = this.savedGeometry() || '';
      this.layout();
      return;
    }
    this.tiled = ''; this.restoreRect = null;                             // (the place of the settings: a window that was laid on a monitor is not any more)
    const cfg = this.center.cfg(), g = layout.parseGeometry(this.savedGeometry()) || { w: layout.DEFAULT_SIZE[0], h: layout.DEFAULT_SIZE[1], x: null, y: null };
    const d = this.center.dpr(), [ox, oy] = this.center.origin();
    let { x, y } = g;
    if (x === null || y === null) {                                  // no place saved: the middle of the screen, a step further when another window stands there (never at the top edge: the menu bar)
      const spot = this.center.firstSpot && this.center.firstSpot(this, g.w, g.h, this.head);
      if (spot) [x, y] = spot;
      else {                                                         // (the screens are not known yet: next to the main window, a little lower each time, like a window of 3.1.1)
        const m = layout.parseGeometry(cfg.geometry), n = Math.max(1, cfg.child_windows.findIndex(c => c.id === this.id) + 1);
        [x, y] = layout.cascade(m && m.x !== null ? [m.x, m.y] : null, this.id === MAIN ? 0 : n);
      }
    }
    this.rect = { x: (x - ox) / d, y: (y - oy) / d, w: g.w / d, h: g.h / d };
    this.geo = this.seenGeo = this.savedGeometry() || '';
    this.layout();
  }
  layout() {
    const r = this.rect;
    this.flip = barBelow(this); this.el.classList.toggle('flip', this.flip); this.el.classList.toggle('tiled', !!this.tiled);          // (touching the top of a monitor: the bar goes below the text)
    const grip = this.el.querySelector('.pgrip'); if (grip) grip.style.bottom = this.flip ? BAR_H + 'px' : '';          // (the corner to resize by stays at the corner of the text, over the bar)
    this.el.style.left = r.x + 'px'; this.el.style.top = (this.flip ? r.y : r.y - BAR_H) + 'px'; this.el.style.width = r.w + 'px'; this.el.style.height = (r.h + BAR_H) + 'px';
  }
  // the blur behind the text area (0 off | 1 weak | 2 strong): the center makes a window of the system for it. While the window is cleared by the mouse or resized, the blur behind it goes too.
  blurLevel() { return Number(this.opt('blur', 0)) && !this.hover && !this.resizing ? Number(this.opt('blur', 0)) : 0; }
  // the box (the bar included) in pixels of the page, for the center
  // where it is on the screen (pixels): the page's origin plus the box
  screenBox() { const b = this.box(), [ox, oy] = this.center.origin(); return { x: ox + b.x, y: oy + b.y, w: b.w, h: b.h }; }
  boxY() { return this.flip ? this.rect.y : this.rect.y - BAR_H; }
  box() { const r = this.rect, d = this.center.dpr(); return { id: String(this.id), x: r.x * d, y: this.boxY() * d, w: r.w * d, h: (r.h + BAR_H) * d, bar: BAR_H * d, below: this.flip }; }
  // where the text area is on the screen now: told to the hub, which keeps it in the settings (a window of 3.1.1 did the same)
  save() {
    if (this.tiled || this.center.native) return;                          // (what lays a window on a monitor is not kept: the place of the settings stays. A window of the system: nothing is kept yet)
    const r = this.rect, d = this.center.dpr(), [ox, oy] = this.center.origin();
    this.geo = layout.formatGeometry(r.w * d, r.h * d, ox + r.x * d, oy + r.y * d);
    emit('win-geometry', { id: this.id, geometry: this.geo });
  }

  drag(target, fn, accept, flag) { dragFrame(this, target, fn, accept, flag); }
  // laid on the monitor it is on (frame.js tileBox): 'full' | 'top' | 'bottom' | 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br'; a window that is locked is not
  tile(kind) { if (!this.opt('lock_window', false)) tileBox(this, kind); }
  untile() { untileBox(this); }

  // the settings changed (or the first time)
  update() {
    const cfg = this.center.cfg();
    this.syncChats();
    const sg = this.savedGeometry() || '';
    if (sg !== this.seenGeo) {                                        // (the saved place changed: when it is not this window's own echo, someone else moved it: the options, the program)
      this.seenGeo = sg;
      if (sg !== this.geo && !this.resizing) { this.place(); this.center.changed(this); }
    }
    this.el.style.setProperty('--bg-alpha', String(Math.min(winconf.MAX_BG_OPACITY, Number(this.opt('bg_opacity', 1)))));          // (never whole: see winconf.MAX_BG_OPACITY)
    for (const c of this.chats.values()) c.update();
    this.applyWidgets();
    this.style();
    const through = !!this.opt('click_through', false);
    if (through && this.wasThrough === false) this.throughNotice();
    this.wasThrough = through;
  }
  // what the settings say about how it looks (the classes the style sheet works from; the same names as the body of a window of 3.1.1)
  style() {
    const c = this.el.classList, through = !!this.opt('click_through', false);
    c.toggle('through', through); c.toggle('locked', !!this.opt('lock_window', false));
    for (const k of ['tools', 'tabs', 'frame']) c.toggle('hide-' + k, !!this.opt('hide_' + k, false));      // ("평소에 인터페이스 숨기기": they show while the mouse is in the window)
    const ta = Math.min(1, Math.max(0.05, Number(this.opt('tab_opacity', 1)) || 1));                          // (the tabs and the icon box: how solid; the one under the mouse is a little more)
    this.el.style.setProperty('--tab-alpha', String(ta)); this.el.style.setProperty('--tab-alpha-hover', String(Math.min(1, ta + 0.3)));
    c.toggle('has-alert', [...this.chats.values()].some(x => x.alert && x.id !== this.active));
  }
  // what to do while the window lets the clicks through (told when it is switched on)
  async throughNotice() {
    let key = true; try { key = await invoke('options_hotkey_ok'); } catch { /* unknown */ }
    const keys = (this.opt('interact_keys', ['Shift']) || ['Shift']).join('+');
    this.note('ℹ ' + tr('클릭 관통 중입니다. {keys}를 누른 채로 조작합니다. 옵션은 {open}에서 엽니다.', { keys, open: key ? tr('Ctrl+Alt+O 또는 트레이 아이콘') : tr('트레이 아이콘') }));
  }

  // The mouse and the keys (every OVERLAY_POLL_MS; s: the state of the system, see os_state): a window that is click-through takes the mouse only while the interact keys are held with
  // the cursor over it (then the center gets its place, see center.js); the rest of the time the clicks go through to the game. `ctx.game`: a game is there (no game: nothing to click through to).
  tick(s, ctx) {
    const [cx, cy] = s.cursor, b = this.screenBox();
    const inside = cx >= b.x && cx < b.x + b.w && cy >= b.y && cy < b.y + b.h;
    const keys = this.opt('interact_keys', ['Shift']) || ['Shift'];
    const held = keys.length > 0 && keys.every(k => s[String(k).toLowerCase()] === true);
    const lmb = !!(s.keys && s.keys[0]);
    // (a button held on a window that is used goes on being used: a drag that leaves the window is not cut off)
    const now = !this.opt('click_through', false) || (held && inside) || !ctx.game || (this.interactive && lmb && this.pressed) || this.review;
    if (inside && lmb && !this.lmb && this.interactive) { this.pressed = true; if (performance.now() - this.lastDown < 250) this.noteLag(0); else this.lmbAt = performance.now(); } else if (!lmb) this.pressed = false;
    this.lmb = lmb;
    // reading stays while the lines are scrolled up, or the mouse is over the window; at the bottom with the mouse away for a moment: click-through again
    if (this.review) {
      if (this.chats.get(this.active).view.atBottom() && !inside) { if (!this.reviewIdle) this.reviewIdle = performance.now(); else if (performance.now() - this.reviewIdle > T.REVIEW_LEAVE_MS) { this.review = false; this.reviewIdle = 0; } }
      else this.reviewIdle = 0;
    }
    if (this.review !== this.reviewShown) { this.reviewShown = this.review; emit('hub-log', { level: 'info', msg: `window ${this.id}: reading the earlier chat ${this.review ? 'on' : 'off'}` }); }
    this.el.classList.toggle('review', this.review);                                 // (the frame turns amber and a way back down shows)
    const hover = !now && inside && !!this.opt('hover_clear', false);                 // click-through, the mouse over the window and no interact key: cleared
    // the mouse leaves the window: the selected text is copied (the option "자동 복사"), and the marked text is released
    if (this.inside && !inside) this.leave();
    this.inside = inside;
    const c = this.el.classList;
    // ("outside": what the hide options and the dimmed bar go by. A window the mouse goes through counts the mouse as away until the interact key is held: the cursor passing over it shows nothing)
    c.toggle('outside', !inside || !now); c.toggle('hover-clear', hover);
    const d = this.center.dpr(), [ox, oy] = this.center.origin(), px = (cx - ox) / d, py = (cy - oy) / d;
    this.widgets.pointer(inside && !hover ? px : null, inside && !hover ? py : null);       // (the tip of a widget under the cursor: also while click-through)
    // click-through: the page gets no mouse events, so the tip of a link under the cursor is shown from the cursor position (the option "관통 중 링크 보기 허용");
    // a Mac gives no mouse-over events to a window that is not the active one, so there the cursor does it for a usable window too
    const view = this.chats.get(this.active).view, fromCursor = !now ? ctx.cfg.through_tips !== false : isMac;
    if (inside && fromCursor && !hover) view.tipAtPoint(px, py); else view.hideTip();
    // the wheel over a window the mouse goes through is not for the game, both ways; a Mac keeps it while the earlier chat is read (the window is usable then)
    const zone = !!ctx.cfg.wheel_through && !this.opt('hover_clear', false) && (isMac ? !!this.opt('click_through', false) && ctx.game : !now);
    const changed = now !== this.interactive || zone !== this.zone || hover !== this.hover;
    this.hover = hover;
    this.zone = zone;
    this.interactive = now; c.toggle('interactive', now);
    return changed;
  }
  // The user scrolled the lines (dir -1 up, 1 down), by the wheel the page got or the one the exe took: up = reading the earlier chat (only when the lines went up); down onto the newest line = done.
  userScrolled(dir) {
    if (dir < 0) { this.review = true; this.reviewIdle = 0; }
    else if (this.review && this.chats.get(this.active).view.atBottom()) { this.review = false; this.reviewIdle = 0; }
  }
  // a turn of the wheel the exe took (positive = up): the lines move, and going up starts the review only when they really went up (at the very top there is nothing earlier to read)
  wheelScrolled(delta) {
    const c = this.chats.get(this.active), el = c.lines, before = el.scrollTop;
    this.wheelCount++;
    el.scrollTop -= delta * 100 / 120; c.view.touch();
    if (delta > 0) { if (el.scrollTop < before - 0.5) this.userScrolled(-1); } else this.userScrolled(1);
  }
  noteLag(ms) { this.lags.push(Math.max(0, Math.round(ms))); if (this.lags.length > 5) this.lags.shift(); }
  leave() {
    const sel = getSelection();
    if (sel.isCollapsed || !this.el.contains(sel.anchorNode)) return;
    const picked = sel.toString();
    if (this.center.cfg().auto_copy && picked.trim() && picked !== Pane.lastCopied) { Pane.lastCopied = picked; try { window.__TAURI__.clipboardManager.writeText(picked); } catch { /* no clipboard */ } }
    sel.removeAllRanges();
  }
  // the widgets of this window (docs/WIDGETS.md): drawn from the settings; one that is turned on asks the hub for its state
  applyWidgets() {
    const ids = this.widgets.set(this.id === MAIN ? this.center.cfg().widgets : (this.conf() || {}).widgets), key = ids.join(',');
    if (key !== this.widgetIds) { this.widgetIds = key; if (ids.length) emit('widget-hello', { ids }); }
  }

  // the events of the hub go to every chat of the pane; `label`: the chat a replay is for
  take(n, ev, quiet) { for (const c of this.chats.values()) c.take(n, ev, quiet); }
  takeReplay(label, events) { for (const c of this.chats.values()) if (c.label === label) c.takeReplay(events); }
  hello() { this.ready = true; for (const c of this.chats.values()) emit('feed-hello', { label: c.label }); }
  destroy() { this.widgets.pointer(null, null); for (const c of this.chats.values()) c.destroy(); this.el.remove(); }
}

// the chat of one window: its lines, its own WindowFeed and ChatView (like a window of 3.1.1); a pane has one for itself and one for each window docked to it
class Chat {
  constructor(pane, id) {
    this.pane = pane; this.id = id; this.label = `c${id}`; this.alert = false;
    this.seen = 0; this.firstLive = Infinity; this.replay = true;
    this.lines = document.createElement('div'); this.lines.className = 'plines lines'; this.lines.dataset.chat = String(id); this.lines.setAttribute('data-notr', '');
    pane.el.querySelector('.pbody').append(this.lines);
    const pc = id === MAIN ? null : pane.center.cfg().child_windows.find(c => c.id === id && c.kind === 'page') || null;          // a window of a plugin: its page instead of the chat
    this.view = pc ? new PageView(this.lines) : new ChatView(this.lines); this.view.sink = pane.center.viewSink;
    this.undo = [];                                                   // (what stops when the chat goes: the listeners of a page)
    this.feed = new WindowFeed(id, () => pane.center.cfg(), () => pane.confOf(id));
    // The review state follows the scroll position itself, whatever moved it (wheel, scrollbar, keys): going up = review, back at the newest line = done. Only what the user did counts as
    // "going up": the browser also moves the position by itself when the lines get shorter or the window smaller.
    let lastTop = this.lines.scrollTop;
    this.lines.addEventListener('scroll', () => {
      const t = this.lines.scrollTop;
      if (this.id === pane.active) { if (t < lastTop - 1) { if (performance.now() - pane.lastInput < 600 && !pane.resizing) pane.userScrolled(-1); } else if (t > lastTop + 1) pane.userScrolled(1); }
      lastTop = t;
    });
    if (pc) this.startPage(pc);
    this.update();
  }
  opt(k, d) { return this.pane.copt(this.id, k, d); }
  update() { this.view.setLook(lookFrom((k, d) => this.opt(k, d)), this.feed.model); this.view.apply(this.feed.applySettings(), this.feed.model); }
  take(n, ev, quiet) {
    if (n <= this.seen) return;
    this.seen = n; if (n < this.firstLive) this.firstLive = n;
    const ops = this.feed.handle(ev);
    this.view.apply(ops, this.feed.model);
    if (!quiet && this.id !== this.pane.active && ops.length && ev.type === 'LineAdded' && this.opt('tab_alert', false)) { this.alert = true; this.pane.showTabs(); }   // the mark on its tab ("새 글 알림")
  }
  takeReplay(events) {
    if (!this.replay) return;
    this.replay = false;
    const fresh = this.id !== MAIN && !!this.opt('clear_on_open', false), from = this.firstLive;
    this.view.apply(this.feed.clear(), this.feed.model); this.seen = 0;
    for (const x of events) if (!fresh || x.seq >= from) this.take(x.seq, x.event, true);
  }
  // The page of a plugin window: a sandboxed frame at the address of the plugin (the hub gives the secret part only while the plugin runs and may have the window); the calls of the page go
  // to the hub by events and its answers come back the same way (the bridge of the plugin checks everything), like the options page of a plugin.
  startPage(pc) {
    const frame = document.createElement('iframe'), from = 'win:' + this.id, BASE = isMac ? 'cmrplug://localhost/' : 'http://cmrplug.localhost/';
    frame.className = 'pl-page'; frame.setAttribute('sandbox', 'allow-scripts');
    this.lines.classList.add('page'); this.lines.append(frame);
    const post = msg => { try { frame.contentWindow.postMessage(msg, '*'); } catch { /* gone */ } };
    const ask = (method, args, seq) => emit('plugin-ui', { id: pc.owner, name: pc.owner_win, from, seq, method, args });
    const onMessage = e => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data;
      if (!m || m.cmr !== 1) return;
      if (m.event === 'hello') { ask('options.get', {}, -1); return; }                      // (the options the plugin asks for come as an event: seq -1)
      if (typeof m.id === 'number' && m.id >= 0 && typeof m.method === 'string') ask(m.method, m.args, m.id);
    };
    addEventListener('message', onMessage);
    this.undo.push(() => removeEventListener('message', onMessage));
    const later = p => p.then(un => this.undo.push(un));
    later(listen('plugin-ui-reply', e => {
      const r = e.payload;
      if (r.from !== from) return;
      if (r.seq === -1) { if (r.ok) post({ cmr: 1, event: 'options', value: r.value }); return; }
      post(r.ok ? { cmr: 1, id: r.seq, ok: true, value: r.value } : { cmr: 1, id: r.seq, ok: false, error: r.error });
    }));
    later(listen('plugin-page-reply', e => {
      if (e.payload.from !== from) return;
      if (!e.payload.token) { this.lines.append(Object.assign(document.createElement('div'), { className: 'pl-page-off', textContent: tr('플러그인이 꺼져 있습니다') })); frame.hidden = true; return; }
      frame.src = BASE + e.payload.token + '/' + pc.page;
    }));
    emit('plugin-page', { from, owner: pc.owner, name: pc.owner_win });
    this.undo.push(settings.onChange(() => ask('options.get', {}, -1)));                    // (the options of the plugin changed: the page is told)
  }
  destroy() { this.view.stop(); for (const u of this.undo) { try { u(); } catch { /* already gone */ } } this.lines.remove(); }
}
