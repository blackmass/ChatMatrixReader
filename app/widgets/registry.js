// Widgets: the small parts that are put on a window (docs/WIDGETS.md). No window code here: the definitions, the settings of a window (read
// and checked), and the state store. A widget is DATA: a definition (kind, looks, its own options) and a state (value, tone, text); only the host draws it.
export const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right'];
export const PLACES = ['inside', 'outside'];                                  // (outside: not drawn yet, but saved, so it does not change later)
export const SHOWS = ['always', 'active', 'dim'];
export const TONES = ['idle', 'busy', 'ok', 'hot', 'warn', 'bad'];            // names, not colours: the colours are the host's (the theme)
export const SETTING_TYPES = ['number', 'select', 'check', 'color'];
export const MAX_WIDGETS = 32;

// what the host can draw; an unknown kind is drawn as "text"
export const KINDS = {
  meter: { styles: ['bar', 'battery'] },
  light: { styles: ['dot'] },
  text: { styles: ['plain'] },
};

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,99}:[a-z0-9][a-z0-9_.-]{0,47}$/i;         // owner:name (the owner of a plugin's widget is the id of the plugin: up to 100)

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// ---- definitions
// -> a clean definition, or an Error that says what is wrong (the registry refuses a wrong one, so that the options never draw garbage)
export function checkDef(def) {
  if (!isObj(def)) throw new Error('definition is not an object');
  if (typeof def.id !== 'string' || !ID_RE.test(def.id)) throw new Error('widget id must look like owner:name');
  const owner = def.id.split(':')[0];
  if (def.owner !== undefined && def.owner !== owner) throw new Error('the owner of the id and of the definition differ');
  const kind = Object.hasOwn(KINDS, def.kind) ? def.kind : 'text';
  const known = KINDS[kind].styles;
  let styles = (Array.isArray(def.styles) ? def.styles : []).filter(s => isObj(s) && /^[a-z0-9_-]{1,24}$/i.test(s.id || '') && known.includes(s.id)).slice(0, 8)
    .map(s => ({ id: s.id, label: str(s.label, 40) || s.id }));
  if (!styles.length) styles = [{ id: known[0], label: known[0] }];
  const settings = [];
  for (const s of (Array.isArray(def.settings) ? def.settings : []).slice(0, 12)) {
    if (!isObj(s) || !/^[a-z0-9_]{1,24}$/i.test(s.key || '') || !SETTING_TYPES.includes(s.type)) continue;
    const e = { key: s.key, type: s.type, label: str(s.label, 60) || s.key, note: str(s.note, 200) };
    if (s.type === 'number') { e.min = num(s.min, -1e6, 1e6, 0); e.max = num(s.max, e.min, 1e6, e.min + 100); e.step = num(s.step, 0.001, 1000, 1); e.def = num(s.def, e.min, e.max, e.min); e.unit = str(s.unit, 8); }
    else if (s.type === 'select') {
      e.options = (Array.isArray(s.options) ? s.options : []).filter(o => Array.isArray(o) && o.length >= 2).slice(0, 16).map(o => [str(String(o[0]), 24), str(String(o[1]), 40)]);
      if (!e.options.length) continue;
      e.def = e.options.some(o => o[0] === s.def) ? s.def : e.options[0][0];
    } else if (s.type === 'check') e.def = !!s.def;
    else e.def = /^#[0-9a-f]{6}$/i.test(s.def || '') ? s.def.toLowerCase() : '';
    settings.push(e);
  }
  const hint = isObj(def.hint) ? { place: PLACES.includes(def.hint.place) ? def.hint.place : 'inside', anchor: ANCHORS.includes(def.hint.anchor) ? def.hint.anchor : 'bottom-right' } : { place: 'inside', anchor: 'bottom-right' };
  return { id: def.id, owner, label: str(def.label, 60) || def.id, kind, styles, settings, hint };
}

export class Registry {
  constructor() { this.defs = new Map(); this.subs = new Set(); }
  // the lists on the screen follow it (a plugin that registers a widget while the options are open)
  onChange(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  register(def) { const d = checkDef(def); this.defs.set(d.id, d); this.subs.forEach(f => f()); return d; }
  unregister(id) { const had = this.defs.delete(id); if (had) this.subs.forEach(f => f()); return had; }
  get(id) { return this.defs.get(id) || null; }
  list() { return [...this.defs.values()]; }
}

// The definitions the plugins have registered (the hub keeps them and tells every page): the registry of a page gets exactly these besides its own (core:) ones.
export function syncPluginDefs(registry, defs) {
  const want = new Map((Array.isArray(defs) ? defs : []).filter(d => d && typeof d.id === 'string' && !d.id.startsWith('core:')).map(d => [d.id, d]));
  for (const d of registry.list()) if (d.owner !== 'core' && !want.has(d.id)) registry.unregister(d.id);
  for (const d of want.values()) { const have = registry.get(d.id); if (!have || JSON.stringify(have) !== JSON.stringify(checkSafe(d))) { try { registry.register(d); } catch { /* a wrong definition is not shown */ } } }
}
const checkSafe = d => { try { return checkDef(d); } catch { return null; } };

// ---- the settings of a window: { id: entry }
export function normalizeEntry(e) {
  if (!isObj(e)) return null;
  const opts = {};
  if (isObj(e.opts)) for (const [k, v] of Object.entries(e.opts).slice(0, 16)) {
    if (!/^[a-z0-9_]{1,24}$/i.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) opts[k] = v; else if (typeof v === 'boolean') opts[k] = v; else if (typeof v === 'string') opts[k] = v.slice(0, 64);
  }
  return {
    place: PLACES.includes(e.place) ? e.place : 'inside',
    anchor: ANCHORS.includes(e.anchor) ? e.anchor : 'bottom-right',
    dx: Math.round(num(e.dx, -400, 400, 0)), dy: Math.round(num(e.dy, -400, 400, 0)),
    style: typeof e.style === 'string' && /^[a-z0-9_-]{1,24}$/i.test(e.style) ? e.style : '',
    show: SHOWS.includes(e.show) ? e.show : 'always',
    scale: Math.round(num(e.scale, 0.5, 3, 1) * 100) / 100, opacity: Math.round(num(e.opacity, 0.2, 1, 1) * 100) / 100,
    opts,
  };
}
// Unknown widgets are KEPT (a plugin that is off or removed keeps its settings); a wrong id or entry is dropped.
export function normalizeWidgets(w) {
  const out = {};
  if (!isObj(w)) return out;
  for (const [id, e] of Object.entries(w)) {
    if (Object.keys(out).length >= MAX_WIDGETS) break;
    if (!ID_RE.test(id)) continue;
    const n = normalizeEntry(e);
    if (n) out[id] = n;
  }
  return out;
}
// the entry a widget gets when it is turned on (the definition may suggest where)
export function defaultEntry(def) {
  return normalizeEntry({ place: def.hint.place, anchor: def.hint.anchor, style: def.styles[0].id, opts: Object.fromEntries(def.settings.map(s => [s.key, s.def])) });
}
// the widgets that are drawn in a window (inside the window; "outside" waits)
export const drawn = widgets => Object.entries(normalizeWidgets(widgets)).filter(([, e]) => e.place === 'inside').map(([id, e]) => ({ id, ...e }));
// the ids a window of the config shows (the main window: cfg.widgets; an extra window: its own): what the hub keeps the states up to date for
export function usedIds(cfg) {
  const ids = new Set();
  for (const w of [cfg && cfg.widgets, ...((cfg && cfg.child_windows) || []).map(c => c && c.widgets)]) for (const x of drawn(w)) ids.add(x.id);
  return ids;
}

// ---- the state of a widget (what the host draws)
export function cleanState(p) {
  const s = {};
  if (!isObj(p)) return s;
  if ('active' in p) s.active = !!p.active;
  if ('value' in p) s.value = num(p.value, 0, 1, 0);
  if ('marker' in p) s.marker = p.marker === null ? null : num(p.marker, 0, 1, 0);
  if ('tone' in p) s.tone = TONES.includes(p.tone) ? p.tone : 'idle';
  if ('text' in p) s.text = str(p.text, 40);
  if ('tip' in p) s.tip = str(p.tip, 400);
  if ('count' in p) s.count = Math.round(num(p.count, 0, 99999, 0));
  return s;
}
export class StateStore {
  constructor() { this.map = new Map(); }
  // merges a change; -> the new state, or null when nothing changed
  set(id, patch) {
    const c = cleanState(patch), old = this.map.get(id) || { active: false, value: 0, marker: null, tone: 'idle', text: '', tip: '' };
    const next = { ...old, ...c };
    if (JSON.stringify(next) === JSON.stringify(this.map.get(id))) return null;
    this.map.set(id, next);
    return next;
  }
  get(id) { return this.map.get(id) || null; }
  all() { return Object.fromEntries(this.map); }
}
