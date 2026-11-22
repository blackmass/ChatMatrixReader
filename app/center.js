// A control center (3.2). The page of one of the three transparent windows over all the screens (center.rs): the translation windows of its kind of order (the page says it: ?mode=0
// ordinary, 1 always on top, 2 above the game only) are panes in it (pane.js). The data comes from the hub exactly as it comes to a window of 3.1.1 ('feed', 'feed-replay').
import * as settings from './settings.js';
import { startI18n } from './i18n_host.js';
import { MAIN } from './core/pipeline.js';
import * as winconf from './core/winconf.js';
import * as fonts from './fonts.js';
import { tr } from './core/i18n.js';
import { Pane } from './pane.js';
import { menuList } from './ctxmenu.js';
import { T } from './core/timings.js';
import { isMac } from './platform.js';
import { defaultRegistry } from './widgets/defaults.js';
import { syncPluginDefs } from './widgets/registry.js';

const q = new URLSearchParams(location.search), mode = Number(q.get('mode')) || 0, ox = Number(q.get('ox')) || 0, oy = Number(q.get('oy')) || 0;
const label = 'center' + mode;
const dpr = () => window.devicePixelRatio || 1;
let cfg = await settings.load({ readOnly: true });
await startI18n(settings);
await fonts.loadAll().catch(() => []);
document.title = 'CMR Center ' + mode;

const panes = new Map();                       // window id -> Pane
let lampState = null;                          // the last state of the voice lamp (a pane made later gets it)
let open = new Set([MAIN]);
const center = {
  cfg: () => cfg,
  dpr,
  origin: () => [ox, oy],
  registry: defaultRegistry(),                 // (the widgets: the program's own, and what the plugins register comes by 'widget-defs')
  changed: () => report(),
  menu: (ev, pane) => showMenu(ev, pane),
  // the tips: always the top layer of the page (over every pane). A pane of the ordinary center is under the panes that stay on top, so its tips are drawn by the center of the windows
  // on top (the same look); the others draw their own
  viewSink: { usable: () => true, show: (html, x, y) => tip({ html, x: ox + x * dpr(), y: oy + y * dpr() }), hide: () => tip({ hide: true }) },
  widgetSink: { usable: () => true, show: (text, r) => { const d = dpr(); return tip({ text, rect: [ox + r.left * d, oy + r.top * d, ox + r.right * d, oy + r.bottom * d] }); }, hide: () => tip({ hide: true }) },
  // a pane was touched: it goes to the front of the panes of this center (like an ordinary window); the ordinary center also goes up over the other programs' windows
  raise: p => {
    if (Number(p.el.style.zIndex) !== top) p.el.style.zIndex = String(++top);
    if (mode === 0) invoke('center_raise', { label }).catch(() => {});
  },
};
let top = 1000;
// the kind of order a window has now (settings: "항상 위", "와우 위에서만")
const optOf = (id, key, d) => (id === MAIN ? (cfg[winconf.MAIN_KEY[key] || key] ?? d) : winconf.opt(cfg.child_windows.find(c => c.id === id) || null, cfg, key, d));
const modeOf = id => (optOf(id, 'topmost_wow_only', false) ? 2 : optOf(id, 'topmost', true) ? 1 : 0);

function sync() {
  const want = new Set([...open].filter(id => (id === MAIN || cfg.child_windows.some(c => c.id === id && c.kind !== 'web')) && !winconf.dockHost(cfg.child_windows, id) && modeOf(id) === mode));
  for (const id of want) if (!panes.has(id)) { const p = new Pane(id, center); panes.set(id, p); if (lampState) p.lamp(lampState.st, lampState.title); p.hello(); }
  for (const [id, p] of [...panes]) if (!want.has(id)) { p.destroy(); panes.delete(id); }
  report();
}

// the right-click menu: drawn in this page (it is over all the screens, so it is never cut off); while it is open the page takes all the mouse (see report)
const menuEl = document.createElement('div');
menuEl.id = 'ctx'; menuEl.hidden = true; menuEl.dataset.notr = ''; document.body.append(menuEl);
function hideMenu() { if (menuEl.hidden) return; menuEl.hidden = true; lastKey = ''; report(); }
function showMenu(ev, pane) {
  const list = menuList({ cfg, pane, ev, open });
  menuEl.replaceChildren();
  for (const e of list) {
    const d = document.createElement('div'); d.className = e.cls || '';
    if (e.cls !== 'sep') { d.textContent = e.text; if (e.fn && !(e.cls || '').includes('off')) d.onclick = () => { hideMenu(); e.fn(); }; }
    menuEl.append(d);
  }
  menuEl.hidden = false; lastKey = ''; report();
  menuEl.style.left = Math.max(0, Math.min(ev.clientX, innerWidth - menuEl.offsetWidth - 2)) + 'px';
  menuEl.style.top = Math.max(0, Math.min(ev.clientY, innerHeight - menuEl.offsetHeight - 2)) + 'px';
}
addEventListener('mousedown', ev => { if (!menuEl.contains(ev.target)) hideMenu(); }, true);
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
  const u = Number(e.payload.units), p = panes.get(Number(e.payload.id));
  if (p && Number.isFinite(u) && u) p.wheelScrolled(u);
});
let gameFound = true;                          // no game = the windows stay in view: nothing to click through to
await listen('game-state', e => { gameFound = !!e.payload.found; });
emit('game-hello', {});
let lastKey = '', copyPrev = false;
// runs all the time: the mouse and the keys against the windows (pane.tick), and Ctrl+C (the windows never take the keyboard: the game keeps it)
(async function loop() {
  for (;;) {
    await new Promise(r => setTimeout(r, T.OVERLAY_POLL_MS));
    let s; try { s = await invoke('os_state', { keys: [0x01, 0x11, 0x43] }); } catch { continue; }
    let changed = false;
    for (const p of panes.values()) changed = p.tick(s, { game: gameFound, cfg }) || changed;
    if (changed) report();
    // the turns of the wheel the exe took for the windows (Windows: asked for here; a Mac tells them one by one, see below)
    if (hadWheel && !isMac) {
      try {
        const w = await invoke('center_wheel', { label, seq: Math.max(0, wheelSeq) });
        const first = wheelSeq < 0; wheelSeq = w.seq;
        if (!first) for (const t of w.turns) { const p = panes.get(Number(t.id)); if (p && p.inside) p.wheelScrolled(t.delta); }
      } catch { /* the next round */ }
    }
    const copyKey = !!(s.keys && s.keys[1] && s.keys[2]);
    if (copyKey && !copyPrev) { const picked = getSelection().toString(); if (picked) { try { window.__TAURI__.clipboardManager.writeText(picked); } catch { /* no clipboard */ } } }
    copyPrev = copyKey;
  }
})();
function report() {
  const list = [...panes.values()].map(p => ({ ...p.box(), hit: p.interactive, blur: p.blurLevel() }));          // (a window that is click-through takes no mouse: it goes through; the place is kept for the send box)
  const wheel = [...panes.values()].filter(p => p.zone).map(p => p.box());                    // (the wheel over these goes to the window, not to the game)
  if (!menuEl.hidden) list.push({ id: 'menu', x: 0, y: 0, w: innerWidth * center.dpr(), h: innerHeight * center.dpr(), bar: 0 });          // (while the menu is open, the center takes the whole mouse: a click anywhere else closes it)
  const key = JSON.stringify([list, wheel]);
  if (key === lastKey) return;
  lastKey = key;
  if (wheel.length && !hadWheel) wheelSeq = -1;                              // (the turns from before are not wanted: the loop takes the newest number)
  hadWheel = wheel.length > 0;
  invoke('center_rects', { label, panes: list, wheel }).then(ok => {
    if (ok === false) { lastKey = ''; if (!wheelWarned) { wheelWarned = true; emit('hub-log', { level: 'warn', msg: `${label}: the wheel over a click-through window is not available (the permission is missing?)` }); } }
  }).catch(e => { lastKey = ''; if (!wheelWarned) { wheelWarned = true; emit('hub-log', { level: 'warn', msg: `${label}: ${e}` }); } });
}
let hadWheel = false, wheelSeq = 0, wheelWarned = false;

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

settings.onChange(c => { cfg = c; for (const p of panes.values()) p.update(); sync(); });
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
emit('voice-lamp-hello', {});
emit('win-state-hello', {});
sync();
setInterval(report, 1000);
