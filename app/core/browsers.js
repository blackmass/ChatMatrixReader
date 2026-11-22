// The browser windows of the mini browser and the bookmarks (config keys `browser_windows` and `bookmarks`): what is kept, and how what was read from the file is made right. The windows
// of the plugins (a plugin that shows a page of the web) are not here: they are entries of the list of windows (kind 'web') with the addresses they may go to.
//   browser window: { id, name, mode: 'mobile' | 'pc', start_kind: 'url' | 'last', start_url, last_url, persist, topmost, topmost_wow_only, lock_window, geometry }
//   (zoom: 0.3 .. 3, 1 = 100 %)
//   Window 1 is the default window (mobile, Google): it is always there and is not deleted. At most MAX_BROWSERS windows.
export const MAX_BROWSERS = 10;
export const MAX_BOOKMARKS = 200;
export const DEFAULT_ID = 1;
export const START_URL = 'https://www.google.com/';

// an address a browser window may be sent to: http or https, one piece of text without spaces
export const isWebUrl = text => {
  if (typeof text !== 'string' || text.length > 2000 || /\s/.test(text)) return false;
  try { const u = new URL(text); return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname; } catch { return false; }
};

export const defaultBrowser = id => ({
  id, name: '', mode: 'mobile', start_kind: 'url', start_url: START_URL, last_url: '', persist: false,
  topmost: true, topmost_wow_only: false, lock_window: false, geometry: '', zoom: 1,
});

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const flag = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

// the list as it is read: anything wrong is put right; window 1 is made when it is missing; no more than MAX_BROWSERS; the order is the order of the numbers
export function normalizeBrowsers(list) {
  const seen = new Set(), out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object') continue;
    const id = Number.isInteger(it.id) && it.id >= 1 ? it.id : 0;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const d = defaultBrowser(id);
    d.name = text(it.name, 40);
    d.mode = it.mode === 'pc' ? 'pc' : 'mobile';
    d.start_kind = it.start_kind === 'last' ? 'last' : 'url';
    d.start_url = isWebUrl(text(it.start_url, 2000)) ? text(it.start_url, 2000) : START_URL;
    d.last_url = isWebUrl(text(it.last_url, 2000)) ? text(it.last_url, 2000) : '';
    d.persist = flag(it.persist, false);
    d.topmost = flag(it.topmost, true); d.topmost_wow_only = flag(it.topmost_wow_only, false);
    if (d.topmost_wow_only) d.topmost = false;
    d.lock_window = flag(it.lock_window, false);
    d.geometry = /^\d+x\d+\+-?\d+\+-?\d+$/.test(text(it.geometry, 40)) ? text(it.geometry, 40) : '';
    d.zoom = Number.isFinite(it.zoom) ? Math.min(3, Math.max(0.3, Math.round(it.zoom * 10) / 10)) : 1;             // (how large the page is drawn: 30 % .. 300 %, by steps of 10 %)
    out.push(d);
  }
  if (!seen.has(DEFAULT_ID)) out.push(defaultBrowser(DEFAULT_ID));
  out.sort((a, b) => a.id - b.id);
  return out.slice(0, MAX_BROWSERS);                               // (window 1 is first: it is never the one that is cut off)
}

export const nextBrowserId = list => Math.max(DEFAULT_ID, ...(list || []).map(b => b.id)) + 1;
export const canAddBrowser = list => (list || []).length < MAX_BROWSERS;

// the name shown for a window: the one it was given, else the default one (window 1 "모바일", the others "브라우저 N")
const plain = (s, p) => s.replace(/\{(\w+)\}/g, (m, k) => (p && k in p ? p[k] : m));          // (the text as it is: the pages give the translating function)
export const browserName = (list, id, tr = plain) => {
  const b = (list || []).find(x => x.id === id);
  return (b && b.name) || (id === DEFAULT_ID ? tr('모바일') : tr('브라우저 {n}', { n: id }));
};

// the bookmarks: [{ name, url }]; a bookmark without a good address is dropped; the name is the host when it was left empty
export function normalizeBookmarks(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object') continue;
    const url = text(it.url, 2000);
    if (!isWebUrl(url)) continue;
    let name = text(it.name, 80);
    if (!name) { try { name = new URL(url).hostname; } catch { name = url; } }
    out.push({ name, url });
    if (out.length >= MAX_BOOKMARKS) break;
  }
  return out;
}

// What was typed in the address bar -> an address: a good address as it is; something that looks like a site ("namu.wiki/w/x", "localhost:3000") gets https://; anything else is a search
export function addressFrom(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (isWebUrl(t)) return t;
  if (!/\s/.test(t) && !t.includes('://') && /^[^\s/]+\.[^\s/]{2,}(?:[/?#].*)?$|^localhost(?::\d+)?(?:[/?#].*)?$/i.test(t) && isWebUrl('https://' + t)) return 'https://' + t;
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}
