// A control center (3.2). The page of one of the three transparent windows over all the screens (center.rs): the translation windows of its kind of order (the page says it: ?mode=0
// ordinary, 1 always on top, 2 above the game only) are panes in it (pane.js). The data comes from the hub exactly as it comes to a window of 3.1.1 ('feed', 'feed-replay').
import * as settings from './settings.js';
import { startI18n } from './i18n_host.js';
import { MAIN } from './core/pipeline.js';
import * as winconf from './core/winconf.js';
import * as fonts from './fonts.js';
import { tr } from './core/i18n.js';
import { Pane } from './pane.js';
import { firstPlace } from './core/winlayout.js';
import { WebPane } from './webpane.js';
import { linkHandler } from './chatview.js';
import { menuList } from './ctxmenu.js';
import { T } from './core/timings.js';
import { add as perfAdd, report as perfReport } from './core/perf.js';
import { isMac } from './platform.js';
import { mountSendRow } from './sendrow.js';
if (isMac) document.body.classList.add('mac');
import { defaultRegistry } from './widgets/defaults.js';
import { syncPluginDefs } from './widgets/registry.js';

const q = new URLSearchParams(location.search);
// ?native=<window number>: this page is not a center over the screens but the page of a window of the system (3.2.1 test: main.rs native_open) that shows that one translation window and nothing else, filling
// its window below the frame the system gives it. The system moves it, sizes it, snaps it; no click-through, no order of its own, nothing is saved about its place yet.
const nativeId = Number(q.get('native')) || 0;
const mode = nativeId ? -1 : Number(q.get('mode')) || 0;
let ox = Number(q.get('ox')) || 0, oy = Number(q.get('oy')) || 0;                    // (where the page starts on the screen: it changes when the screens do)
const label = nativeId ? 'native' + nativeId : 'center' + mode;
if (nativeId) document.body.classList.add('native');
const dpr = () => window.devicePixelRatio || 1;
let cfg = await settings.load({ readOnly: true });
await startI18n(settings);
await fonts.loadAll().catch(() => []);
document.title = nativeId ? 'ChatMatrix ' + nativeId : 'CMR Center ' + mode;
const gameTitle = () => (nativeId ? null : invoke('center_title', { title: cfg.wow_window_title || '' }).catch(() => {}));        // (the program looks for the window of the game: with this title when it has no known program name)
gameTitle();
document.documentElement.style.setProperty('--cv-tip-max', T.TIP_MAX_W + 'px');                 // (the width of the tip of a link)

linkHandler.fn = id => emit('chat-link', { id });                 // (a link in a line, put there by a plugin: the hub opens it)
let sendInset = 0;                             // (css pixels, see `nativeInset`)
const panes = new Map();                       // window id -> Pane
const webs = new Map();                        // label of a web window -> WebPane (the page is a window of the system: webwin.rs)
const webBy = { plugin: [], browser: [] };     // the web windows that are open, as the two hosts of the hub tell: { kind: 'web' (a plugin's) | 'browser', win: the number of its entry, label, title, lock }
let webWins = [];
const everyBox = () => [...panes.values(), ...webs.values()];
let lampState = null;                          // the last state of the voice lamp (a pane made later gets it)
let open = new Set([MAIN]);
let works = [];                                // (the same screens without the menu bar, the dock, the task bar: where a new window may go)
let screens = [];                              // (all the screens, see below: declared before anything can ask for them, a layout that comes early must not find it not made)
const center = {
  label,
  native: !!nativeId,
  nativeInset: () => sendInset,                                       // (a window of the system: how high the send box row is now, below the text area)
  cfg: () => cfg,
  dpr,
  origin: () => [ox, oy],
  mainScreen: () => screens[0] || null,
  workAreas: () => (works.length ? works : screens),                 // (the same screens without the task bar, the menu bar, the dock: what a window laid on a monitor fills)
  // where a window with no saved place goes: the middle of the work area of the main screen, a step further when another window stands there (core/winlayout.js firstPlace). Screen pixels, or null (not known yet)
  firstSpot(self, w, h, headCss) {
    const a = works[0] || screens[0];
    if (!a) return null;
    const d = dpr(), taken = everyBox().filter(p => p !== self && p.rect).map(p => ({ x: Math.round(ox + p.rect.x * d), y: Math.round(oy + p.rect.y * d) }));
    return firstPlace({ w, h }, a, taken, Math.round(headCss * d));
  },
  monitors: () => screens,                                      // (all the screens: [x, y, w, h] in screen pixels; a box stays on one of them: frame.js)
  registry: defaultRegistry(),                 // (the widgets: the program's own, and what the plugins register comes by 'widget-defs')
  changed: () => report(),
  menu: (ev, pane) => showMenu(ev, pane),
  menuOwner: () => (menuEl.hidden ? null : menuPane),          // (the window whose menu is open: only that one counts as used)
  // the tips: always the top layer of the page (over every pane). A pane of the ordinary center is under the panes that stay on top, so its tips are drawn by the center of the windows
  // on top (the same look); the others draw their own
  viewSink: { usable: () => true, show: (html, x, y) => tip({ html, x: ox + x * dpr(), y: oy + y * dpr() }), hide: () => tip({ hide: true }) },
  widgetSink: { usable: () => true, show: (text, r) => { const d = dpr(); return tip({ text, rect: [ox + r.left * d, oy + r.top * d, ox + r.right * d, oy + r.bottom * d] }); }, hide: () => tip({ hide: true }) },
  // a pane was touched: it goes to the front of the panes of this center (like an ordinary window); the ordinary center also goes up over the other programs' windows
  raise: p => {
    if (p instanceof WebPane) {                                   // (the web windows are one order of their own, below every translation window: their pages are windows of the system under this one)
      if (Number(p.el.style.zIndex) !== webTop) { p.el.style.zIndex = String(nextWebZ()); report(); }
    } else if (Number(p.el.style.zIndex) !== top) p.el.style.zIndex = String(++top);
    if (mode === 0) invoke('center_raise', { label }).catch(() => {});
  },
  nextWebZ: () => nextWebZ(),                                     // (a web window that is made comes to the front of the web windows)
};
let top = 3000;                                                    // (the translation windows: 1000 + their numbers at first, then the counter)
let webTop = 100;                                                  // (the web windows: 100 .. 999)
function nextWebZ() {
  if (webTop >= 990) {                                             // (the numbers are used up: all are numbered again in the same order)
    const order = [...webs.values()].sort((a, b) => Number(a.el.style.zIndex) - Number(b.el.style.zIndex));
    webTop = 100; for (const w of order) w.el.style.zIndex = String(++webTop);
  }
  return ++webTop;
}
// the kind of order a window has now (settings: "항상 위", "와우 위에서만")
const optOf = (id, key, d) => (id === MAIN ? (cfg[winconf.MAIN_KEY[key] || key] ?? d) : winconf.opt(cfg.child_windows.find(c => c.id === id) || null, cfg, key, d));
const browserMode = id => { const b = (cfg.browser_windows || []).find(x => x.id === id) || {}; return b.topmost_wow_only ? 2 : b.topmost === false ? 0 : 1; };          // (the order of a window of the mini browser)
const modeOf = id => winconf.windowMode(cfg, id);

function sync() {
  const want = nativeId ? new Set(nativeId === MAIN || cfg.child_windows.some(c => c.id === nativeId && c.kind !== 'web') ? [nativeId] : [])
    : new Set(mode === 0 ? [] : [...open].filter(id => (id === MAIN || cfg.child_windows.some(c => c.id === id && c.kind !== 'web')) && !winconf.dockHost(cfg.child_windows, id) && modeOf(id) === mode));          // (the ordinary center has no translation window any more: they are windows of the system, see `native`. It still has web windows)
  for (const id of want) if (!panes.has(id)) { const p = new Pane(id, center); panes.set(id, p); if (lampState) p.lamp(lampState.st, lampState.title); p.hello(); }
  for (const [id, p] of [...panes]) if (!want.has(id)) { p.destroy(); panes.delete(id); }
  // the web windows of this order
  const wantWeb = new Map(webWins.filter(w => w.win && (w.kind === 'browser' ? (cfg.browser_windows || []).some(b => b.id === w.win) && browserMode(w.win) === mode : cfg.child_windows.some(c => c.id === w.win) && modeOf(w.win) === mode)).map(w => [w.label, w]));
  let added = false;
  for (const [l, w] of wantWeb) if (!webs.has(l)) { webs.set(l, new WebPane(w, center)); added = true; }
  for (const [l, p] of [...webs]) if (!wantWeb.has(l)) { p.destroy(); webs.delete(l); }
  for (const [l, w] of wantWeb) { const p = webs.get(l); if (p && p.setMode) p.setMode(w.mode); }
  if (added) fit();                                                    // (a new window that is out of every screen comes back to the main one)
  report();
}

// the right-click menu: drawn in this page (it is over all the screens, so it is never cut off); while it is open the page takes all the mouse (see report)
const menuEl = document.createElement('div');
menuEl.id = 'ctx'; menuEl.hidden = true; menuEl.dataset.notr = ''; document.body.append(menuEl);
let menuPane = null;
function hideMenu() { if (menuEl.hidden) return; menuPane = null; menuEl.hidden = true; lastKey = ''; report(); }
function showMenu(ev, pane) { openMenu(menuList({ cfg, pane, ev, open, browsersOpen: new Set(webBy.browser.map(w => w.win)) }), ev, pane); }
// An item can have `sub` (a list): a click shows that list in the place of this one, with a way back as its first line (two levels, no more); the menu stays open.
function openMenu(list, ev, pane, parent = null) {
  menuEl.replaceChildren();
  for (const e of parent ? [{ text: '‹ ' + tr('뒤로'), back: true }, { cls: 'sep' }, ...list] : list) {
    const d = document.createElement('div'); d.className = e.cls || '';
    if (e.cls !== 'sep') {
      const off = (e.cls || '').includes('off');
      d.textContent = e.text + (e.sub ? '  ▸' : '');
      if (e.back) d.onclick = () => openMenu(parent, ev, pane);
      else if (e.sub && !off) d.onclick = () => openMenu(e.sub, ev, pane, list);
      else if (e.fn && !off) d.onclick = () => { hideMenu(); e.fn(); };
    }
    menuEl.append(d);
  }
  menuPane = pane; menuEl.hidden = false; lastKey = ''; report();
  menuEl.style.left = Math.max(0, Math.min(ev.clientX, innerWidth - menuEl.offsetWidth - 2)) + 'px';
  menuEl.style.top = Math.max(0, Math.min(ev.clientY, innerHeight - menuEl.offsetHeight - 2)) + 'px';
}
// A web address in a line was clicked: the question comes first, for every address (the whole address is shown), and the user chooses where it goes: the mini browser (window 1), their own browser,
// or the clipboard. No key is looked at (a click-through window is used with a key the user chose: it may be Ctrl). The exe checks the address again (open_chat_url), the mini browser too.
linkHandler.urls = cfg.chat_links !== false;
linkHandler.url = (url, ev) => {
  const pane = [...panes.values()].find(p => p.el.contains(ev.target)) || null;
  openMenu([
    { text: url.length > 90 ? url.slice(0, 89) + '…' : url, cls: 'off' }, { text: '', cls: 'sep' },
    { text: tr('미니 브라우저에서 열기'), fn: () => emit('browser-command', { cmd: 'url', id: 1, url }) },
    { text: tr('내 브라우저에서 열기'), fn: () => invoke('open_chat_url', { url }).catch(() => {}) },
    { text: tr('주소 복사'), fn: () => { try { window.__TAURI__.clipboardManager.writeText(url); } catch { /* no clipboard */ } } },
    { text: '', cls: 'sep' }, { text: tr('취소'), fn: () => {} },
  ], ev, pane);
};
addEventListener('mousedown', ev => { if (!menuEl.contains(ev.target)) hideMenu(); }, true);
// (the menu of the web view - back, reload, print ... - never shows over a center: a right click anywhere else, with our menu open or not, only closes ours; only a text box keeps its own cut / paste)
addEventListener('contextmenu', ev => { if (!(ev.target.closest && ev.target.closest('input, textarea'))) ev.preventDefault(); }, true);
addEventListener('keydown', ev => { if (ev.key === 'Escape') hideMenu(); });
addEventListener('wheel', hideMenu, { passive: true });

const tipEl = document.createElement('div'); tipEl.className = 'cv-tip'; tipEl.dataset.notr = ''; tipEl.style.display = 'none'; tipEl.style.zIndex = '2147482000'; document.body.append(tipEl);
function drawTip(p) {
  const d = dpr();
  if (p.hide) { tipEl.style.display = 'none'; return; }
  tipEl.className = p.html !== undefined ? 'cv-tip' : 'w-tip';
  if (p.html !== undefined) tipEl.innerHTML = p.html; else tipEl.textContent = p.text;
  tipEl.style.display = 'block';
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  if (p.html !== undefined) {
    const x = (p.x - ox) / d, y = (p.y - oy) / d;
    tipEl.style.left = Math.max(0, Math.min(innerWidth - w, x + 12)) + 'px'; tipEl.style.top = Math.max(0, Math.min(innerHeight - h, y + 16)) + 'px';
  } else {
    const [l, t, r, b] = p.rect.map((v, i) => (v - (i % 2 ? oy : ox)) / d);
    tipEl.style.left = Math.max(2, Math.min(innerWidth - w - 2, (l + r) / 2 - w / 2)) + 'px';
    tipEl.style.top = Math.max(2, t - h - 6 >= 2 ? t - h - 6 : Math.min(innerHeight - h - 2, b + 6)) + 'px';
  }
}
const tip = p => { if (mode === 0) emit('center-tip', p); else drawTip(p); return true; };
if (mode === 1) await listen('center-tip', e => drawTip(e.payload));

// macOS: the turns of the wheel the exe took arrive one by one as they happen
await listen('wheel-turn', e => {
  const u = Number(e.payload.units), p = panes.get(Number(e.payload.id)) || webByWheel(e.payload.id);
  if (p && Number.isFinite(u) && u) p.wheelScrolled(u);
});
const webByWheel = id => [...webs.values()].find(w => w.wheelId === Number(id));          // (the window of the web a turn of the wheel was taken for: its number is in the zone, webpane.js wheelBox)
let lastOs = null;                             // the last state of the system (for the diagnosis)
let gameFound = true;                          // no game = the windows stay in view: nothing to click through to
await listen('game-state', e => { gameFound = !!e.payload.found; });
emit('game-hello', {});
let lastKey = '', copyPrev = false, webLmb = false;
// runs all the time: the mouse and the keys against the windows (pane.tick), and Ctrl+C (the windows never take the keyboard: the game keeps it)
(async function loop() {
  for (;;) {
    await new Promise(r => setTimeout(r, T.OVERLAY_POLL_MS));
    const t0 = performance.now();
    let s; try { s = await invoke('os_state', { keys: [0x01, 0x11, 0x43] }); } catch { continue; }
    let changed = false;
    for (const p of panes.values()) changed = p.tick(s, { game: gameFound, cfg }) || changed;
    for (const w of webs.values()) changed = w.tick(s, { game: gameFound, cfg }) || changed;
    // the left button goes down on the page of a web window: the page is a window of the system, this page never sees the click, so it is told here (the front-most window under the mouse is the one)
    const lmbNow = !!(s.keys && s.keys[0]);
    if (lmbNow && !webLmb) {
      let best = null;
      for (const w of webs.values()) { const b = w.screenBox(); if (s.cursor[0] >= b.x && s.cursor[0] < b.x + b.w && s.cursor[1] >= b.y && s.cursor[1] < b.y + b.h && (!best || Number(w.el.style.zIndex) > Number(best.el.style.zIndex))) best = w; }
      if (best) center.raise(best);
    }
    webLmb = lmbNow;
    if (changed) report();
    lastOs = s;
    const copyKey = !!(s.keys && s.keys[1] && s.keys[2]);
    if (copyKey && !copyPrev) { const picked = getSelection().toString(); if (picked) { try { window.__TAURI__.clipboardManager.writeText(picked); } catch { /* no clipboard */ } } }
    copyPrev = copyKey;
    perfAdd('OVERLAY_POLL_MS', performance.now() - t0);
  }
})();
// The turns of the wheel the exe took for the windows (Windows: asked for here; a Mac tells them one by one, see above). Asked for much more often than the rest of the loop above: the loop is
// every 0.1 s, and the turns that came in that time were all given to the window at once: the lines of a window the mouse goes through moved in jumps, ten times a second, not turn by turn
// as the wheel of a window that takes the mouse does. Only while a window has a wheel zone (the rest of the time the page waits a little longer).
const WHEEL_POLL_MS = 16;
let hadWheel = false, wheelSeq = 0, wheelWarned = false;         // (before the loop: it looks at them at once)
let wheelWake = null;                                          // (a wheel zone has just appeared: the loop looks at once, to know the number the turns after it start from)
(async function wheelLoop() {
  for (;;) {
    await new Promise(r => { wheelWake = r; setTimeout(r, hadWheel && !isMac ? WHEEL_POLL_MS : 100); });
    if (!hadWheel || isMac) continue;
    try {
      const w = await invoke('center_wheel', { label, seq: Math.max(0, wheelSeq) });
      const first = wheelSeq < 0; wheelSeq = w.seq;
      if (!first) for (const t of w.turns) { const p = panes.get(Number(t.id)) || webByWheel(t.id); if (p && p.inside) p.wheelScrolled(t.delta); }
    } catch { /* the next round */ }
  }
})();
// A web window's page is a window of the system UNDER this page, so what is drawn here (its bar, its frame) would show over the page of a window in front of it. Where a window in front covers it, what it
// draws is cut away (a mask): the windows then overlap like windows of the system do.
function clipWebs() {
  const list = [...webs.values()].map(p => ({ p, z: Number(p.el.style.zIndex) || 0, r: p.cover() }));
  for (const { p, z, r } of list) {
    const covers = list.filter(o => o.p !== p && o.z > z).map(o => o.r);
    p.setClip(covers, r);
  }
}
function report() {
  if (nativeId) return;                                              // (no center: the system has the window and the mouse)
  clipWebs();
  const list = [...panes.values()].map(p => ({ ...p.box(), hit: p.interactive, blur: p.blurLevel() })).concat([...webs.values()].flatMap(p => p.boxes()));          // (a window that is click-through takes no mouse: it goes through; the place is kept for the send box)
  const wheel = [...panes.values()].filter(p => p.zone).map(p => p.box()).concat([...webs.values()].filter(p => p.zone).map(p => p.wheelBox()));                    // (the wheel over these goes to the window, not to the game)
  if (!menuEl.hidden) list.push({ id: 'menu', x: 0, y: 0, w: innerWidth * center.dpr(), h: innerHeight * center.dpr(), bar: 0 });          // (while the menu is open, the center takes the whole mouse: a click anywhere else closes it)
  const key = JSON.stringify([list, wheel]);
  if (key === lastKey) return;
  lastKey = key;
  if (wheel.length && !hadWheel) wheelSeq = -1;                              // (the turns from before are not wanted: the loop takes the newest number)
  hadWheel = wheel.length > 0;
  if (wheel.length && wheelSeq < 0 && wheelWake) wheelWake();
  invoke('center_rects', { label, panes: list, wheel }).then(ok => {
    if (ok === false) { lastKey = ''; if (!wheelWarned) { wheelWarned = true; emit('hub-log', { level: 'warn', msg: `${label}: the wheel over a click-through window is not available (the permission is missing?)` }); } }
  }).catch(e => { lastKey = ''; if (!wheelWarned) { wheelWarned = true; emit('hub-log', { level: 'warn', msg: `${label}: ${e}` }); } });
}

// The page is not a browser page (the same as plainPage of a window of 3.1.1): no middle-click scrolling, no dragging of text/links, no zoom. Shift/Ctrl/Alt + wheel would zoom or scroll
// sideways in a browser: it scrolls the lines instead. The wheel is the page's own: the pane under the pointer scrolls its shown chat.
addEventListener('auxclick', e => e.preventDefault());
addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
addEventListener('dragstart', e => e.preventDefault());
addEventListener('keydown', e => { if (e.ctrlKey && ['+', '-', '=', '0', '_'].includes(e.key)) e.preventDefault(); });
addEventListener('blur', () => getSelection().removeAllRanges());
addEventListener('wheel', e => {
  e.preventDefault();
  const el = e.target.closest ? e.target.closest('.pane') : null, p = el && [...panes.values()].find(x => x.el === el);
  if (!p) return;
  const c = p.chats.get(p.active);
  c.view.touch();                                                   // (even when there is nothing to scroll)
  const d = e.deltaY || e.deltaX;
  c.lines.scrollTop += e.deltaMode === 1 ? d * 40 : d;
}, { passive: false });

settings.onChange(c => { const was = cfg.center_scale, wasTitle = cfg.wow_window_title; cfg = c; linkHandler.urls = c.chat_links !== false; if (c.center_scale !== was) applyScale(); if (c.wow_window_title !== wasTitle) gameTitle(); for (const p of panes.values()) p.update(); for (const p of webs.values()) p.update(); sync(); });
await listen('win-state', e => { open = new Set([MAIN, ...(e.payload.open || [])]); sync(); });
await listen('feed', e => { for (const p of panes.values()) p.take(e.payload.seq, e.payload.event, false); });
await listen('feed-replay', e => { for (const p of panes.values()) p.takeReplay(e.payload.label, e.payload.events); });
await listen('widget-state', e => { for (const p of panes.values()) p.widgets.state(e.payload.id, e.payload.state); });
await listen('widget-defs', e => { syncPluginDefs(center.registry, e.payload.defs); for (const p of panes.values()) p.applyWidgets(); });
emit('widget-defs-hello', {});
await listen('voice-lamp', e => {
  const l = e.payload, st = (l && l.state) || 'off';
  const title = st === 'on' ? tr('음성인식 끄기 (켜져 있음)') : st === 'starting' ? tr('음성인식을 켜는 중입니다. 누르면 끕니다') : st === 'error' ? tr('음성인식을 켜지 못했습니다') + (l.text ? ': ' + l.text : '') + ' · ' + tr('누르면 다시 켭니다') : tr('음성인식 켜기');
  lampState = { st, title };
  for (const p of panes.values()) p.lamp(st, title);
});
// the size of everything: "화면 배율" (0 = as the main screen has it); the notice says it once when it is not 100%
let scaleTold = false;
async function applyScale() {
  if (nativeId) return;
  try { await invoke('center_zoom', { label, scale: (Number(cfg.center_scale) || 0) / 100 }); } catch { return; }
  for (const p of everyBox()) p.place();
  report();
  if (!scaleTold && Math.abs(dpr() - 1) > 0.01) {
    const main = panes.get(MAIN);
    if (main) { scaleTold = true; main.note('ℹ ' + tr('화면 배율 {n}%로 표시합니다. 옵션의 일반 탭에서 바꿀 수 있습니다.', { n: Math.round(dpr() * 100) })); }
  }
}
// the screens changed (or this is the start): where the page starts is told again; a window that is out of every screen comes back to the main one, once told
function fit() {
  if (nativeId) return;
  const d = dpr(), moved = [];
  for (const p of everyBox()) {
    const b = p.screenBox(), seen = screens.some(m => Math.min(b.x + b.w, m[0] + m[2]) - Math.max(b.x, m[0]) >= 60 && Math.min(b.y + b.h, m[1] + m[3]) - Math.max(b.y, m[1]) >= 22);
    if (seen || !screens.length) continue;
    const m = screens[0], k = moved.length;
    p.rect.x = (m[0] + 60 + k * 30 - ox) / d; p.rect.y = Math.max(p.head || 22, (m[1] + 80 + k * 30 - oy) / d);
    p.layout(); p.save(); moved.push(p);
  }
  if (moved.length) { report(); (moved.find(p => p instanceof Pane) || moved[0]).note('⚠ ' + tr('모니터 환경이 바뀌어 일부 창의 위치가 변경되었습니다.')); }
}
function layout(l) {
  if (!l) return;
  const [nx, ny] = l.origin, d = dpr();
  if (nx !== ox || ny !== oy) {
    for (const p of everyBox()) { p.rect.x += (ox - nx) / d; p.rect.y += (oy - ny) / d; p.layout(); }              // (a window stays where it is on the screen)
    ox = nx; oy = ny;
  }
  screens = l.monitors || [];
  works = l.work || [];
  return applyScale().then(fit);
}
await listen('center-layout', e => { if (!nativeId) layout(e.payload); });
// the web windows: which are open (the hub), the title and the address of the page, how far it has scrolled (the program: webwin.rs)
await listen('web-state', e => { webBy[e.payload.source === 'browser' ? 'browser' : 'plugin'] = e.payload.windows || []; webWins = [...webBy.plugin, ...webBy.browser]; sync(); });
await listen('web-zoom', e => { const p = webs.get(e.payload.label); if (p && p.setZoom) p.setZoom(e.payload.zoom); });
await listen('web-copy', e => { const p = webs.get(e.payload && e.payload.label); if (p && p.copy) p.copy(e.payload.text); });
await listen('web-rclick', e => { const p = webs.get(e.payload && e.payload.label); if (p && p.rclick) p.rclick(); });
await listen('web-raise', e => { const p = webs.get(e.payload && e.payload.label); if (p) center.raise(p); });       // (a page was pressed: the system is not let to bring it over the center, the center does it)
await listen('web-order', e => {                                    // (a page that was pressed was brought to the front by the system: the windows are numbered in the order it says, front first)
  const labels = (e.payload && e.payload.labels) || [], list = labels.map(l => webs.get(l)).filter(Boolean).reverse();
  if (list.length < 2) return;
  if (webTop + list.length >= 990) { webTop = 100; for (const w of [...webs.values()].sort((a, b) => Number(a.el.style.zIndex) - Number(b.el.style.zIndex))) w.el.style.zIndex = String(++webTop); }
  for (const w of list) w.el.style.zIndex = String(++webTop);
  report();
});
await listen('web-title', e => { const p = webs.get(e.payload.label); if (p) p.setTitle(e.payload.title); });
await listen('web-nav', e => { const p = webs.get(e.payload.label); if (p) p.setUrl(e.payload.url); });
await listen('web-scroll', e => { const p = webs.get(e.payload.label); if (p) p.setScroll(e.payload.p, e.payload.s); });
emit('web-hello', {});
addEventListener('cmr-language', () => { for (const p of panes.values()) p.showTabs(); });                 // (the names of the windows are in the language: drawn again)
// the diagnosis of the options ("진단: 창 상태"): what the system says about each window, and how long a click takes
setInterval(() => {
  if (!lastOs) return;
  for (const p of panes.values()) emit('diag', { label: p.id === MAIN ? 'main' : 'win' + p.id, fgExe: lastOs.fgExe, fgTitle: lastOs.fgTitle, ex: lastOs.ex, lag: p.lags.slice(), mode: `center${mode}/- rv:${p.review ? 1 : 0} zone:${p.zone ? 'through' : '-'} w:${p.wheelCount} nw:0` });
}, 1000);
emit('voice-lamp-hello', {});
emit('win-state-hello', {});
sync();
await applyScale();
if (nativeId === MAIN) {                                          // (the send box is the box of the main window: in a window of the system it is the last row of the page, not a window of its own: sendrow.js)
  mountSendRow(px => { sendInset = px; for (const p of panes.values()) p.place(); });
}
if (nativeId) {                                                    // (where the page starts on the screen: asked for now and then; the pane fills the window, also when the window is made larger)
  const where = async () => { try { const o = await invoke('native_origin', { label }); if (o && (o.x !== ox || o.y !== oy)) { ox = o.x; oy = o.y; } } catch { /* the window is gone */ } };
  await where(); setInterval(where, 250);
  addEventListener('resize', () => { for (const p of panes.values()) p.place(); });
} else await layout(await invoke('center_layout').catch(() => null));
report();
if (!nativeId) invoke('center_ready', { label }).catch(() => {});                    // (the program shows the three centers when all of them have said this: nothing is seen before it is drawn)
setInterval(report, 1000);
perfReport('center' + mode, emit);                                  // (how long the jobs of this page take: the options show it)
