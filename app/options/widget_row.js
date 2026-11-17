// The widgets of the 창 tab: a list of every widget on the left, the options of the chosen one on the right (docs/WIDGETS.md). A widget is turned on for THIS
// window (a switch in the list or on the right), put on a small picture of the window (8 dots inside, 8 outside) with the others of the window, and given the
// choices it declares. The settings are `widgets[id]` of the window: the same place for every widget, a plugin's too.
import { tr } from '../core/i18n.js';
import { ANCHORS, defaultEntry, normalizeEntry, normalizeWidgets, Registry } from '../widgets/registry.js';
import { WidgetLayer } from '../widgets/render.js';
import * as settings from '../settings.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const SHOW_NAME = { always: '항상 보임', active: '켜져 있을 때만 보임', dim: '꺼져 있으면 흐리게' };
// where the dots are on the picture: inside the window (x, y in %) and outside of it
const INSIDE = { 'top-left': [12, 20], top: [50, 20], 'top-right': [88, 20], left: [12, 50], right: [88, 50], 'bottom-left': [12, 80], bottom: [50, 80], 'bottom-right': [88, 80] };
const OUTSIDE = { 'top-left': [-6, -12], top: [50, -12], 'top-right': [106, -12], left: [-6, 50], right: [106, 50], 'bottom-left': [-6, 112], bottom: [50, 112], 'bottom-right': [106, 112] };
const ANCHOR_NAME = { 'top-left': '위 왼쪽', top: '위', 'top-right': '위 오른쪽', left: '왼쪽', right: '오른쪽', 'bottom-left': '아래 왼쪽', bottom: '아래', 'bottom-right': '아래 오른쪽' };
const SAMPLE = { active: true, value: 0.62, marker: 0.36, tone: 'hot', text: '듣는 중', tip: '' };
const SEL_KEY = 'cmr-widget-sel';

// -> the row of the tab (one row for all the widgets); `registry` = the definitions
export function widgetsRow(registry) {
  return { win: true, key: 'widgets', type: 'custom', block: true, label: '', keywords: '위젯 widget 막대 배터리 음량 부착 배치 위치 목록', build: ctx => panel(registry, ctx) };
}

function panel(registry, ctx) {
  const root = el('div', 'wm'), list = el('div', 'wl'), detail = el('div', 'wd');
  list.setAttribute('role', 'listbox');
  root.append(list, detail);
  const row = { win: true, key: 'widgets' };
  const all = () => normalizeWidgets(ctx.get(row, ctx.cfg()));
  const save = next => ctx.put(row, normalizeWidgets(next));
  let sel = ''; try { sel = localStorage.getItem(SEL_KEY) || ''; } catch { /* the first one */ }
  let shownDetail = null;                                       // { id, refresh } of the detail that is drawn

  // every widget of the registry, then the ones the window has settings for that nobody provides now (a plugin that was removed)
  const items = () => [...registry.list().map(d => ({ id: d.id, def: d })), ...Object.keys(all()).filter(id => !registry.get(id)).map(id => ({ id, def: null }))];
  const choose = id => { sel = id; try { localStorage.setItem(SEL_KEY, id); } catch { /* not kept */ } draw(); };

  // The list is made again only when the widgets themselves change; otherwise its lines are updated where they are (a click is a press and a release on the
  // same element, so a line must not be replaced in between; the focus stays)
  let listSig = '';
  function drawList() {
    const have = items(), on = all(), sig = have.map(x => x.id + (x.def ? '' : '!') + '|' + (x.def ? x.def.label : '')).join('\n');
    if (sig !== listSig) {
      listSig = sig;
      list.textContent = '';
      for (const it of have) {
        const row1 = el('div', 'wl-item' + (it.def ? '' : ' orphan')); row1.tabIndex = 0; row1.dataset.id = it.id; row1.setAttribute('role', 'option');
        const sw = el('label', 'switch small'), box = el('input'); box.type = 'checkbox'; sw.append(box, el('span', 'knob'));
        sw.onclick = e => e.stopPropagation();
        box.onchange = () => { const next = { ...all() }; if (box.checked) next[it.id] = defaultEntry(it.def); else delete next[it.id]; save(next); };
        if (!it.def) sw.hidden = true;
        const name = el('span', 'wl-name', it.def ? it.def.label : it.id), tags = el('span', 'wl-tags');
        if (it.def && it.def.owner !== 'core') tags.append(el('small', 'wl-badge', tr('플러그인')));
        if (!it.def) tags.append(el('small', 'wl-badge off', tr('없음')));
        row1.append(sw, name, tags);
        row1.onclick = () => choose(it.id);
        row1.onkeydown = e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(it.id); }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault(); const i = have.findIndex(x => x.id === it.id) + (e.key === 'ArrowDown' ? 1 : -1);
            if (have[i]) { choose(have[i].id); setTimeout(() => list.querySelector(`[data-id="${CSS.escape(have[i].id)}"]`)?.focus(), 0); }
          }
        };
        row1._box = box;
        list.append(row1);
      }
    }
    for (const row1 of list.children) {
      row1.classList.toggle('sel', row1.dataset.id === sel);
      row1._box.checked = !!on[row1.dataset.id];
    }
  }

  function draw() {
    const have = items();
    if (!have.some(x => x.id === sel)) sel = have.length ? have[0].id : '';
    drawList();
    const it = have.find(x => x.id === sel);
    if (!it) { detail.textContent = ''; detail.append(el('small', 'note', tr('위젯이 없습니다.'))); shownDetail = null; return; }
    if (!shownDetail || shownDetail.id !== sel || shownDetail.def !== it.def) {
      detail.textContent = '';
      shownDetail = it.def ? makeDetail(it.def) : makeOrphan(it.id);
      shownDetail.id = sel; shownDetail.def = it.def;
      detail.append(shownDetail.el);
    }
    shownDetail.refresh();
  }

  // ---- the right side for a widget that is provided
  function makeDetail(def) {
    const wrap = el('div', 'wp');
    const entry = () => all()[def.id] || null;
    const edit = patch => { const cur = entry(); if (!cur) return; save({ ...all(), [def.id]: normalizeEntry({ ...cur, ...patch }) }); };
    wrap.append(el('h4', 'wp-title', def.label));
    // on / off
    const top = el('label', 'wp-top'), sw = el('label', 'switch'), box = el('input'); box.type = 'checkbox'; sw.append(box, el('span', 'knob'));
    top.append(sw, el('span', '', tr('이 창에 표시')));
    box.onchange = () => { const next = { ...all() }; if (box.checked) next[def.id] = defaultEntry(def); else delete next[def.id]; save(next); };
    // the picture: the window in the middle with every widget of this window, 8 dots inside (the places that work) and 8 around it (waiting)
    const stage = el('div', 'wp-stage'), win = el('div', 'wp-win'), layerRoot = el('div', 'wp-layer');
    win.append(el('div', 'wp-line'), el('div', 'wp-line short'), el('div', 'wp-line'), layerRoot);
    stage.append(win);
    const dots = new Map();
    for (const a of ANCHORS) {
      const [ix, iy] = INSIDE[a], [ox, oy] = OUTSIDE[a];
      const di = el('button', 'wp-dot in'); di.type = 'button'; di.title = tr(ANCHOR_NAME[a]) + ' · ' + tr('안쪽');
      di.style.left = ix + '%'; di.style.top = iy + '%';
      di.onclick = () => { if (!entry()) save({ ...all(), [def.id]: { ...defaultEntry(def), anchor: a } }); else edit({ anchor: a, place: 'inside' }); };
      win.append(di); dots.set(a, di);
      const dout = el('span', 'wp-dot out'); dout.title = tr(ANCHOR_NAME[a]) + ' · ' + tr('바깥쪽') + ' (' + tr('준비 중') + ')'; dout.style.left = ox + '%'; dout.style.top = oy + '%';
      win.append(dout);
    }
    const caption = el('small', 'note wp-caption');
    const layer = new WidgetLayer({ root: layerRoot, registry });
    // the choices
    const form = el('div', 'wp-form');
    const field = (label, control) => { const l = el('label', 'wp-field'); l.append(el('span', '', tr(label)), control); form.append(l); return control; };
    const style = el('select'); for (const s of def.styles) { const o = el('option', '', s.label); o.value = s.id; style.append(o); }
    style.onchange = () => edit({ style: style.value });
    const show = el('select'); for (const [v, t] of Object.entries(SHOW_NAME)) { const o = el('option', '', tr(t)); o.value = v; show.append(o); }
    show.onchange = () => edit({ show: show.value });
    const numInput = (key, min, max, step) => { const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.step = step; i.onchange = () => { const v = Number(i.value); if (Number.isFinite(v)) edit({ [key]: v }); else refresh(); }; return i; };
    const dx = numInput('dx', -400, 400, 1), dy = numInput('dy', -400, 400, 1), scale = numInput('scale', 0.5, 3, 0.1);
    if (def.styles.length > 1) field('모양', style);
    field('보이는 때', show); field('가로 이동 (x)', dx); field('세로 이동 (y)', dy); field('크기 배율', scale);
    // what the widget itself declares (docs/WIDGETS.md "위젯 옵션")
    const own = new Map();
    for (const s of def.settings) {
      let c;
      const put = v => edit({ opts: { ...(entry() || {}).opts, [s.key]: v } });
      if (s.type === 'check') { c = el('input'); c.type = 'checkbox'; c.onchange = () => put(c.checked); }
      else if (s.type === 'select') { c = el('select'); for (const [v, t] of s.options) { const o = el('option', '', t); o.value = v; c.append(o); } c.onchange = () => put(c.value); }
      else if (s.type === 'color') { c = el('input'); c.type = 'text'; c.placeholder = '#rrggbb'; c.onchange = () => put(c.value.trim()); }
      else { c = el('input'); c.type = 'number'; c.min = s.min; c.max = s.max; c.step = s.step; c.onchange = () => { const v = Number(c.value); if (Number.isFinite(v)) put(v); }; }
      field(s.label, c); own.set(s.key, [s, c]);
    }
    const outsideNote = el('small', 'note', tr('바깥쪽 배치는 아직 만들지 않았습니다. 지금은 창 안쪽만 고를 수 있습니다.'));
    wrap.append(top, stage, caption, form, outsideNote);

    function refresh() {
      const e = entry(), on = !!e, here = all();
      box.checked = on;
      form.hidden = !on; stage.classList.toggle('off', !on);
      for (const [a, d] of dots) d.classList.toggle('sel', on && e.anchor === a && e.place === 'inside');
      caption.textContent = on ? tr(ANCHOR_NAME[e.anchor]) + ' · ' + tr('안쪽') : tr('꺼져 있습니다. 켜면 이 창에 붙습니다.');
      if (on) {
        if (document.activeElement !== style) style.value = def.styles.some(s => s.id === e.style) ? e.style : def.styles[0].id;
        show.value = e.show;
        for (const [i, v] of [[dx, e.dx], [dy, e.dy], [scale, e.scale]]) if (document.activeElement !== i) i.value = v;
        for (const [key, [s, c]] of own) { const v = e.opts[key] ?? s.def; if (document.activeElement !== c) { if (s.type === 'check') c.checked = !!v; else c.value = v; } }
      }
      // the picture shows every widget of this window (small, where they are), the chosen one marked, the others dim
      const shown = {};
      for (const [id, x] of Object.entries(here)) if (registry.get(id)) shown[id] = { ...x, dx: 0, dy: 0, scale: 0.55, opacity: 1, show: 'always' };
      layer.set(shown);
      for (const id of Object.keys(shown)) { layer.state(id, SAMPLE); const it = layer.items.get(id); if (it) { it.node.classList.toggle('picked', id === def.id); it.node.classList.toggle('other', id !== def.id); } }
    }
    return { el: wrap, refresh };
  }

  // ---- the right side for settings nobody provides now (the plugin is gone): they are kept, here is the way to take them away
  function makeOrphan(id) {
    const wrap = el('div', 'wp');
    wrap.append(el('h4', 'wp-title', id));
    wrap.append(el('small', 'note', tr('이 위젯을 내는 부품(플러그인)이 지금 없습니다. 설정은 남아 있어서, 그 플러그인을 다시 설치하면 그대로 쓰입니다.')));
    const del = el('button', 'btn small', tr('이 설정 지우기')); del.type = 'button';
    del.onclick = () => { const next = { ...all() }; delete next[id]; save(next); };
    wrap.append(del);
    return { el: wrap, refresh() {} };
  }

  draw();
  // follows the settings and the registry while it is on the screen; a part of an earlier drawing is dropped
  const stop = () => { offS(); offR(); };
  const live = () => { if (!root.isConnected && root.dataset.seen) { stop(); return false; } if (root.isConnected) root.dataset.seen = '1'; return true; };
  const offS = settings.onChange(() => { if (live()) draw(); });
  const offR = registry.onChange(() => { if (live()) draw(); });
  return root;
}
