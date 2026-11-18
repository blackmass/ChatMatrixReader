// The menu and the tooltips of a translation window are drawn by a small window of their own (popup.html, made by the exe when it is first
// needed and taken away again after a while): so a small translation window does not cut them off, and they can lie over its edge.
// This is the side of the translation window: it asks for the popup and tells it what to show. Where the popup window could not be made `usable()` says
// false and the page draws the menu / the tip in itself, as before. (Windows and macOS: the same popup; on a Mac it is a panel that does not take the keyboard.)
//   popup.menu({ items: [{ id, text, cls }], at: [x, y], onPick(id) })     real screen pixels; cls: 'on' (ticked) | 'off' (grey, no click) | 'sep'
//   popup.tip({ html | text, at: [x, y] | anchor: [l, t, r, b], within })    a point: below right of it; an anchor: above it (centred)
//   popup.hide('menu' | 'tip')
import { T } from './core/timings.js';

const { emit, listen } = window.__TAURI__.event;
const invoke = window.__TAURI__.core.invoke;
const label = window.__TAURI__.window.getCurrentWindow().label;

const wanted = () => !globalThis.__cmrNoPopup;                          // (the flag: the tests of the page's own menu switch the popup off)
let state = 'new';                         // new | ready | off (it cannot be made: the page draws it itself)
let gotReady = false, opening = null, offUntil = 0;
const picks = new Map();                   // token -> onPick (kept until the menu goes away)
let tokenN = 0;

listen('popup-ready', () => { gotReady = true; });
listen('popup-gone', () => { gotReady = false; if (state === 'ready') state = 'new'; });
listen('popup-pick', ev => { const f = picks.get(ev.payload.token); picks.clear(); if (f && ev.payload.id !== undefined) f(ev.payload.id); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ensure() {
  if (!wanted()) return false;
  if (state === 'ready') return true;
  if (state === 'off' && performance.now() < offUntil) return false;
  if (!opening) opening = (async () => {
    try {
      await invoke('popup_open');
      for (let i = 0; i < 40 && !gotReady; i++) { emit('popup-hello', {}); await sleep(100); }      // (the page of a new window has to load first)
      state = gotReady ? 'ready' : 'off';
    } catch { state = 'off'; }
    if (state === 'off') offUntil = performance.now() + 15000;        // (tried again later: a window that could not be made is not a reason to give up for good)
    opening = null;
    return state === 'ready';
  })();
  return opening;
}

const gen = { menu: 0, tip: 0 };           // a hide (or a newer show) while the window is still being made cancels the show that waits for it
async function send(payload) {
  const g = ++gen[payload.kind];
  if (!(await ensure())) return false;
  if (g !== gen[payload.kind]) return true;                           // (cancelled: nothing to draw in the page either)
  emit('popup-show', { ...payload, owner: label, idle: T.POPUP_IDLE_MS, poll: T.POPUP_POLL_MS, grace: T.POPUP_GRACE_MS, follow: T.POPUP_FOLLOW_MS, tipWidth: T.TIP_MAX_W });
  return true;
}

export const popup = {
  // makes the window ahead of time (the program has just started and the first tip should not wait for it)
  warm() { if (wanted()) ensure(); },
  // true: the popup is (or can be) used; false: draw it in the page
  usable: () => wanted() && !(state === 'off' && performance.now() < offUntil),
  menu({ items, at, onPick }) {
    picks.clear();
    const token = `${label}:${++tokenN}`;
    picks.set(token, onPick);
    return send({ kind: 'menu', token, items, at });
  },
  tip({ html, text, at, anchor, within }) { return send({ kind: 'tip', html, text, at, anchor, within }); },       // within: the window it belongs to [x, y, w, h]: the tip goes with the pointer
  hide(kind) { if (kind) gen[kind]++; else { gen.menu++; gen.tip++; } emit('popup-hide', { kind, owner: label }); if (kind !== 'tip') picks.clear(); },
};
