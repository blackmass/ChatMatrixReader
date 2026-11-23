// The windows of the mini browser (the hub runs this): the web windows the USER opens (core/browsers.js has their settings, window 1 is the default one). The window of the system is made by
// webwin.rs (the same as for a plugin, but it may go to any http or https address); its bar, its address and its order are the control center's (center.js, webpane.js). This file opens and closes
// the windows (what the menus and the options ask: 'browser-command'), keeps where each window is and the address it was at, and tells the centers which are open ('web-state').
import * as B from './core/browsers.js';
import { mobileProfile, desktopProfile } from './web_host.js';

const INFO_MS = 500, SAVE_MS = 600, NAV_MS = 800;
const parseGeom = t => { const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(String(t || '')); return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null; };
export const browserLabel = id => 'web_b' + Number(id);
export const browserKey = id => 'browser' + Number(id);                       // (the name of the folder of its cookies: a window that keeps the login)

export function startBrowsers({ settings, invoke, emit, listen, note = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  const open = new Map();                       // id -> { label, title, timers, last, pending, saveAt, navAt, url, mode }
  const once = new Map();                       // id -> { mode, url }: for the next time it is opened (a window that changes between the phone and the computer by being opened again)
  const list = () => settings.cfg().browser_windows || [];
  const entry = id => list().find(b => b.id === id);
  const change = (id, patch) => settings.set({ browser_windows: list().map(b => (b.id === id ? { ...b, ...patch } : b)) });
  const publish = () => emit('web-state', { source: 'browser', windows: [...open].map(([id, o]) => ({ kind: 'browser', win: id, label: o.label, title: o.title, mode: o.mode, lock: !!(entry(id) || {}).lock_window })) });

  function stop(id) {
    const o = open.get(id);
    if (!o) return;
    for (const t of o.timers) clearTimer(t);
    open.delete(id);
    publish();
  }

  async function openWindow(id) {
    const b = entry(id);
    if (!b || open.has(id)) return;
    const again = once.get(id); once.delete(id);
    let url = b.start_kind === 'last' && B.isWebUrl(b.last_url) ? b.last_url : (B.isWebUrl(b.start_url) ? b.start_url : B.START_URL);
    if (again && B.isWebUrl(again.url)) url = again.url;
    const mode = again ? again.mode : b.mode;
    const g = parseGeom(b.geometry), label = browserLabel(id);
    const phone = mode === 'mobile' ? mobileProfile() : {};
    const size = g || (mode === 'pc' ? { w: 960, h: 640 } : { w: 360, h: 640 });
    const args = { label, url, title: '', ua: phone.ua || '', ua_hints: phone.hints || null, allow: [], open_allow: ['*'], free: true, persist: !!b.persist, zoom: b.zoom || 1, shift_scroll: !!b.shift_scroll, ctrl_zoom: b.ctrl_zoom !== false, key: browserKey(id), render: settings.cfg().web_render || 'auto', w: size.w, h: size.h };
    if (g) { args.x = g.x; args.y = g.y; }
    try { await invoke('web_open', { args }); } catch (e) { note('mini browser: ' + e); return; }
    const o = { label, title: '', timers: [], last: '', pending: null, saveAt: 0, navAt: 0, url, mode };
    open.set(id, o);
    publish();
    o.timers.push(setTimer(() => info(id, o), INFO_MS));
    note('mini browser opened: ' + url);
  }

  // the place of the window is kept a moment after it stopped changing (the window of the system is put where the center draws the page)
  async function info(id, o) {
    const i = await invoke('web_info', { label: o.label }).catch(() => null);
    if (!i) return;
    if (!i.exists) { stop(id); return; }
    if (i.position && i.size) {
      const key = i.position.join(',') + ',' + i.size.join(',');
      if (key !== o.last) { o.last = key; o.saveAt = Date.now() + SAVE_MS; o.pending = `${i.size[0]}x${i.size[1]}+${i.position[0]}+${i.position[1]}`; }
      if (o.pending && Date.now() >= o.saveAt) { const g = o.pending; o.pending = null; if (entry(id) && entry(id).geometry !== g) change(id, { geometry: g }); }
    }
  }

  async function closeWindow(id) {
    const o = open.get(id);
    if (!o) return;
    stop(id);
    await invoke('web_close', { label: o.label }).catch(() => {});
  }

  // The window goes to the other way of seeing a page (the phone / the computer), for as long as it is open: the settings are not changed. Windows: the web view is told what it is now and the page is
  // loaded again, nothing is closed (the login stays). Where that is not possible the window is opened again at the same address (a login that is not kept is lost).
  async function switchMode(id) {
    const o = open.get(id); if (!o) return;
    const to = o.mode === 'pc' ? 'mobile' : 'pc';
    try {
      const p = to === 'mobile' ? mobileProfile() : await desktopProfile();
      await invoke('web_ua', { label: o.label, ua: p.ua, hints: p.hints || null });
      o.mode = to; publish();
      await invoke('web_cmd', { label: o.label, cmd: 'reload' }).catch(() => {});
      note('mini browser: window ' + id + ' now looks like ' + to);
    } catch {
      once.set(id, { mode: to, url: o.url });
      await closeWindow(id); await openWindow(id);
    }
  }

  // cookies and the rest: a window that is open does it itself, a window that is not has its folder taken away
  async function clearData(id) {
    const o = open.get(id);
    try { if (o) await invoke('web_clear', { label: o.label }); else await invoke('web_forget', { key: browserKey(id) }); note('mini browser: the login of window ' + id + ' was cleared'); } catch (e) { note('mini browser: ' + e); }
  }

  listen('browser-command', e => {
    const { cmd, id } = e.payload || {};
    if (!Number.isInteger(id)) return;
    if (cmd === 'open') openWindow(id);
    else if (cmd === 'close') closeWindow(id);
    else if (cmd === 'toggle') (open.has(id) ? closeWindow(id) : openWindow(id));
    else if (cmd === 'clear') clearData(id);
    else if (cmd === 'mode') switchMode(id);
  });
  listen('web-close', e => { const hit = [...open].find(([, o]) => o.label === (e.payload || {}).label); if (hit) closeWindow(hit[0]); });
  listen('web-hello', publish);
  // the page was made larger or smaller (Ctrl + the wheel, Ctrl + + / - / 0, a pinch): kept for the window
  listen('web-zoom', e => {
    const { label, zoom } = e.payload || {};
    const hit = [...open].find(([, o]) => o.label === label);
    if (!hit || !Number.isFinite(zoom)) return;
    const [id, o] = hit; clearTimeout(o.zoomT);
    o.zoomT = setTimeout(() => { const b = entry(id), z = Math.round(zoom * 10) / 10; if (b && b.zoom !== z) change(id, { zoom: z }); }, NAV_MS);
  });
  listen('browser-geometry', e => { const { id, geometry } = e.payload || {}; if (Number.isInteger(id) && entry(id) && /^\d+x\d+\+-?\d+\+-?\d+$/.test(String(geometry)) && entry(id).geometry !== geometry) change(id, { geometry }); });
  // the address the page goes to: kept as "the address seen last" (a moment after the last change: pages go to several addresses while they load)
  listen('web-nav', e => {
    const { label, url } = e.payload || {};
    const hit = [...open].find(([, o]) => o.label === label);
    if (!hit || !B.isWebUrl(url)) return;
    const [id, o] = hit; o.url = url; clearTimeout(o.navT);
    o.navT = setTimeout(() => { const b = entry(id); if (b && b.last_url !== url) change(id, { last_url: url }); }, NAV_MS);
  });
  // a window that was deleted in the options goes with its entry
  // (a window that is deleted in the options takes the login it kept with it: no folder is left behind)
  let had = new Set(list().map(b => b.id));
  settings.onChange(() => {
    for (const id of [...open.keys()]) if (!entry(id)) closeWindow(id);
    const now = new Set(list().map(b => b.id));
    for (const id of had) if (!now.has(id)) invoke('web_forget', { key: browserKey(id) }).catch(() => {});
    had = now;
  });

  return { isOpen: id => open.has(id), openIds: () => [...open.keys()], open: openWindow, close: closeWindow, toggle: id => (open.has(id) ? closeWindow(id) : openWindow(id)), clearData };
}
