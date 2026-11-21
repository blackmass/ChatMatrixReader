// One translation window. It draws the events the hub sends (hub.js): its own WindowFeed decides which blocks this window shows,
// ChatView draws them. The window with the label "main" also owns the send hotkey.
import * as settings from './settings.js';
import { startI18n } from './i18n_host.js';
import { tr } from './core/i18n.js';
import { windowTitle, windowName, nameFor } from './winname.js';
import { ChatView, lookFrom } from './chatview.js';
import { PageView } from './pageview.js';
import { WindowFeed } from './core/windowfeed.js';
import { MAIN } from './core/pipeline.js';
import * as winconf from './core/winconf.js';
import * as layout from './core/winlayout.js';
import * as fonts from './fonts.js';
import { isMac } from './platform.js';
import { T, every } from './core/timings.js';
import { WidgetLayer } from './widgets/render.js';
import { defaultRegistry } from './widgets/defaults.js';
import { syncPluginDefs } from './widgets/registry.js';
import { report, add as perfAdd } from './core/perf.js';
import { popup } from './popup_host.js';

const label = thisWin.label;
const wid = layout.widOf(label) || MAIN;                           // "main" = 1, "win<id>" = the id of the extra window
let cfg = await settings.load({ readOnly: true });
await startI18n(settings);
// the settings of this window: the main window's are at the top of the config, an extra window's in its entry of child_windows (live:
// the options window changes them while the window is open). A setting an extra window has no value of its own for is the main window's.
const fallback = winconf.newConf(wid, [...winconf.KNOWN, winconf.ETC]);
// the name in the tab of our own title bar (the window itself has no native title bar and is not in the taskbar); the title of the page keeps "ChatMatrix - <name>"
function showTitle() {
  showTabs();
  document.title = windowTitle(wid, wid === MAIN ? { name: cfg.main_name } : cfg.child_windows.find(x => x.id === wid));
}
const conf = () => (wid === MAIN ? null : cfg.child_windows.find(c => c.id === wid) || fallback);
const opt = (key, dflt) => (wid === MAIN ? (cfg[winconf.MAIN_KEY[key] || key] ?? dflt) : winconf.opt(conf(), cfg, key, dflt));
// The panes: this window's own chat and the windows that are TABS of it (their option "탭으로 합칠 창", core/winconf.js dockHost). Each pane has its own lines, its own
// ChatView and its own WindowFeed (its settings: the font, the channels ...); one of them is shown. What belongs to the WINDOW (place, background, mouse ...: winconf.HOST_KEYS)
// is this window's, whatever the pane.
const paneConf = id => (id === MAIN ? null : cfg.child_windows.find(c => c.id === id) || winconf.newConf(id, [...winconf.KNOWN, winconf.ETC]));
const popt = (id, key, dflt) => (id === wid || winconf.HOST_KEYS.has(key) ? opt(key, dflt)
  : id === MAIN ? (cfg[winconf.MAIN_KEY[key] || key] ?? dflt) : winconf.opt(paneConf(id), cfg, key, dflt));
const panes = [];
function makePane(id) {
  let el = id === wid ? document.getElementById('lines') : null;
  if (!el) { el = document.createElement('div'); el.id = 'lines-' + id; el.dataset.notr = ''; document.getElementById('lines').after(el); }
  el.classList.add('lines');
  const pc = id === MAIN ? null : cfg.child_windows.find(c => c.id === id && c.kind === 'page') || null;          // a window of a plugin: its page instead of the chat
  const p = { id, el, view: pc ? new PageView(el) : new ChatView(el), feed: new WindowFeed(id, () => cfg, () => paneConf(id)), tab: null, alert: false, seen: 0, firstLive: Infinity, replay: true };
  panes.push(p);
  if (pc) startPage(p, pc);
  return p;
}

// The page of a plugin window: a sandboxed frame at the address of the plugin (the hub gives the secret part only while the plugin runs and may have the window); the calls of the page
// go to the hub by events and its answers come back the same way (the bridge of the plugin checks everything), like the options page of a plugin.
function startPage(p, pc) {
  const frame = document.createElement('iframe'), from = 'win:' + p.id, BASE = isMac ? 'cmrplug://localhost/' : 'http://cmrplug.localhost/';
  frame.className = 'pl-page'; frame.setAttribute('sandbox', 'allow-scripts');
  p.el.classList.add('page'); p.el.append(frame);
  const post = msg => { try { frame.contentWindow.postMessage(msg, '*'); } catch { /* gone */ } };
  const ask = (method, args, seq) => emit('plugin-ui', { id: pc.owner, name: pc.owner_win, from, seq, method, args });
  addEventListener('message', e => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.cmr !== 1) return;
    if (m.event === 'hello') { ask('options.get', {}, -1); return; }                      // (the options the plugin asks for come as an event: seq -1)
    if (typeof m.id === 'number' && m.id >= 0 && typeof m.method === 'string') ask(m.method, m.args, m.id);
  });
  listen('plugin-ui-reply', e => {
    const r = e.payload;
    if (r.from !== from) return;
    if (r.seq === -1) { if (r.ok) post({ cmr: 1, event: 'options', value: r.value }); return; }
    post(r.ok ? { cmr: 1, id: r.seq, ok: true, value: r.value } : { cmr: 1, id: r.seq, ok: false, error: r.error });
  });
  listen('plugin-page-reply', e => {
    if (e.payload.from !== from) return;
    if (!e.payload.token) { p.el.append(Object.assign(document.createElement('div'), { className: 'pl-page-off', textContent: tr('플러그인이 꺼져 있습니다') })); frame.hidden = true; return; }
    frame.src = BASE + e.payload.token + '/' + pc.page;
  });
  emit('plugin-page', { from, owner: pc.owner, name: pc.owner_win });
  settings.onChange(() => ask('options.get', {}, -1));                                     // (the options of the plugin changed: the page is told)
}
const host = makePane(wid);
let active = host, view = host.view, feed = host.feed;               // (of the pane that is shown)
const widgetRegistry = defaultRegistry();                            // (the program's own widgets; what the plugins register comes by 'widget-defs')
const widgetLayer = new WidgetLayer({ root: document.getElementById('widgets'), registry: widgetRegistry });
let widgetIds = '';
window.__cmrWidgets = widgetLayer;
widgetLayer.onAction = (id, type, item) => emit('widget-action', { id, type, ...(item ? { item } : {}) });                                   // (for the tests)
// the widgets of this window (docs/WIDGETS.md): drawn from the settings; a widget that is turned on asks the hub for its state
const apply = ops => view.apply(ops, feed.model);
const note = text => host.view.apply(host.feed.model.addNote(text, 'system'), host.feed.model);       // (the notes of the window are in its own pane)

let interactive = null, geometryReady = false, hovering = false;
let gameFound = true;                                               // no game = the window stays in view: nothing to click through to
let reviewShown = false, wheelCount = 0, nativeWheel = 0, zoneMode = '', zoneKey = '';                                                  // (turns of the wheel up that were taken from the game: for the diagnosis)
let review = false, reviewIdle = 0, wheelSeq = 0, resizing = false;               // reading the old chat while the window is click-through (wheel up over it)
let blurKey = JSON.stringify([0, 0]);

function syncBlur() {
  const r = document.documentElement.style;
  const blur = Number(opt('blur', 0)) || 0;                         // 0 off | 1 weak | 2 strong
  const bg = Number(opt('bg_opacity', 1));
  const shown = blur && !hovering && !resizing;                                  // while the window is cleared by the mouse, the blur behind it goes too
  // the colour of the background is always the page's own layer (#bg: it starts under the tabs); the system only blurs (a tint of almost nothing is left, some systems need one)
  r.setProperty('--bg-alpha', bg);
  const key = JSON.stringify([shown ? blur : 0]);
  if (key !== blurKey) {
    blurKey = key;
    invoke('set_blur', { on: !!shown, state: blur === 2 ? 4 : 3, color: '#1e1f22', alpha: 0.004 })
      .then(ok => { if (shown && !ok) note(tr('블러: 윈도우가 거부함')); })
      .catch(e => note(tr('블러: {e}', { e })));
  }
}

function applyWidgets() {
  const ids = widgetLayer.set(wid === MAIN ? cfg.widgets : (conf() || {}).widgets);
  const key = ids.join(',');
  if (key !== widgetIds) { widgetIds = key; if (ids.length) emit('widget-hello', { ids }); }
}

function applyAll() {
  syncBlur();
  applyWidgets();
  // not click-through: the title bar is always there, so one empty line is kept above the first message (it scrolls away with the rest)
  syncPanes();
  for (const p of panes) p.el.classList.toggle('cv-pad', !opt('click_through', false));
  // "온전한 묶음만": a window that is not click-through always has its title bar over the top of the lines, so the groups are judged by the edge BELOW it. A click-through window
  // is judged by the top of the lines, also while the bar shows for a moment (a key held, the game gone): the groups do not jump.
  const barH = parseFloat(getComputedStyle(document.body).getPropertyValue('--bar-h')) || 22;
  for (const k of ['tools', 'tabs', 'frame']) document.body.classList.toggle('hide-' + k, !!opt('hide_' + k, false));      // ("평소에 인터페이스 숨기기": they show while the mouse is in the window)
  for (const p of panes) {
    p.view.inset = opt('click_through', false) || barGone ? 0 : Math.max(0, barH - p.el.getBoundingClientRect().top);
    const look = lookFrom((k, d) => popt(p.id, k, d));
    if (look.family && !fonts.known.some(k => k.family === look.family) && Date.now() - fontScan > 3000) {   // a font file may have been put into fonts/ meanwhile
      fontScan = Date.now();
      fonts.loadAll().then(fam => { if (fam.includes(look.family)) applyAll(); }).catch(() => {});
    }
    p.view.setLook(look, p.feed.model);
    p.view.apply(p.feed.applySettings(), p.feed.model);
  }
  showTabs();
  interactive = null;                                               // click-through may have changed
  applyZ();
}
let fontScan = 0;
// the bar is not seen: the mouse is out of the window and both the tabs and the icons are set to hide (and no tab has a mark): the lines are whole up to the top, like in a
// click-through window (the room under the bar stays; only what the bar would cover is not taken away)
let barGone = false;
function syncBarGone() {
  const gone = document.body.classList.contains('outside') && !!opt('hide_tools', false) && !!opt('hide_tabs', false) && !panes.some(p => p.alert && p !== active);
  if (gone === barGone) return;
  barGone = gone;
  const barH = parseFloat(getComputedStyle(document.body).getPropertyValue('--bar-h')) || 22;
  for (const p of panes) { p.view.inset = opt('click_through', false) || barGone ? 0 : Math.max(0, barH - p.el.getBoundingClientRect().top); p.view.scheduleClip(); }
}

// ---- the tabs: the windows that are tabs of this one (their option "탭으로 합칠 창") get a pane each, and a tab in the bar
let started = false;                                                // (the first replay of the hub is asked for in start(); a pane that comes later asks for its own)
function syncPanes() {
  const want = winconf.dockedOf(cfg.child_windows, wid);
  for (const id of want) {
    if (panes.some(p => p.id === id)) continue;
    const p = makePane(id);
    p.view.sink = viewSink; p.replay = true; watchScroll(p);
    if (started) emit('feed-hello', { label });
  }
  for (const p of [...panes]) {
    if (p === host || want.includes(p.id)) continue;
    p.view.stop(); p.el.remove(); p.tab?.remove(); panes.splice(panes.indexOf(p), 1);
    if (active === p) activate(host);
  }
  const rank = p => (p === host ? -1 : want.indexOf(p.id));
  panes.sort((a, b) => rank(a) - rank(b));
}
function showTabs() {
  const bar = document.getElementById('bar'), space = document.getElementById('space'), multi = panes.length > 1, locked = !!opt('lock_window', false);
  const ta = Math.min(1, Math.max(0.05, Number(opt('tab_opacity', 1)) || 1));                  // (the tabs and the icon box: how solid; the one under the mouse is a little more)
  document.body.style.setProperty('--tab-alpha', String(ta)); document.body.style.setProperty('--tab-alpha-hover', String(Math.min(1, ta + 0.3)));
  document.body.classList.toggle('locked', locked);                    // ("창 고정": the bar does not drag the window, the edges do not resize it)
  for (const e of [bar, space]) { if (locked) e.removeAttribute('data-tauri-drag-region'); else e.setAttribute('data-tauri-drag-region', ''); }
  for (const p of panes) {
    if (p === host) p.tab = document.getElementById('title');
    else if (!p.tab) {
      const t = document.createElement('div'); t.className = 'tab'; t.dataset.wid = String(p.id);
      t.onpointerdown = e => { if (e.button === 0) activate(p); };
      p.tab = t;
    }
    if (p === host && !p.tab.onpointerdown) p.tab.onpointerdown = e => { if (e.button === 0) activate(p); };
    p.tab.textContent = nameFor(cfg, p.id);
    p.tab.classList.toggle('on', p === active);
    p.tab.classList.toggle('alert', p.alert && p !== active);
    if (multi || locked) p.tab.removeAttribute('data-tauri-drag-region'); else p.tab.setAttribute('data-tauri-drag-region', '');     // (a tab is clicked: the bar's empty part drags)
    bar.insertBefore(p.tab, space);
    p.el.classList.toggle('off', p !== active);
  }
  document.body.classList.toggle('has-alert', panes.some(p => p.alert && p !== active));
  document.body.classList.toggle('tabbed', multi);
}
function activate(p) {
  if (p === active || !panes.includes(p)) return;
  view.hideTip();
  if (!getSelection().isCollapsed) getSelection().removeAllRanges();
  active = p; view = p.view; feed = p.feed; p.alert = false;
  review = false; reviewIdle = 0;
  showTabs(); view.touch();
}

// ---- above everything / just above the game / normal.
// "Just above the game" has two ways (the setting WOW_BY_OWNER, tab 고급):
//  1 (owner): two states. While the GAME is the program in front the window is simply topmost ("always on top": a click on it is as quick as
//     ever, and nothing can come up over it); no owner. While another program is in front the game is the OWNER of the window and it is not
//     topmost: Windows keeps an owned window right above its owner and behind whatever covers the owner, with no flicker. (An owned window
//     reacts half a second late to a click while the game is in front: that is why it is topmost and free of the owner meanwhile.)
//  0 (by hand): every PLACE_MS the window is put right above the game again (flickers when the game comes to the front).
let lastInput = -1e9, insidePrev = false, lastCopied = '', copyPrev = false, lmbPrev = false, lmbAt = 0, lastDown = -1e9, lags = [];
const noteLag = ms => { lags.push(Math.max(0, Math.round(ms))); if (lags.length > 5) lags.shift(); };
let wheelWarned = false;                                                          // (the wheel hook could not be made: said once in the log)
let lastOs = null;                                                  // the newest answer of os_state (for the diagnosis in the options)
// The menu and the tips are drawn by a window of their own (popup_host.js) so a small window does not cut them off. Where the page's own pixels
// (CSS) are turned into the screen's (real pixels) by this window's place and scale. When there is no popup (it could not be made) the page draws them itself.
const toScreen = (cx, cy) => { const w = (lastOs && lastOs.win) || [0, 0, 0, 0], d = window.devicePixelRatio || 1; return [Math.round(w[0] + cx * d), Math.round(w[1] + cy * d)]; };
const thisRect = () => (lastOs && lastOs.win ? [...lastOs.win] : null);
const viewSink = {
  usable: () => popup.usable(),
  show: (html, x, y) => popup.tip({ html, at: toScreen(x, y), within: thisRect() }),
  hide: () => popup.hide('tip'),
};
host.view.sink = viewSink;
widgetLayer.sink = {
  usable: () => popup.usable(),
  show: (text, r) => { const [l, t] = toScreen(r.left, r.top), [rr, b] = toScreen(r.right, r.bottom); popup.tip({ text, anchor: [l, t, rr, b], within: thisRect() }); },
  hide: () => popup.hide('tip'),
};
// the popup is made a little after the start (when it stays: POPUP_IDLE_MS 0), so the first tip is there at once; only the main window asks
if (wid === MAIN) setTimeout(() => { if (T.POPUP_IDLE_MS === 0) popup.warm(); }, 3000);
let closeMenu = () => {};                                           // takes the right-click menu away (set by contextMenu)
let libTopNow = null, zKey = '', zMode = '', ownerHwnd = 0, gameHwnd = 0, zTimer = null, placeTimer = null, side = null, sideBusy = false;
const byOwner = () => T.WOW_BY_OWNER === 1;
async function setOwner(hwnd) {
  if (hwnd === ownerHwnd) return;
  ownerHwnd = hwnd;
  try { await invoke('set_owner', { owner: hwnd }); } catch (e) { note(tr('창 순서: {e}', { e })); }
}
async function applyZ() {
  const wow = !!opt('topmost_wow_only', false);
  const top = wow ? !gameFound : !!opt('topmost', true);              // "just above the game" without a game: on top, so that it is seen
  const key = `${wow}|${top}`, mode = wow && byOwner() ? 'owner' : 'plain';
  const changed = key !== zKey || mode !== zMode;
  zKey = key; zMode = mode;
  // the window library's own idea of "on top": in owner mode it stays on (the real state is set by hand in zStep, a library call would move the window twice)
  const libTop = top || mode === 'owner';
  if (libTop !== libTopNow) {
    libTopNow = libTop;
    try { await thisWin.setAlwaysOnTop(libTop); } catch (e) { note(tr('창 순서: {e}', { e })); }
    invoke('set_noactivate', { on: true }).catch(() => {});
  }
  if (changed) {
    side = null;
    // (owner mode with the game there: zStep decides in a moment; the window stays where it is until then, which is what makes the change quiet)
    if (!(mode === 'owner' && !top)) await invoke('set_topmost', { on: top, game: top ? 0 : gameHwnd || 0 }).catch(() => {});      // (by the system call: the window library skips a change it thinks is none)
  }
  zTimer?.stop(); zTimer = null; placeTimer?.stop(); placeTimer = null;
  if (mode === 'plain' || top) await setOwner(0);                   // (the owner is set while the game is there and another program is in front: zStep)
  if (changed) emit('z-done', {});                                  // (the options window takes the focus back if it was the one that asked)
  if (!wow) return;
  const follow = async () => {                                      // the game window may be closed and opened again: its handle changes
    try {
      const g = await invoke('find_game', { known: gameHwnd || null, title: cfg.wow_window_title || 'World of Warcraft' });
      gameHwnd = g ? g.hwnd : 0;
    } catch { /* the next round tries again */ }
  };
  await follow(); zTimer = every('FOLLOW_GAME_MS', follow);
  if (mode === 'plain') placeTimer = every('PLACE_MS', () => (gameHwnd && !top ? invoke('place_above', { game: gameHwnd }).catch(() => {}) : null));
}

// owner mode, the game is there: which of the two states, by the program in front (told by os_state, every round of the loop).
// The order matters: to "front" topmost first, then the owner is let go; to "back" the owner first (while topmost nothing moves), then topmost
// goes off with the window put directly above the game (NOT at the top of the ordinary windows: that would raise the game over what was just
// activated, the taskbar would come up and the program in front would not be the one that is seen).
async function zStep(s) {
  if (zMode !== 'owner' || zKey !== 'true|false' || !gameHwnd || sideBusy) return;
  const want = s.fg === gameHwnd || s.fgMine ? 'front' : 'back';     // (the options window or the send box in front counts like the game: the windows stay visible while they are set up)
  if (want === side && !(want === 'back' && ownerHwnd !== gameHwnd)) return;
  sideBusy = true;
  try {
    if (want === 'front') {
      // The game in front: topmost first, then the owner goes (the window never sinks behind the game). Our own window in front (the options): the
      // owner goes FIRST: Windows keeps an owner and its owned window in the same topmost state, so "topmost" for the owned window would make the
      // GAME topmost, and it would cover the options window that was just clicked (and take the focus from it).
      if (s.fg === gameHwnd) { await invoke('set_topmost', { on: true, game: 0 }); await setOwner(0); }
      else { await setOwner(0); await invoke('set_topmost', { on: true, game: 0 }); }
    }
    else { await setOwner(gameHwnd); await invoke('set_topmost', { on: false, game: gameHwnd }); }
    side = want;
  } catch { /* the next round tries again */ } finally { sideBusy = false; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- where the window stands: restored at start, reported to the hub (which saves it) when it was moved or resized
async function restoreGeometry() {
  const saved = layout.parseGeometry(wid === MAIN ? cfg.geometry : conf().geometry);
  let { w, h, x, y } = saved || { w: layout.DEFAULT_SIZE[0], h: layout.DEFAULT_SIZE[1], x: null, y: null };
  if (x === null && wid !== MAIN) {                                   // no place saved: next to the main window, a little lower each time
    const m = layout.parseGeometry(cfg.geometry);
    const n = Math.max(1, cfg.child_windows.findIndex(c => c.id === wid) + 1);
    [x, y] = layout.cascade(m && m.x !== null ? [m.x, m.y] : null, n);
  }
  try {
    await invoke('set_window_rect', { x, y, w, h });
    // what the system made of it: size and place are read back once, a difference is corrected (and told in the log)
    const a = (await invoke('os_state', { keys: [] })).win;
    const want = [x === null ? a[0] : x, y === null ? a[1] : y, w, h];
    if (a.some((v, i) => Math.abs(v - want[i]) > 1)) {
      emit('hub-log', { level: 'warn', msg: `window ${wid}: wanted ${want.join(',')} got ${a.join(',')}` });
      await invoke('set_window_rect', { x: want[0], y: want[1], w: want[2] + (want[2] - a[2]), h: want[3] + (want[3] - a[3]) });
    }
  } catch (e) { note(tr('창 위치: {e}', { e })); }
}
let lastRect = null, rectSince = 0, rectSent = null;
// tell the hub where the window is right now (before it closes / the program ends: a move that is not 800 ms old yet is not lost)
async function reportGeometry() {
  try {
    const s = await invoke('os_state', { keys: [] }), [x, y, w, h] = s.win;
    if (x > -30000 && w >= 50) emit('win-geometry', { id: wid, geometry: layout.formatGeometry(w, h, x, y) });
  } catch { /* the window is gone already */ }
}
function watchGeometry(rect) {
  if (rect[0] < -30000 || rect[2] < 50) return;                               // (minimised: Windows puts it far away)
  const text = rect.join(',');
  if (text !== lastRect) { lastRect = text; rectSince = performance.now(); return; }
  if (text !== rectSent && performance.now() - rectSince > T.GEOMETRY_STILL_MS) {          // it stood still for a moment: this is where the user put it
    rectSent = text;
    const [x, y, w, h] = rect;
    emit('win-geometry', { id: wid, geometry: layout.formatGeometry(w, h, x, y) });
  }
}

// Runs all the time: click-through. The window ignores the mouse, except while the interact keys are held with the cursor over it.
// (The send key is not watched here: the hub's send box does that, send_host.js.)
// The user scrolled the lines (dir -1 up, 1 down), by the wheel the page got or the one the exe took: up = reading the earlier chat (only when the lines went up); down onto the newest line = done.
function userScrolled(dir) {
  if (dir < 0) { review = true; reviewIdle = 0; }
  else if (review && view.atBottom()) { review = false; reviewIdle = 0; }
}
// a turn of the wheel the exe took (positive = up): the lines move, and going up starts the review only when they really went up (at the very top there is nothing earlier to read)
function wheelScrolled(delta) {
  const el = view.scroll, before = el.scrollTop;
  el.scrollTop -= delta * 100 / 120; view.touch();
  if (delta > 0) { if (el.scrollTop < before - 0.5) userScrolled(-1); } else userScrolled(1);
}
// The review state follows the scroll position itself, whatever moved it (wheel, Shift+wheel, scrollbar, keys): going up = review, back at the
// newest line = done. New lines only ever move it down, so they do not start a review.
const input = () => { lastInput = performance.now(); };
for (const ev of ['wheel', 'pointerdown', 'pointermove', 'keydown']) addEventListener(ev, e => { if (ev !== 'pointermove' || e.buttons) input(); }, { capture: true, passive: true });
function watchScroll(p) {
  const l = p.el; let lastTop = l.scrollTop;
  // Only what the user did counts as "going up": the browser also moves the position by itself when the lines get shorter (a translation line
  // hidden, a line trimmed) or the window smaller, and that must not start the review.
  l.addEventListener('scroll', () => {
    const t = l.scrollTop;
    if (p === active) {
      if (t < lastTop - 1) { if (performance.now() - lastInput < 600) userScrolled(-1); } else if (t > lastTop + 1) userScrolled(1);
    }
    lastTop = t;
  });
}
watchScroll(host);

async function tick() {
  {
    let s;
    try { s = await invoke('os_state', { keys: [0x01, 0x11, 0x43] }); } catch (e) { return; }
    lastOs = s;
    zStep(s);
    const [cx, cy] = s.cursor, [x, y, w, h] = s.win;
    const inside = cx >= x && cx < x + w && cy >= y && cy < y + h;
    if (geometryReady) watchGeometry([x, y, w, h]);
    const lmb = !!(s.keys && s.keys[0]);                                              // the left button as the system sees it (for the input delay of the diagnosis)
    if (lmb && !lmbPrev && inside && interactive) {
      if (performance.now() - lastDown < 250) noteLag(0); else lmbAt = performance.now();
    }
    lmbPrev = lmb;
    // Ctrl+C: the window never takes the keyboard (the game keeps it), so the key press is looked at here and the selected text is copied
    const copyKey = !!(s.keys && s.keys[1] && s.keys[2]);
    if (copyKey && !copyPrev && interactive) { const picked = getSelection().toString(); if (picked) { try { window.__TAURI__.clipboardManager.writeText(picked); } catch { /* no clipboard */ } } }
    copyPrev = copyKey;
    // the mouse leaves the window: the selected text is copied (the option "자동 복사"; only real text, and not the same text again)
    if (insidePrev && !inside && cfg.auto_copy) {
      const picked = getSelection().toString();
      if (picked.trim() && picked !== lastCopied) { lastCopied = picked; try { window.__TAURI__.clipboardManager.writeText(picked); } catch { /* no clipboard */ } }
    }
    insidePrev = inside;
    document.body.classList.toggle('outside', !inside);
    syncBarGone();                              // (the title bar fades while the mouse is out of the window, see style.css)
    const overMe = inside && !hovering;                                               // (a window cleared by the mouse shows no tips: its tip would float over nothing)
    widgetLayer.pointer(overMe ? (cx - x) / (window.devicePixelRatio || 1) : null, overMe ? (cy - y) / (window.devicePixelRatio || 1) : null);       // (the tip of a widget under the cursor: also while click-through)
    if (!inside && !getSelection().isCollapsed) getSelection().removeAllRanges();     // the cursor left: the marked text is released
    const keys = opt('interact_keys', ['Shift']) || ['Shift'];
    const held = keys.length > 0 && keys.every(k => s[String(k).toLowerCase()] === true);
    // a click-through window that is NOT in the way: it is seen and used like any window when the game is not there, or while the old chat is read
    // The turns of the wheel the exe took for this window (see win.rs): a window the mouse goes through: the turns UP (the game does not get them);
    // a window that takes the mouse: the turns while Shift / Ctrl / Alt is held (Windows does not hand those to a window that is not in front).
    if (zoneMode) {
      try {
        const w = await invoke('wheel_since', { seq: wheelSeq });
        wheelSeq = w.seq;
        if (inside && w.delta.length) {
          const sum = w.delta.reduce((a, b) => a + b, 0);
          wheelCount += w.delta.length;
          wheelScrolled(sum);
        }
      } catch { /* the next round */ }
    }
    // reading stays while the lines are scrolled up, or the mouse is over the window; at the bottom with the mouse away for a moment: click-through again
    if (review) {
      if (view.atBottom() && !inside) { if (!reviewIdle) reviewIdle = performance.now(); else if (performance.now() - reviewIdle > T.REVIEW_LEAVE_MS) { review = false; reviewIdle = 0; } }
      else reviewIdle = 0;
    }
    if (review !== reviewShown) { reviewShown = review; emit('hub-log', { level: 'info', msg: `window ${wid}: reading the earlier chat ${review ? 'on' : 'off'} (wheel turns taken: ${wheelCount})` }); }
    document.body.classList.toggle('review', review);                              // (the frame turns amber and a way back down shows)
    const now = !opt('click_through', false) || (held && inside) || !gameFound || review;
    const hover = !now && inside && !!opt('hover_clear', false);                // click-through, the mouse over the window and no interact key: cleared
    if (hover !== hovering) { hovering = hover; document.body.classList.toggle('hover-clear', hover); syncBlur(); }
    if (now !== interactive) {
      interactive = now;
      document.body.classList.toggle('interactive', now);
      await thisWin.setIgnoreCursorEvents(!now);
      invoke('set_noactivate', { on: true }).catch(() => {});          // (the window library may have rewritten the styles with this change)
      if (!now) closeMenu();                                           // the interact key was let go: the window lets the mouse through again, a menu could not be used any more
    }
    // click-through: the page gets no mouse events, so the tip of a link (item, quest ...) under the cursor is shown from the cursor position the loop has (the option
    // "관통 중 링크 보기 허용"); not while the window is cleared by the mouse (hover_clear) and not at all when the window is usable (its own mouse events do it)
    // A Mac gives no mouse-over events to a window that is not the active one (and these windows never are: they must not take the game's keyboard), so there the same
    // cursor reading shows the tips of a usable window too (the mouse events would do it on Windows).
    const tipsFromCursor = !now ? cfg.through_tips !== false : isMac;
    if (inside && tipsFromCursor && !hovering) view.tipAtPoint((cx - x) / (window.devicePixelRatio || 1), (cy - y) / (window.devicePixelRatio || 1));
    else view.hideTip();
    // only a window the mouse goes through needs the exe's wheel; a usable one gets its own. Not for a window that is cleared by the mouse ("관통 창 숨기기"):
    // the game's own chat under it is what is used then, and the wheel is the game's. While lines have faded away, the turns DOWN are taken too (a turn brings them back; also while they fade).
    const wheelOn = !!cfg.wheel_through && !opt('hover_clear', false);
    // The wheel over a window the mouse goes through is not for the game: both ways. A Mac keeps it while the earlier chat is read (the window is usable then): a trackpad
    // gesture belongs to the window that got its first turn, so the rest of it would still go to the game (a zoom) when the hook is taken away at that moment.
    const zm = !wheelOn ? '' : (isMac ? (opt('click_through', false) && gameFound) : !now) ? 'through' : '';
    const zk = zm;
    if (zk !== zoneKey) {
      const had = zoneMode;
      zoneKey = zk; zoneMode = zm;
      try { await invoke('wheel_zone', { on: !!zm, usable: false, down: true }); if (zm && !had) wheelSeq = (await invoke('wheel_since', { seq: 0 })).seq; } catch (e) { zoneMode = ''; zoneKey = ''; /* no hook: no review */ if (!wheelWarned) { wheelWarned = true; emit('hub-log', { level: 'warn', msg: `window ${wid}: the wheel over a click-through window is not available: ${e}` }); } }
    }
  }
}
async function loop() {
  for (;;) {
    await sleep(T.OVERLAY_POLL_MS);
    const t0 = performance.now();
    await tick();
    perfAdd('OVERLAY_POLL_MS', performance.now() - t0);
  }
}

// The page is not a browser page: no context menu, no middle-click scrolling, no dragging of text/links, no zoom. Shift/Ctrl/Alt + wheel
// would zoom or scroll sideways in a browser: it scrolls the lines instead.
function plainPage() {
  addEventListener('contextmenu', e => e.preventDefault());
  addEventListener('auxclick', e => e.preventDefault());
  addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  addEventListener('dragstart', e => e.preventDefault());
  addEventListener('keydown', e => { if (e.ctrlKey && ['+', '-', '=', '0', '_'].includes(e.key)) e.preventDefault(); });
  addEventListener('wheel', e => {
    e.preventDefault();
    view.touch();                                                   // (even when there is nothing to scroll)
    const d = e.deltaY || e.deltaX;
    nativeWheel++;
    view.scroll.scrollTop += e.deltaMode === 1 ? d * 40 : d;
  }, { passive: false });
  addEventListener('blur', () => getSelection().removeAllRanges());
}

// ---- resizing: the window is not resizable for the system (its top edge is the title bar); the page draws edges at the left, right and bottom
// and the corners below, and sets the rectangle itself while the mouse is held (the position of the mouse comes from the exe).
function edges() {
  const MINW = 120, MINH = 60;
  const make = (el, side) => {
    el.onpointerdown = async e => {
      e.preventDefault();
      if (opt('lock_window', false)) return;
      el.setPointerCapture(e.pointerId);
      resizing = true; syncBlur();                                  // the blur behind flickers while the size changes: off meanwhile
      let s0; try { s0 = await invoke('os_state', { keys: [] }); } catch { return; }
      const [x0, y0, w0, h0] = s0.win, [cx0, cy0] = s0.cursor;
      let busy = false;
      el.onpointermove = async () => {
        if (busy) return; busy = true;
        try {
          const s = await invoke('os_state', { keys: [] }), dx = s.cursor[0] - cx0, dy = s.cursor[1] - cy0;
          let x = x0, w = w0, h = h0;
          if (side.includes('l')) { w = Math.max(MINW, w0 - dx); x = x0 + (w0 - w); }
          if (side.includes('r')) w = Math.max(MINW, w0 + dx);
          if (side.includes('b')) h = Math.max(MINH, h0 + dy);
          await invoke('set_window_rect', { x, y: y0, w, h });
        } catch { /* the next move */ }
        busy = false;
      };
      el.onpointerup = () => { resizing = false; syncBlur(); el.onpointermove = null; try { el.releasePointerCapture(e.pointerId); } catch { /* released */ } };
    };
  };
  for (const side of ['l', 'r', 'b', 'bl']) { const el = document.createElement('div'); el.className = 'edge e-' + side; document.body.append(el); make(el, side); }
  make(document.getElementById('grip'), 'br');
}

// ---- the right-click menu: the options of this window, copy / clear, and the other windows (open / close)
// what to do while the window lets the clicks through (told when it is switched on)
async function throughNotice() {
  let key = true; try { key = await invoke('options_hotkey_ok'); } catch { /* unknown */ }
  const keys = (opt('interact_keys', ['Shift']) || ['Shift']).join('+');
  note('ℹ ' + tr('클릭 관통 중입니다. {keys}를 누른 채로 조작합니다. 옵션은 {open}에서 엽니다.',
    { keys, open: key ? tr('Ctrl+Alt+O 또는 트레이 아이콘') : tr('트레이 아이콘') }));
}

function contextMenu() {
  const menu = document.createElement('div');
  menu.id = 'ctx'; menu.hidden = true; menu.dataset.notr = '';
  document.body.append(menu);
  let open = new Set();
  listen('win-state', e => { open = new Set(e.payload.open); });
  emit('win-state-hello', {});
  let inWindow = false;                                         // the menu is in the popup window (not in this page)
  const hide = () => { menu.hidden = true; if (inWindow) { inWindow = false; popup.hide('menu'); } };
  closeMenu = hide;
  addEventListener('contextmenu', async ev => {
    ev.preventDefault();
    // what the menu has: { text, fn, cls }; cls 'sep' is a line, 'off' is grey and does nothing, 'on' has a tick
    const list = [];
    const add = (text, fn, cls = '') => list.push({ text, fn, cls });
    // the tab that was clicked with the right button (its name, without being shown first); anywhere else: the tab that is shown
    const tabEl = ev.target.closest && ev.target.closest('#bar .tab');
    const target = tabEl ? panes.find(p => p.tab === tabEl) || active : active;
    // a widget of a plugin under the mouse: its own items first, then the settings of the plugin
    const wi = widgetLayer.itemOf(ev.target);
    if (wi && wi.owner && wi.owner !== 'core') {
      for (const m of wi.menu) add(m.label, () => emit('widget-action', { id: wi.id, type: 'menu', item: m.id }));
      add(tr('플러그인 설정…'), () => {
        try { localStorage.setItem('cmr-plugin-sel', wi.owner); localStorage.setItem('cmr-options-tab', 'plugins'); } catch { /* the options open as they were */ }
        invoke('open_options').catch(e => note(tr('옵션 창: {e}', { e })));
      });
    }
    const widgetOnly = !!(wi && wi.owner && wi.owner !== 'core');       // (the menu of a widget of a plugin is only its own: the items of the window are not mixed in)
    if (!widgetOnly) {
    add(tr('이 창의 옵션…'), async () => {
      try { localStorage.setItem('cmr-options-win', String(target.id)); } catch { /* the options open on the first window */ }
      invoke('open_options').catch(e => note(tr('옵션 창: {e}', { e })));
    });
    const picked = getSelection().toString();
    add(tr('선택한 글 복사'), () => { try { window.__TAURI__.clipboardManager.writeText(picked); } catch { document.execCommand('copy'); } }, picked ? '' : 'off');
    add(tr('창 비우기'), () => target.view.apply(target.feed.clear(), target.feed.model));
    // merging: a tab leaves its window; a window (that has no tabs of its own and is not the main one) becomes a tab of another
    {
      const kids = cfg.child_windows, setDock = (id, to) => emit('cfg-patch', { patch: { child_windows: kids.map(c => (c.id === id ? { ...c, dock_to: to } : c)) } });
      const hostOf = winconf.dockHost(kids, target.id);
      if (hostOf) add(tr('이 탭 독립시키기'), () => setDock(target.id, 0));
      if (target.id !== MAIN && !winconf.dockedOf(kids, target.id).length) {
        for (const h of [MAIN, ...kids.filter(c => c.kind !== 'web').map(c => c.id)]) {
          if (h === target.id || h === hostOf || (h !== MAIN && winconf.dockHost(kids, h)) || (h !== MAIN && Number(kids.find(c => c.id === h).dock_to) > 0)) continue;
          add(tr('{name} 창의 탭으로 붙이기', { name: nameFor(cfg, h) }), () => setDock(target.id, h));
        }
      }
    }
    list.push({ cls: 'sep' });
    for (const id of [MAIN, ...cfg.child_windows.filter(c => c.kind !== 'web').map(c => c.id)]) {
      const tab = panes.find(p => p.id === id && p !== host);                // (a tab of this window: a click shows it)
      if (tab) { add(nameFor(cfg, id), () => activate(tab), tab === active ? 'on' : ''); continue; }
      if (winconf.dockHost(cfg.child_windows, id)) { add(nameFor(cfg, id), null, 'off'); continue; }       // (a tab of another window)
      const isOpen = id === MAIN || open.has(id);
      add(nameFor(cfg, id), () => emit('win-command', { cmd: isOpen ? 'close' : 'open', id }), (isOpen ? 'on' : '') + (id === MAIN ? ' off' : ''));
    }
    }
    // in a window of its own: not cut off by a small window, and it is closed by a click anywhere else (popup.js)
    if (popup.usable()) {
      let at = null;
      try { at = (await invoke('os_state')).cursor; } catch { /* the page draws it */ }
      if (at && await popup.menu({ items: list.map((e, id) => ({ id, text: e.text, cls: e.cls })), at, onPick: id => { inWindow = false; const e = list[id]; if (e && e.fn) e.fn(); } })) { inWindow = true; return; }
    }
    menu.replaceChildren();
    for (const e of list) {
      const d = document.createElement('div'); d.className = e.cls;
      if (e.cls !== 'sep') {
        d.textContent = e.text;
        if (e.fn && !e.cls.includes('off')) d.onclick = () => { hide(); e.fn(); };
      }
      menu.append(d);
    }
    menu.hidden = false;
    menu.style.left = Math.max(0, Math.min(ev.clientX, innerWidth - menu.offsetWidth - 2)) + 'px';
    menu.style.top = Math.max(0, Math.min(ev.clientY, innerHeight - menu.offsetHeight - 2)) + 'px';
  });
  addEventListener('mousedown', ev => { if (!menu.contains(ev.target)) hide(); }, true);
  addEventListener('keydown', ev => { if (ev.key === 'Escape') hide(); });
  addEventListener('blur', () => { if (!inWindow) hide(); });                // (a menu in the popup window has its own rules: this window is not the one that matters for it)
  addEventListener('wheel', hide, { passive: true });
}

async function start() {
  plainPage();
  await fonts.loadAll().catch(() => []);                              // the fonts of the fonts/ folder, before the first draw
  for (const line of fonts.report) emit('hub-log', { level: 'info', msg: 'font registered: ' + line });
  for (const f of fonts.failed) { note(tr('글꼴 파일을 쓸 수 없습니다: {f}', { f: f.file })); emit('hub-log', { level: 'warn', msg: `font file not usable: ${f.file} | ${f.error}` }); }
  applyAll();
  const bar = document.getElementById('bar');                         // (a clicked button must not keep the keyboard: Enter would press it again)
  bar.addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') e.preventDefault(); });
  bar.addEventListener('click', () => document.activeElement?.blur?.());
  document.getElementById('options').onclick = () => invoke('open_options').catch(e => note(tr('옵션 창: {e}', { e })));
  document.getElementById('research').onclick = () => emit('research', {});
  // the speaker: the voice recognition on / off with the saved options; its colour says the state (the hub tells: 'voice-lamp')
  const speaker = document.getElementById('voice');
  speaker.onclick = () => emit('voice-toggle', {});
  const lamp = l => {
    const st = l && l.state || 'off';
    speaker.dataset.state = st;
    speaker.title = st === 'on' ? tr('음성인식 끄기 (켜져 있음)') : st === 'starting' ? tr('음성인식을 켜는 중입니다. 누르면 끕니다') : st === 'error' ? tr('음성인식을 켜지 못했습니다') + (l.text ? ': ' + l.text : '') + ' · ' + tr('누르면 다시 켭니다')
      : tr('음성인식 켜기');
  };
  await listen('voice-lamp', e => lamp(e.payload));
  await listen('widget-state', e => widgetLayer.state(e.payload.id, e.payload.state));
  await listen('widget-defs', e => { syncPluginDefs(widgetRegistry, e.payload.defs); applyWidgets(); });          // (the widgets the plugins registered: drawn when a window has them on)
  emit('widget-defs-hello', {});
  // macOS: the turns of the wheel the exe took for this window arrive one by one as they happen (Windows: asked for with wheel_since, every round of the loop)
  await listen('wheel-turn', e => {
    const u = Number(e.payload);
    if (!Number.isFinite(u) || !u) return;
    wheelCount++;
    wheelScrolled(u);
  });
  emit('voice-lamp-hello', {});
  // the main window: the exe ends the program; the others: only that window (the hub keeps it closed: open mode "직접 열 때만")
  document.getElementById('close').onclick = async () => { await reportGeometry(); if (wid !== MAIN) await emit('win-closed', { id: wid }); thisWin.close(); };
  addEventListener('pointerdown', e => {
    // an ordinary window (neither on top nor above the game) comes up over the others when it is touched; ours do not take the focus: by hand
    if (!opt('topmost', true) && !opt('topmost_wow_only', false)) invoke('raise_top').catch(() => {});
    // the click as the page gets it: how long after the system saw the button go down?
    if (e.button !== 0) return;
    if (lmbAt) { noteLag(performance.now() - lmbAt); lmbAt = 0; } else lastDown = performance.now();
  }, true);
  document.getElementById('toBottom').onclick = () => { const l = view.scroll; l.scrollTop = l.scrollHeight; review = false; reviewIdle = 0; view.touch(); };
  edges();
  await restoreGeometry();
  geometryReady = true;
  try { await invoke('set_noactivate', { on: true }); } catch (e) { note('set_noactivate: ' + e); }

  await listen('game-state', e => { gameFound = !!e.payload.found; interactive = null; applyZ(); });       // (interactive = null: the loop decides again)
  emit('game-hello', {});
  contextMenu();
  await listen('quit-request', () => reportGeometry());
  let wasThrough = !!opt('click_through', false);
  const tipWidth = () => document.documentElement.style.setProperty('--cv-tip-max', T.TIP_MAX_W + 'px');       // (the tip drawn in this page, when there is no popup window)
  tipWidth();
  settings.onChange(c => {
    cfg = c; applyAll(); showTitle(); tipWidth();
    const through = !!opt('click_through', false);
    if (through && !wasThrough) throughNotice();
    wasThrough = through;
  });
  showTitle();
  addEventListener('cmr-language', showTitle);
  // the events of the hub come in order (per pane: `seen`); a replay (history) starts a pane again from the beginning. `firstLive`: the first event that came by itself
  // before the replay did: what happened since the pane was opened
  const take = (p, n, ev, quiet) => {
    if (n <= p.seen) return;
    p.seen = n; if (n < p.firstLive) p.firstLive = n;
    const ops = p.feed.handle(ev);
    p.view.apply(ops, p.feed.model);
    if (!quiet && p !== active && ops.length && ev.type === 'LineAdded' && popt(p.id, 'tab_alert', false)) { p.alert = true; showTabs(); }       // the mark on its tab ("새 글 알림")
  };
  await listen('feed', e => { for (const p of [...panes]) take(p, e.payload.seq, e.payload.event, false); });
  await listen('feed-replay', e => {
    if (e.payload.label !== label) return;
    for (const p of [...panes]) {
      if (!p.replay) continue;
      p.replay = false;
      // "열 때 비우기" (an extra window): it starts empty, the lines the hub kept from before are not given to it (what came since it was opened is)
      const fresh = p.id !== MAIN && !!popt(p.id, 'clear_on_open', false), from = p.firstLive;
      p.view.apply(p.feed.clear(), p.feed.model); p.seen = 0;
      for (const x of e.payload.events) if (!fresh || x.seq >= from) take(p, x.seq, x.event, true);
    }
  });
  started = true;
  await emit('feed-hello', { label });
  try { await thisWin.show(); } catch { /* shown by the exe after a while anyway */ }       // (it was made hidden: no black square while the page loads)
  try { await invoke('set_noactivate', { on: true }); } catch { /* done above as well */ }     // (again now that it is seen: the window framework may have written the styles anew)
  loop();
  report(wid === MAIN ? 'main' : 'win' + wid, emit);
  setInterval(() => { if (lastOs) emit('diag', { label: wid === MAIN ? 'main' : 'win' + wid, fgExe: lastOs.fgExe, fgTitle: lastOs.fgTitle, ex: lastOs.ex, lag: lags.slice(), mode: zMode + '/' + (side || '-') + ` rv:${review ? 1 : 0} zone:${zoneMode || '-'} w:${wheelCount} nw:${nativeWheel}` }); }, 1000);
}

start();
