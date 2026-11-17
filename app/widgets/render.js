// The widgets in a window page: the 8 inside places are containers, a widget is drawn by its kind, a state changes its look, and the tip is shown while
// the pointer is over it. No data of its own: it is given the settings (`set`), the states (`state`) and the pointer (`pointer`).
// The pointer comes from the window loop (the system's cursor position), not from mouse events: it also works while the window is click-through.
import { ANCHORS, KINDS, drawn } from './registry.js';

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
  constructor({ root, registry, tipBox = null }) {
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
    const want = drawn(widgets), ids = new Set(want.map(w => w.id));
    for (const [id, it] of this.items) if (!ids.has(id)) { it.node.remove(); this.items.delete(id); }
    for (const e of want) {
      const def = this.registry.get(e.id), kind = def ? def.kind : 'text';
      const style = def && def.styles.some(s => s.id === e.style) ? e.style : (def ? def.styles[0].id : 'plain');
      let it = this.items.get(e.id);
      if (!it || it.kind !== kind || it.style !== style) {
        if (it) it.node.remove();
        const view = buildView(kind, style), node = el('div', 'widget'); node.dataset.id = e.id;
        node.append(view.root);
        it = { view, node, kind, style, entry: e, state: this.states.get(e.id) || null, title: def ? def.label : e.id };
        this.items.set(e.id, it);
      }
      it.entry = e;
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
  state(id, st) {
    this.states.set(id, st);
    const it = this.items.get(id);
    if (it) { it.state = st; this.paint(it); }
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
    if (!hit) { this.tip.hidden = true; return null; }
    const text = (hit.it.state && hit.it.state.tip) || hit.it.title;
    if (this.tip.textContent !== text) this.tip.textContent = text;
    this.tip.hidden = false;
    // beside the widget, inside the window
    const w = this.tip.offsetWidth, h = this.tip.offsetHeight, vw = innerWidth, vh = innerHeight;
    const left = Math.max(2, Math.min(vw - w - 2, hit.r.left + hit.r.width / 2 - w / 2));
    const top = hit.r.top - h - 6 >= 2 ? hit.r.top - h - 6 : Math.min(vh - h - 2, hit.r.bottom + 6);
    this.tip.style.left = left + 'px'; this.tip.style.top = Math.max(2, top) + 'px';
    return hit.it.entry.id;
  }
}
