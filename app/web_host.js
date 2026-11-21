// The web windows of the plugins (the hub runs this): one window per plugin that shows a page of the web (src-tauri/src/webwin.rs makes the window and keeps it to the addresses it
// may go to). What the user chose for it is in its entry of the list of windows (child_windows, kind 'web': Options > Window: topmost, topmost_wow_only, click_through, lock_window, geometry);
// only the cookies are a setting of the plugin (config.plugins[id].web.cookies).
// This file keeps the order of the window (always on top / above the game only: the same two states the program's own windows have), click-through and the lock, and remembers where the window is.
import { webPatterns } from './core/plugins.js';

export const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const TICK_MS = 100, INFO_MS = 1000, GAME_MS = 2000, SAVE_MS = 1500, DEFAULT_W = 360, DEFAULT_H = 640;
const parseGeom = t => { const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(String(t || '')); return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null; };
export const webLabel = id => 'web_' + String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);

export function createWebHost({ getEntry, getConf, patchConf, invoke, note, wowTitle = () => 'World of Warcraft', setTimer = setInterval, clearTimer = clearInterval }) {
  const open = new Map();                       // id -> { label, timers, game, ignore, lock, saveAt, last }
  // what the user chose (the window entry may not be there yet: the defaults of a new window)
  const opts = id => {
    const c = getConf(id) || {}, g = parseGeom(c.geometry);
    return { topmost: c.topmost !== false && !c.topmost_wow_only, wow: !!c.topmost_wow_only, through: !!c.click_through, lock: !!c.lock_window, cookies: !!(((getEntry(id) || {}).web) || {}).cookies, ...(g || {}) };
  };

  function stopLoop(id) {
    const o = open.get(id);
    if (!o) return;
    for (const t of o.timers) clearTimer(t);
    open.delete(id);
  }

  async function start(id, o) {
    const call = (name, args) => invoke(name, { label: o.label, ...args });
    const tick = async () => {
      const w = opts(id);
      const mode = w.topmost ? 1 : w.wow ? 2 : 0;
      await call('web_tick', { mode, game: o.game || null }).catch(() => {});
      if (w.through !== o.ignore) { o.ignore = w.through; await call('web_ignore', { on: w.through }).catch(() => {}); }
      if (w.lock !== o.lock) { o.lock = w.lock; await call('web_lock', { on: w.lock }).catch(() => {}); }
    };
    const follow = async () => {
      if (!opts(id).wow || opts(id).topmost) { o.game = 0; return; }
      try { const g = await invoke('find_game', { known: o.game || null, title: wowTitle() }); o.game = g ? g.hwnd : 0; } catch { /* next round */ }
    };
    const info = async () => {
      const i = await call('web_info', {}).catch(() => null);
      if (!i) return;
      if (!i.exists) { stopLoop(id); note(id, 'web window closed'); return; }
      if (i.position && i.size) {                                   // the place is remembered (a moment after it stopped changing)
        const key = i.position.join(',') + ',' + i.size.join(',');
        if (key !== o.last) { o.last = key; o.saveAt = Date.now() + SAVE_MS; o.pending = { x: i.position[0], y: i.position[1], w: i.size[0], h: i.size[1] }; }
        if (o.pending && Date.now() >= o.saveAt) { const p = o.pending; o.pending = null; patchConf(id, { geometry: `${p.w}x${p.h}+${p.x}+${p.y}` }); }
      }
    };
    o.timers.push(setTimer(tick, TICK_MS), setTimer(info, INFO_MS), setTimer(follow, GAME_MS));
    await follow();
  }

  return {
    // url: the address (the bridge has checked it); patterns: what the window may go to
    async open(id, { url, title = '', mobile = true }, patterns) {
      const w = opts(id);
      const args = { label: webLabel(id), url, title, ua: mobile ? MOBILE_UA : '', allow: patterns, persist: !!w.cookies, key: id, lock: !!w.lock,
        w: Number.isFinite(w.w) ? w.w : null, h: Number.isFinite(w.h) ? w.h : null, x: Number.isFinite(w.x) ? w.x : null, y: Number.isFinite(w.y) ? w.y : null };
      if (args.w === null || args.h === null) { delete args.w; delete args.h; delete args.x; delete args.y; args.w = DEFAULT_W; args.h = DEFAULT_H; }
      await invoke('web_open', { args });
      if (!open.has(id)) {
        const o = { label: webLabel(id), timers: [], game: 0, ignore: false, lock: !!w.lock, saveAt: 0, last: '', pending: null };
        open.set(id, o);
        await start(id, o);
        note(id, 'web window opened: ' + url);
      } else note(id, 'web window goes to: ' + url);
    },
    async close(id) {
      const label = webLabel(id);
      stopLoop(id);
      await invoke('web_close', { label }).catch(() => {});
    },
    isOpen: id => open.has(id),
    // the user took something away from what the window may go to
    async allow(id, patterns) { if (open.has(id)) await invoke('web_allow', { label: webLabel(id), allow: patterns }).catch(() => {}); },
    // cookies and the rest the pages stored (the window must be open: the web view does it)
    async clearData(id) { await invoke('web_clear', { label: webLabel(id) }); },
    async blocked() { return invoke('web_blocked', {}).catch(() => []); },
    patterns: (hosts, scope) => webPatterns(hosts, scope),
  };
}
