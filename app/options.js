// The options window: side menu, search, the tabs (options/*.js). Every change is applied at once: this window asks the hub (the owner of
// config.json) to change the settings, and every window follows. What was changed since this window was opened is shown and can be taken
// back (one row, or everything).
import * as settings from './settings.js';
import { startI18n } from './i18n_host.js';
import { listForOptions as fontsScan } from './fonts.js';
import { tr } from './core/i18n.js';
import { nameFor } from './winname.js';
import * as layout from './core/winlayout.js';
import { DEFAULTS } from './core/config.js';
import { FOLLOW, KEYS, MAIN_KEY, HOST_KEYS, followsMain, followValue, dockHost } from './core/winconf.js';
import { buildCards, isData } from './options/form.js';
import { TABS } from './options/tabs.js';
import { noteChannelColor } from './options/channels.js';
import { registry as widgetRegistry } from './widgets/defaults.js';
import { syncPluginDefs } from './widgets/registry.js';

await settings.load({ readOnly: true });
await startI18n(settings);
await fontsScan();
const snapshot = structuredClone(settings.cfg());

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- scope: where a row's value lives
// A row with `win: true` belongs to one window. Window 1 (main): the top level of the config, a few under another name (MAIN_KEY), the
// shown channels as the opposite list `win1_off`. An extra window: its entry in `child_windows`; the keys in FOLLOW it does not have of its
// own are window 1's (shown with "창 1을 따름").
const conf = (cfg, wid) => cfg.child_windows.find(c => c.id === wid);
const topKey = row => MAIN_KEY[row.key] || row.key;

function value(row, cfg, wid) {
  if (!row.win) return row.get ? row.get(cfg) : cfg[row.key];
  if (wid === 1) return row.type === 'channels' ? row.codes.filter(c => !(cfg.win1_off || []).includes(c)) : cfg[topKey(row)];
  const c = conf(cfg, wid);
  if (!c) return undefined;
  if (followsMain(c, row.key)) return null;                      // null: it has no value of its own, it follows window 1 (the row shows that)
  const v = c[row.key];
  return v === undefined ? (row.key in KEYS ? KEYS[row.key] : DEFAULTS[row.key]) : v;     // (a switch the entry does not have: its default, as the window uses)
}
function patchFor(row, v, wid, cfg) {
  if (!row.win) return row.patch ? row.patch(cfg, v) : { [row.key]: v };
  if (wid === 1) return row.type === 'channels' ? { win1_off: row.codes.filter(c => !v.includes(c)) } : { [topKey(row)]: v };
  return { child_windows: cfg.child_windows.map(c => {
    if (c.id !== wid) return c;
    if (FOLLOW.has(row.key) && (v === null || v === undefined)) {                  // (null = "follow window 1")
      const fv = followValue(row.key), d = { ...c };
      if (fv === 'delete') delete d[row.key]; else d[row.key] = fv;
      return d;
    }
    return { ...c, [row.key]: v };
  }) };
}
const sameVal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let selected = 1;                                    // the window the 창 tab shows
const ctxFor = wid => ({
  sel: wid, cfg: () => settings.cfg(), snapshot,
  dockHost: () => (wid > 1 ? dockHost(settings.cfg().child_windows, wid) : 0), nameOf: id => nameFor(settings.cfg(), id),
  get: (row, cfg = settings.cfg()) => value(row, cfg, wid),
  set: patch => settings.request(patch),
  put: (row, v) => settings.request(patchFor(row, v, wid, settings.cfg())),
  def: row => (!row.win ? (row.def ?? DEFAULTS[row.key])
    : row.type === 'channels' ? [...row.codes]
    : wid === 1 ? (row.def ?? DEFAULTS[topKey(row)]) : (row.key in KEYS ? KEYS[row.key] : DEFAULTS[row.key])),
  canFollow: row => !!row.win && wid !== 1 && FOLLOW.has(row.key),
  following: row => {
    if (!row.win || wid === 1 || !FOLLOW.has(row.key)) return undefined;
    const c = conf(settings.cfg(), wid);
    return !c || followsMain(c, row.key);
  },
  mainValue: row => settings.cfg()[topKey(row)],           // window 1's value of a row (what an extra window that follows it has)
  reset(row) {
    if (this.canFollow(row)) this.put(row, null);                                          // back to "follow window 1"
    else this.put(row, structuredClone(this.def(row)));
  },
  known: row => !row.win || wid === 1 || !!conf(snapshot, wid),
});
const ctx = ctxFor(1);
window.__cmrTuning = () => settings.cfg().tuning;                 // (the live table of the 고급 tab shows the periods in use)

// every (row, window) the user changed since this window opened
const flat = TABS.flatMap(t => t.cards.flatMap(c => c.rows.filter(r => isData(r)).map(r => ({ row: r, tab: t, card: c }))));
function changedList() {
  const out = [], cfg = settings.cfg();
  const wids = [1, ...cfg.child_windows.map(c => c.id)];
  for (const f of flat) for (const wid of (f.row.win ? wids : [0])) {
    const x = ctxFor(wid);
    if (x.known(f.row) && !sameVal(x.get(f.row, cfg), x.get(f.row, snapshot))) out.push({ ...f, wid });
  }
  return out;
}
const winName = wid => nameFor(settings.cfg(), wid);

let built = [];                       // the rows on screen
let view = { mode: 'tab', tab: TABS[0].id };
let query = '';
const ctxNow = () => ctxFor(selected);
const cardTitle = (t, c, wid) => `${t.title} › ${c.title || ''}${wid ? ' · ' + winName(wid) : ''}`;

// ---------------------------------------------------------------- the views
function show() {
  const body = $('body'), head = $('head');
  body.textContent = ''; built = [];
  const tab = TABS.find(t => t.id === view.tab);
  const empty = text => body.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: text }));
  if (view.mode === 'search') {
    head.textContent = tr('검색: {q}', { q: query });
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    let n = 0;
    for (const t of TABS) for (const c of t.cards) {
      const rows = c.rows.filter(r => tokens.every(k => [t.title, c.title, r.label, [].concat(r.note || '').join(' '), r.keywords, r.key].join(' ').toLowerCase().includes(k)));
      if (!rows.length) continue;
      n += rows.length;
      const win = rows.some(r => r.win);
      built.push(...buildCards([{ title: cardTitle(t, c, win ? selected : 0), rows }], win ? ctxNow() : ctx, body));
    }
    if (!n) empty('찾는 항목이 없습니다.');
  } else if (view.mode === 'changed') {
    head.textContent = '이번에 바꾼 것';
    const list = changedList(), groups = new Map();
    for (const it of list) { const k = it.tab.id + '|' + it.card.title + '|' + it.wid; if (!groups.has(k)) groups.set(k, { ...it, rows: [] }); groups.get(k).rows.push(it.row); }
    for (const g of groups.values()) built.push(...buildCards([{ title: cardTitle(g.tab, g.card, g.row.win ? g.wid : 0), rows: g.rows }], g.row.win ? ctxFor(g.wid) : ctx, body));
    if (!list.length) empty('바꾼 항목이 없습니다.');
  } else {
    head.textContent = tab.title;
    if (tab.todo) empty('이 탭은 아직 만들지 않았습니다.');
    if (tab.toolbar) {
      const tb = tab.toolbar({ cfg: () => settings.cfg(), sel: () => selected, select: id => { selected = id; show(); } });
      body.append(tb.el); built.push(tb);
    }
    built.push(...buildCards(tab.cards, ctxNow(), body, { fold: true }));
  }
  $('sub').textContent = view.mode === 'tab' ? tab.subtitle || '' : '';
  $('tester').hidden = !(view.mode === 'tab' && tab.test);
  $('testOut').hidden = $('tester').hidden || !$('testOut').textContent;
  refresh();
}

function refresh() {
  for (const b of built) b.refresh();
  const list = changedList();
  $('changed').hidden = list.length === 0;
  $('changedCount').textContent = list.length;
  $('changedBtn').classList.toggle('on', view.mode === 'changed');
  for (const li of $('tabs').children) {
    const t = TABS.find(x => x.id === li.dataset.id);
    li.querySelector('.badge').textContent = list.filter(it => it.tab === t).length || '';
    li.classList.toggle('active', view.mode === 'tab' && view.tab === t.id);
    li.classList.toggle('dot', !!(t.dot && t.dot(settings.cfg())));
  }
}

function go(next) { view = next; if (view.mode !== 'search') { query = ''; $('q').value = ''; } show(); }

// ---------------------------------------------------------------- side menu, search, revert
for (const t of TABS) {
  const li = document.createElement('li');
  li.dataset.id = t.id; li.classList.toggle('todo', !!t.todo);
  li.innerHTML = '<span class="name"></span><span class="badge"></span>';
  li.querySelector('.name').textContent = t.title;
  li.onclick = () => go({ mode: 'tab', tab: t.id });
  $('tabs').append(li);
}
$('q').oninput = () => {
  query = $('q').value.trim();
  if (query) { view = { mode: 'search' }; show(); }
  else go({ mode: 'tab', tab: view.tab || TABS[0].id });
};
$('q').onkeydown = e => { if (e.key === 'Escape' && $('q').value) { e.stopPropagation(); $('q').value = ''; $('q').oninput(); } };
$('changedBtn').onclick = () => go(view.mode === 'changed' ? { mode: 'tab', tab: TABS[0].id } : { mode: 'changed' });
$('revertAll').onclick = () => {
  const before = settings.cfg(), work = structuredClone(before);
  for (const it of changedList()) {
    const x = ctxFor(it.wid), v = structuredClone(x.get(it.row, snapshot));
    if (it.row.win && it.wid !== 1) {                                 // the entry as it was (also "no own value")
      const c = conf(snapshot, it.wid), mine = conf(work, it.wid);
      if (FOLLOW.has(it.row.key) && (c[it.row.key] === undefined || c[it.row.key] === null)) delete mine[it.row.key]; else mine[it.row.key] = v;
    } else Object.assign(work, patchFor(it.row, v, it.wid, work));
  }
  const patch = {};
  for (const k of Object.keys(work)) if (!sameVal(work[k], before[k])) patch[k] = work[k];
  settings.request(patch);
  if (view.mode === 'changed') go({ mode: 'tab', tab: TABS[0].id });
};

settings.onChange(() => refresh());
{ const { emit, listen } = window.__TAURI__.event; listen('widget-defs', e => syncPluginDefs(widgetRegistry, e.payload.defs)); emit('widget-defs-hello', {}); }          // (the widgets of the plugins are in the list of the widgets)
const showTitle = () => { try { window.__TAURI__.window.getCurrentWindow().setTitle(tr('ChatMatrix 옵션')).catch(() => {}); } catch { /* no such window function */ } };
showTitle(); addEventListener('cmr-language', showTitle);
try { window.__TAURI__.window.getCurrentWindow().setAlwaysOnTop(false).catch(() => {}); } catch { /* no window api */ }   // (an ordinary window: never above the others)
document.addEventListener('cmr-show-tab', e => { if (TABS.some(t => t.id === e.detail) && !(view.mode === 'tab' && view.tab === e.detail)) go({ mode: 'tab', tab: e.detail }); });       // (a window of a tab asks for its tab: the plugin that wants to be approved)
addEventListener('cmr-language', () => show());      // the texts that are put together while running
// ---------------------------------------------------------------- the place and size of this window: restored when it opens, saved when it stood still
{
  const { emit } = window.__TAURI__.event, invoke = window.__TAURI__.core.invoke;
  const win = window.__TAURI__.window.getCurrentWindow();
  let last = '', since = 0, sent = '';
  const read = async () => { try { const s = await invoke('os_state', { keys: [] }); return s.win; } catch { return null; } };
  const report = async () => { const r = await read(); if (r && r[0] > -30000 && r[2] >= 200) emit('options-geometry', { geometry: layout.formatGeometry(r[2], r[3], r[0], r[1]) }); };
  (async () => {
    try {
      const g = layout.parseGeometry(settings.cfg().options_geometry);
      if (g && g.x !== null) {
        const [sx, sy, sw, sh] = await invoke('screen_rect');
        const x = Math.min(Math.max(g.x, sx - g.w + 120), sx + sw - 120), y = Math.min(Math.max(g.y, sy), sy + sh - 80);       // (a screen that is gone: still reachable)
        await invoke('set_window_rect', { x, y, w: g.w, h: g.h });
      }
    } catch { /* the default place */ }
    try { await win.show(); } catch { /* the exe shows it after a while anyway */ }
    invoke('raise_self').catch(() => {});                              // (shown from the hotkey or the gear while the game is in front: it must not stay behind)
    for (;;) {
      await new Promise(r => setTimeout(r, 150));
      const r = await read(); if (!r || r[0] < -30000) continue;
      const text = r.join(',');
      if (text !== last) { last = text; since = performance.now(); continue; }
      if (text !== sent && performance.now() - since > 300) { sent = text; report(); }
    }
  })();
  // Esc closes the window (what is typed in a field is kept first); in the search field Esc clears the text first
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.activeElement === $('q') && $('q').value) return;
    document.activeElement?.blur?.();
    report().finally(() => setTimeout(() => win.close(), 30));
  });
}

// ---------------------------------------------------------------- the end of the program
$('quitBtn').onclick = () => window.__TAURI__.core.invoke('quit_request').catch(() => {});

// ---------------------------------------------------------------- the translation test (tabs with `test: true`): what the settings do now, and how fast
{
  const { emit, listen } = window.__TAURI__.event;
  const input = $('testText'), out = $('testOut'), KEY = 'cmr-test-text';
  try { input.value = localStorage.getItem(KEY) || 'LFM tank for mythic, need inv pls'; } catch { input.value = 'LFM tank for mythic, need inv pls'; }
  let testId = 0;
  const run = () => {
    const text = input.value.trim();
    if (!text) return;
    try { localStorage.setItem(KEY, text); } catch { /* not kept */ }
    testId++; out.hidden = false; out.className = 'wait'; out.textContent = tr('번역 중…'); out.title = '';
    emit('rpc-test', { id: testId, text });
  };
  $('testBtn').onclick = run;
  input.onkeydown = e => { if (e.key === 'Enter') run(); };
  listen('feed', ev => noteChannelColor(ev.payload && ev.payload.event));                 // (the colours the game has for the channels: the names in the lists)
  listen('z-done', () => {                                       // a translation window changed its stack place: the window that asked takes the focus back
    if (performance.now() - (window.__cmrRefocus || -1e9) < 4000) { window.__cmrRefocus = 0; try { window.__TAURI__.window.getCurrentWindow().setFocus().catch(() => {}); } catch { /* no window api */ } }
  });
  listen('rpc-test-result', ev => {
    const r = ev.payload;
    if (r.id !== testId) return;
    out.className = r.error ? 'err' : 'ok';
    out.textContent = r.error ? `✖ ${r.error}  (${r.ms}ms)` : `${r.text}  (${r.ms}ms · ${r.who})`;
    out.title = out.textContent;
  });
}

// ---------------------------------------------------------------- "options of this window" from a translation window's menu: the window is picked here
{
  const KEY = 'cmr-options-win';
  const take = () => {
    let id = 0;
    try { id = parseInt(localStorage.getItem(KEY) || '0', 10) || 0; localStorage.removeItem(KEY); } catch { /* none */ }
    if (id) { selected = id; go({ mode: 'tab', tab: 'windows' }); }
  };
  addEventListener('storage', e => { if (e.key === KEY && e.newValue) take(); });
  take();
}
addEventListener('contextmenu', e => { if (!['INPUT', 'TEXTAREA'].includes(e.target.tagName)) e.preventDefault(); });
show();
