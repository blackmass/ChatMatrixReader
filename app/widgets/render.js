// The widgets in a window page: the 8 inside places are containers, a widget is drawn by its kind, a state changes its look, and the tip is shown while
// the pointer is over it. No data of its own: it is given the settings (`set`), the states (`state`) and the pointer (`pointer`).
// The pointer comes from the window loop (the system's cursor position), not from mouse events: it also works while the window is click-through.
import { ANCHORS, KINDS, drawn } from './registry.js';
import { cleanSvg, svgSrc, MAX_SVG_FILE } from '../core/svg.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const BATTERY_CELLS = 5;

// one widget element for a kind and a style; -> { root, update(state) }
export function buildView(kind, style) {
  const k = Object.hasOwn(KINDS, kind) ? kind : 'text';
  if (k === 'meter' && style === 'battery') {
    const root = el('div', 'w-meter w-battery'), body = el('div', 'w-batt-body'), cap = el('div', 'w-batt-cap');
    const cells = Array.from({ length: BATTERY_CELLS }, () => el('i', 'w-cell'));
    body.append(...cells); root.append(body, cap);
    return { root, update: s => { const on = Math.ceil((s.value || 0) * BATTERY_CELLS - 1e-9); cells.forEach((c, i) => c.classList.toggle('on', i < on)); } };
  }
  if (k === 'meter') {
    const root = el('div', 'w-meter w-bar'), fill = el('div', 'w-fill'), mark = el('div', 'w-mark');
    root.append(fill, mark);
    return { root, update: s => { fill.style.width = (s.value || 0) * 100 + '%'; mark.hidden = typeof s.marker !== 'number'; if (typeof s.marker === 'number') mark.style.left = s.marker * 100 + '%'; } };
  }
  if (k === 'icon') {
    const root = el('div', 'w-icon'), img = el('img', 'w-img'), text = el('span', 'w-text');
    img.alt = ''; img.draggable = false;
    root.append(img, text);
    let last = null;
    return { root, update: s => {
      const src = svgSrc(cleanSvg(s.svg || '', MAX_SVG_FILE));                       // (cleaned again here: this page draws nothing that was not)
      if (src !== last) { last = src; if (src) img.src = src; else img.removeAttribute('src'); }
      img.hidden = !src; text.textContent = s.text || ''; text.hidden = !s.text;
    } };
  }
  if (k === 'light') {
    const root = el('div', 'w-light'), dot = el('span', 'w-dot'), text = el('span', 'w-text');
    root.append(dot, text);
    return { root, update: s => { text.textContent = s.text || ''; text.hidden = !s.text; } };
  }
  const root = el('div', 'w-textonly'), text = el('span', 'w-text');
  root.append(text);
  return { root, update: s => { text.textContent = s.text || ''; } };
}

export class WidgetLayer {
  // root: the element the 8 containers are put into; defs: the Registry; `tipBox`: where the tip is written (made if not given)
  constructor({ root, registry, tipBox = null, sink = null }) {
    this.onAction = null;                                // (id, 'click' | 'menu', item?) the user used a widget of a plugin (the window passes it on)
    this.sink = sink;                                    // where the tip is drawn when not here: a window of its own { usable(), show(text, rect), hide() }
    this.root = root; this.registry = registry;
    root.classList.add('wlayer');
    this.places = new Map(ANCHORS.map(a => [a, root.appendChild(el('div', 'wa wa-' + a))]));
    this.tip = tipBox || root.appendChild(el('div', 'w-tip'));
    this.tip.hidden = true;
    this.items = new Map();                 // id -> { entry, view, node, state }
    this.states = new Map();                // id -> the last state told (kept also while the widget is off)
  }
  // the settings of the window: { id: entry } -> the widgets that are drawn (the others are taken away). -> the ids that are drawn
  set(widgets) {
    const want = drawn(widgets).filter(w => this.registry.get(w.id)), ids = new Set(want.map(w => w.id));       // (a widget nobody provides now, e.g. of a plugin that is off, is not drawn; its settings stay)
    for (const [id, it] of this.items) if (!ids.has(id)) { it.node.remove(); this.items.delete(id); }
    for (const e of want) {
      const def = this.registry.get(e.id), kind = def ? def.kind : 'text';
      const style = def && def.styles.some(s => s.id === e.style) ? e.style : (def ? def.styles[0].id : 'plain');
      let it = this.items.get(e.id);
      if (!it || it.kind !== kind || it.style !== style) {
        if (it) it.node.remove();
        const view = buildView(kind, style), node = el('div', 'widget'); node.dataset.id = e.id;
        node.addEventListener('click', ev => { const w = this.items.get(e.id); if (ev.button === 0 && w && this.clickable(w) && this.onAction) { ev.stopPropagation(); this.onAction(e.id, 'click'); } });
        node.append(view.root);
        it = { view, node, kind, style, entry: e, state: this.states.get(e.id) || null, title: def ? def.label : e.id };
        this.items.set(e.id, it);
      }
      it.entry = e;
      it.node.classList.toggle('clickable', this.clickable(it));
      this.place(it);
      this.paint(it);
    }
    return [...ids];
  }
  place(it) {
    const e = it.entry, box = this.places.get(e.anchor);
    if (it.node.parentElement !== box) box.append(it.node);
    it.node.style.setProperty('--ws', String(e.scale));
    it.node.style.transform = e.dx || e.dy ? `translate(${e.dx}px, ${e.dy}px)` : '';
    // the order inside a place: the order of the settings
    const order = [...this.items.keys()];
    [...box.children].sort((a, b) => order.indexOf(a.dataset.id) - order.indexOf(b.dataset.id)).forEach(n => box.append(n));
  }
  // may the user click this widget (a widget of a plugin that asked for it, or that has a menu)
  clickable(it) { const def = this.registry.get(it.entry.id); return !!(def && def.owner !== 'core' && (def.clickable || this.menuOf(it).length)); }
  // the items of its menu: the state's (a plugin changes them while it runs), else the definition's
  menuOf(it) { const def = this.registry.get(it.entry.id), s = it.state; return (s && Array.isArray(s.menu) ? s.menu : def && def.menu) || []; }
  // the widget an element belongs to (for the right-click menu of the window): { id, title, owner, menu, clickable } or null
  itemOf(node) {
    const w = node && node.closest ? node.closest('.widget') : null;
    const it = w && this.items.get(w.dataset.id);
    if (!it) return null;
    const def = this.registry.get(it.entry.id);
    return { id: it.entry.id, title: it.title, owner: def ? def.owner : '', menu: this.menuOf(it), clickable: this.clickable(it) };
  }
  state(id, st) {
    this.states.set(id, st);
    const it = this.items.get(id);
    if (it) { it.state = st; it.node.classList.toggle('clickable', this.clickable(it)); this.paint(it); }
  }
  paint(it) {
    const s = it.state || { active: false, value: 0, marker: null, tone: 'idle', text: '', tip: '' }, e = it.entry;
    it.view.update(s);
    it.node.dataset.tone = s.tone || 'idle';
    it.node.hidden = e.show === 'active' && !s.active;
    it.node.classList.toggle('dim', e.show === 'dim' && !s.active);
    it.node.style.opacity = String(e.opacity);
  }
  // the pointer in the window (CSS pixels, null = not in the window): the tip of the widget under it
  pointer(x, y) {
    let hit = null;
    if (x !== null && x !== undefined) for (const it of this.items.values()) {
      if (it.node.hidden) continue;
      const r = it.node.getBoundingClientRect();
      if (x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3) { hit = { it, r }; break; }
    }
    if (!hit) { this.tip.hidden = true; if (this._sunk) { this._sunk = null; this.sink.hide(); } return null; }
    const text = (hit.it.state && hit.it.state.tip) || hit.it.title;
    if (this.sink && this.sink.usable()) {
      this.tip.hidden = true;
      const key = hit.it.entry.id + '\u0000' + text;
      if (this._sunk !== key) {
        this._sunk = key;
        const r = hit.r;
        Promise.resolve(this.sink.show(text, r)).then(ok => { if (ok === false && this._sunk === key) this.placeLocal(text, r); });      // (no window of its own: drawn here)
      }
      return hit.it.entry.id;
    }
    this.placeLocal(text, hit.r);
    return hit.it.entry.id;
  }
  // the tip in this page: beside the widget, inside the window
  placeLocal(text, r) {
    if (this.tip.textContent !== text) this.tip.textContent = text;
    this.tip.hidden = false;
    const w = this.tip.offsetWidth, h = this.tip.offsetHeight, vw = innerWidth, vh = innerHeight;
    const left = Math.max(2, Math.min(vw - w - 2, r.left + r.width / 2 - w / 2));
    const top = r.top - h - 6 >= 2 ? r.top - h - 6 : Math.min(vh - h - 2, r.bottom + 6);
    this.tip.style.left = left + 'px'; this.tip.style.top = Math.max(2, top) + 'px';
  }
}
