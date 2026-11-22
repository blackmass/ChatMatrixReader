// The web windows of the plugins (the hub runs this): one window per plugin that shows a page of the web (src-tauri/src/webwin.rs makes the window and keeps it to the addresses it
// may go to). What the user chose for it is in its entry of the list of windows (child_windows, kind 'web': Options > Window: topmost, topmost_wow_only, click_through, lock_window, geometry);
// only the cookies are a setting of the plugin (config.plugins[id].web.cookies).
// This file keeps the list of what is open (told to the control centers, which draw the bar of each window and decide its order: center.js, webpane.js) and remembers where the window is.
import { webPatterns } from './core/plugins.js';

// The phone a window of the mini browser visits as. The web view of Windows is a Chromium: a phone's Chrome (the version of this web view: what the page's own user agent says) with the headers of the
// browser (client hints) that say the same; an iPhone's Safari there is a user agent that nothing else about the browser agrees with, and sites that look at it ask for a check. A Mac's web view is
// WebKit: there the iPhone's Safari is the truth.
export function mobileProfile(nav = navigator) {
  const ua = String(nav.userAgent || '');
  if (/Macintosh|Mac OS X/.test(ua) || /Mac/.test(String(nav.platform || ''))) return { ua: MOBILE_UA };
  const major = (/Chrome\/(\d+)/.exec(ua) || [])[1] || '124';
  const brands = [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not.A/Brand', version: '99' }];
  return {
    ua: `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    hints: { brands, fullVersionList: brands.map(b => ({ brand: b.brand, version: b.version === '99' ? '99.0.0.0' : major + '.0.0.0' })), platform: 'Android', platformVersion: '13.0.0', architecture: '', model: 'Pixel 7', mobile: true },
  };
}
// The page's own: what this web view says it is (for a window that goes back from the phone to the computer).
export async function desktopProfile(nav = navigator) {
  const ua = String(nav.userAgent || ''), d = nav.userAgentData;
  if (!d || !d.getHighEntropyValues) return { ua };
  try {
    const v = await d.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64']);
    const pick = l => (l || []).map(b => ({ brand: b.brand, version: b.version }));
    return { ua, hints: { brands: pick(d.brands), fullVersionList: pick(v.fullVersionList), platform: d.platform || 'Windows', platformVersion: v.platformVersion || '', architecture: v.architecture || '', model: v.model || '', mobile: false, bitness: v.bitness || '', wow64: !!v.wow64 } };
  } catch { return { ua }; }
}
export const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const INFO_MS = 500, SAVE_MS = 600, DEFAULT_W = 360, DEFAULT_H = 640;
const parseGeom = t => { const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(String(t || '')); return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null; };
export const webLabel = id => 'web_' + String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);

export function createWebHost({ getEntry, getConf, patchConf, invoke, note, getRender = () => 'auto', emit = () => {}, listen = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  const open = new Map();                       // id -> { label, title, timers, saveAt, last }
  // what the user chose (the window entry may not be there yet: the defaults of a new window)
  const opts = id => {
    const c = getConf(id) || {}, g = parseGeom(c.geometry);
    return { cookies: !!(((getEntry(id) || {}).web) || {}).cookies, ...(g || {}) };
  };

  // the open windows, told to the centers: { win: the number of its entry in the list of windows, label, title, lock }
  const publish = () => emit('web-state', { source: 'plugin', windows: [...open].map(([id, o]) => ({ kind: 'web', win: (getConf(id) || {}).id || 0, label: o.label, title: o.title, lock: !!(getConf(id) || {}).lock_window })) });
  listen('web-hello', publish);
  listen('web-close', e => { const hit = [...open].find(([, o]) => o.label === (e.payload || {}).label); if (hit) api.close(hit[0]); });

  function stopLoop(id) {
    const o = open.get(id);
    if (!o) return;
    for (const t of o.timers) clearTimer(t);
    open.delete(id);
    publish();
  }

  async function start(id, o) {
    const call = (name, args) => invoke(name, { label: o.label, ...args });
    // the program tells the place the window had when it was closed ("geometry WxH+X+Y"): kept, so a window that is opened, moved and closed at once is not forgotten
    const saveGeom = t => { const m = /^geometry (\d+x\d+\+-?\d+\+-?\d+)$/.exec(String(t)); if (m) patchConf(id, { geometry: m[1] }); return !!m; };
    const info = async () => {
      for (const t of await invoke('web_events', {}).catch(() => [])) { if (!saveGeom(t)) note(id, 'web window: ' + t); }
      const i = await call('web_info', {}).catch(() => null);
      if (!i) return;
      if (!i.exists) { stopLoop(id); note(id, 'web window closed'); return; }
      if (i.position && i.size) {                                   // the place is remembered (a moment after it stopped changing)
        const key = i.position.join(',') + ',' + i.size.join(',');
        if (key !== o.last) { o.last = key; o.saveAt = Date.now() + SAVE_MS; o.pending = { x: i.position[0], y: i.position[1], w: i.size[0], h: i.size[1] }; }
        if (o.pending && Date.now() >= o.saveAt) { const p = o.pending; o.pending = null; patchConf(id, { geometry: `${p.w}x${p.h}+${p.x}+${p.y}` }); }
      }
    };
    o.timers.push(setTimer(info, INFO_MS));
  }

  const api = {
    // url: the address (the bridge has checked it); patterns: what the window may go to
    async open(id, { url, title = '', mobile = true }, patterns, openAllow = []) {
      const w = opts(id);
      const phone = mobile ? mobileProfile() : {};                    // (the same phone as a window of the mini browser: the user agent and the headers of the browser that say the same)
      const args = { label: webLabel(id), url, title, ua: phone.ua || '', ua_hints: phone.hints || null, allow: patterns, open_allow: openAllow, persist: !!w.cookies, key: id, render: getRender(),
        w: Number.isFinite(w.w) ? w.w : null, h: Number.isFinite(w.h) ? w.h : null, x: Number.isFinite(w.x) ? w.x : null, y: Number.isFinite(w.y) ? w.y : null };
      if (args.w === null || args.h === null) { delete args.w; delete args.h; delete args.x; delete args.y; args.w = DEFAULT_W; args.h = DEFAULT_H; }
      await invoke('web_open', { args });
      if (!open.has(id)) {
        const o = { label: webLabel(id), title, timers: [], saveAt: 0, last: '', pending: null };
        open.set(id, o);
        publish();
        await start(id, o);
        note(id, 'web window opened: ' + url);
      } else note(id, 'web window goes to: ' + url);
    },
    async close(id) {
      const label = webLabel(id);
      const i = open.has(id) ? await invoke('web_info', { label }).catch(() => null) : null;       // (the place it has now: kept before it goes)
      if (i && i.exists && i.position && i.size) patchConf(id, { geometry: `${i.size[0]}x${i.size[1]}+${i.position[0]}+${i.position[1]}` });
      stopLoop(id);
      await invoke('web_close', { label }).catch(() => {});
    },
    isOpen: id => open.has(id),
    // the user took something away from what the window may go to
    async allow(id, patterns, openAllow = []) { if (open.has(id)) await invoke('web_allow', { label: webLabel(id), allow: patterns, openAllow }).catch(() => {}); },
    // cookies and the rest the pages stored (the window must be open: the web view does it)
    async clearData(id) { await invoke('web_clear', { label: webLabel(id) }); },
    patterns: (hosts, scope) => webPatterns(hosts, scope),
  };
  return api;
}
