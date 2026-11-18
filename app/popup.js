// The popup window: draws the menu and the tooltips of the translation windows (popup_host.js asks for them) and sizes and places itself
// to what it shows. It never takes the focus (the exe makes the window so). It stays (the setting POPUP_IDLE_MS = 0) or is taken away when nobody needed it.
// Events: popup-hello (a window asks "are you there?") -> popup-ready; popup-show { kind: 'menu' | 'tip', ... }; popup-hide { kind }.
// A chosen menu item is told back: popup-pick { token, id }. Closing it: popup-gone, then the exe destroys the window.
const { listen, emit } = window.__TAURI__.event;
const invoke = window.__TAURI__.core.invoke;
import { isMac } from './platform.js';
const $ = id => document.getElementById(id);

let cur = null;                              // what is shown: { kind, owner, token, within }
let idleTimer = null, loop = null, followLoop = null;
let idleMs = 30000, pollMs = 60, graceMs = 300, shownAt = 0;
let prevDown = true, prevEsc = true;         // (the click that opened the menu is still down: it does not close it)

listen('popup-hello', () => emit('popup-ready', {}));
listen('popup-show', ev => show(ev.payload));
// the window that asked for it takes it away again (a window only takes away its own). A menu that has just opened ignores it for a moment.
listen('popup-hide', ev => {
  const p = ev.payload || {};
  if (!cur || (p.kind && p.kind !== cur.kind) || (p.owner && p.owner !== cur.owner)) return;
  if (cur.kind === 'menu' && performance.now() - shownAt < graceMs) { why('ignored: the window said to close it (just opened)'); return; }
  why('the window said to close it');
  hide();
});
// every close of a MENU is written to the log with its reason (logs/chatmatrix.log): a menu that goes away by itself can be traced
function why(reason) { if (cur && cur.kind === 'menu') emit('hub-log', { level: 'info', msg: `popup: menu: ${reason}` }); }
emit('popup-ready', {});

async function hide() {
  clearInterval(loop); loop = null; clearInterval(followLoop); followLoop = null;
  const had = cur; cur = null;
  $('ctx').hidden = $('tip').hidden = $('wtip').hidden = true;
  if (had) { try { await invoke('popup_hide'); } catch { /* no window to hide */ } }
  clearTimeout(idleTimer);
  if (idleMs > 0) idleTimer = setTimeout(close, idleMs);            // nobody needed it for a while: the web view is not kept for nothing (0 = it stays)
}
async function close() {
  if (cur) return;
  emit('popup-gone', {});
  try { await invoke('popup_close'); } catch { /* already gone */ }
}

function build(items, token, owner) {
  const menu = $('ctx');
  menu.replaceChildren();
  for (const it of items) {
    const d = document.createElement('div');
    d.className = it.cls || '';
    if (it.cls !== 'sep') {
      d.textContent = it.text;
      if (!(it.cls || '').includes('off')) d.onclick = () => { why('an item was chosen'); emit('popup-pick', { owner, token, id: it.id }); hide(); };
    }
    menu.append(d);
  }
  return menu;
}

async function show(p) {
  clearTimeout(idleTimer);
  idleMs = typeof p.idle === 'number' ? p.idle : idleMs;
  pollMs = typeof p.poll === 'number' ? p.poll : pollMs;
  graceMs = typeof p.grace === 'number' ? p.grace : graceMs;
  clearInterval(loop); loop = null; clearInterval(followLoop); followLoop = null;
  cur = { kind: p.kind, owner: p.owner, token: p.token, within: p.within || null };
  $('ctx').hidden = $('tip').hidden = $('wtip').hidden = true;
  let box;
  if (p.kind === 'menu') box = build(p.items || [], p.token, p.owner);
  else if (p.html !== undefined && p.html !== null) { box = $('tip'); box.style.maxWidth = (p.tipWidth || 250) + 'px'; box.innerHTML = p.html; }       // (the tip of a link in the chat: as wide as the setting TIP_MAX_W at most)
  else { box = $('wtip'); box.textContent = p.text || ''; }
  box.hidden = false;
  const r = box.getBoundingClientRect();
  const w = Math.ceil(r.width) + 1, h = Math.ceil(r.height) + 1;                      // CSS pixels (the exe scales them for the monitor it lands on)
  prevDown = true; prevEsc = true;
  // the exe puts it: inside the monitor of the cursor / the widget, on the side where there is room (placement.rs)
  try { await invoke('popup_place', { kind: p.kind, at: p.at || null, anchor: p.anchor || null, w, h }); } catch { cur = null; return; }
  shownAt = performance.now();
  loop = setInterval(check, Math.max(20, pollMs));
  // a link tip follows the cursor (the exe reads the cursor itself and moves the window); the tip of a widget stays at the widget
  const every = typeof p.follow === 'number' ? p.follow : 16;
  if (p.kind === 'tip' && !p.anchor && every > 0) followLoop = setInterval(() => { invoke('popup_follow').catch(() => {}); }, Math.max(8, every));
}

// A Mac gives no mouse-over (and no :hover) to a window that is not the active one, and this one never is: the line of the menu under the cursor is marked from the
// cursor reading of the loop below (x, y in CSS pixels of this page; null = the cursor is not over the window).
function markHot(x, y) {
  const el = x === null ? null : document.elementFromPoint(x, y);
  const line = el && el.closest ? el.closest('#ctx div') : null;
  for (const d of document.querySelectorAll('#ctx div.hot')) if (d !== line) d.classList.remove('hot');
  if (line) line.classList.add('hot');
}

// while it is shown: a click anywhere else (any button) or Esc closes a menu; a tip goes when the pointer has left the window it belongs to
async function check() {
  if (!cur) return;
  let s;
  try { s = await invoke('os_state', { keys: [0x01, 0x02, 0x04, 0x1B] }); } catch { return; }
  if (!cur) return;
  const k = s.keys || [], [cx, cy] = s.cursor, [x, y, w, h] = s.win;
  const down = !!(k[0] || k[1] || k[2]), esc = !!k[3];
  if (cur.kind === 'menu') {
    const inside = cx >= x && cx < x + w && cy >= y && cy < y + h;
    if (isMac) markHot(inside ? (cx - x) / (window.devicePixelRatio || 1) : null, inside ? (cy - y) / (window.devicePixelRatio || 1) : null);
    const early = performance.now() - shownAt < graceMs;            // (the click that opened the menu, or a click right after it, is not "a click elsewhere")
    if (!early && down && !prevDown && !inside) { why(`a click outside: cursor ${cx},${cy} window ${x},${y} ${w}x${h}`); hide(); }
    else if (!early && esc && !prevEsc) { why('Esc'); hide(); }
    else if (early && ((down && !prevDown && !inside) || (esc && !prevEsc))) why(`ignored: ${down ? `a click outside (cursor ${cx},${cy} window ${x},${y} ${w}x${h})` : 'Esc'} (just opened)`);
    prevDown = down; prevEsc = esc;
  } else if (cur.within) {
    const [wx, wy, ww, wh] = cur.within;
    if (cx < wx || cx >= wx + ww || cy < wy || cy >= wy + wh) hide();
  }
}
