// Plugins (no window code): reading the manifest (plugin.json) of a plugin folder, the permissions it asks for, and what the user has allowed.
// The folder `plugins/<id>/` holds the plugin; its manifest says who it is and what it needs. Nothing is allowed that the manifest does not ask for,
// and nothing that the user has not approved (the approvals are kept in the settings, never in the plugin folder).
//
//   const r = parseManifest(text, folderName)      -> { ok, errors: [], warnings: [], manifest }   (manifest = the clean version of it)
//   missing(manifest, granted)                     -> what is asked for and not yet allowed (to show for approval)
//   effective(manifest, granted)                   -> what the plugin may really do now (the asked for AND allowed)

export const API_VERSION = 1;                         // the version of the plugin interface this program speaks
export const MAX_OPTIONS = 50;
export const MAX_WINDOWS = 3;
export const PERMISSIONS = ['net', 'netAny', 'chat.inject', 'storage', 'widgets', 'windows'];
export const MAX_USER_HOSTS = 30;                    // the hosts the user may allow for one plugin (netAny)
export const MAX_REQUESTS = 10;                      // requests of hosts that wait for the user's answer      // (a timer is not a permission: a plugin has its own setInterval; what costs is limited where it is called)
export const OPTION_TYPES = ['text', 'number', 'check', 'select'];
export const RECOMMENDED_ID_LENGTH = 16;              // an id this long is not easy to guess or to clash with (a warning below this)

const ID = /^[a-z0-9_-]{1,100}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const VERSION = /^\d{1,4}(\.\d{1,4}){0,3}(-[0-9A-Za-z.]{1,20})?$/;
// an exact host name: labels of letters, digits and '-', at least one dot. No wildcard, no port, no path, no user name; not an address of a network (IPv4 / IPv6) and not a local name
const HOST = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_END = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet'];

export const validId = id => typeof id === 'string' && ID.test(id);

export function validHost(h) {
  if (typeof h !== 'string') return false;
  const x = h.trim().toLowerCase();
  if (x !== h || !HOST.test(x)) return false;                         // (the TLD begins with a letter: a number like 10.0.0.1 is not a host name)
  return !LOCAL_END.some(e => x.endsWith(e)) && x !== 'localhost';
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanOptions(list, errors) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) { errors.push('options: must be a list'); return []; }
  if (list.length > MAX_OPTIONS) errors.push(`options: at most ${MAX_OPTIONS}`);
  const out = [], seen = new Set();
  for (const [i, o] of list.slice(0, MAX_OPTIONS).entries()) {
    const at = `options[${i}]`;
    if (!isObj(o) || !KEY.test(o.key || '') || seen.has(o.key)) { errors.push(`${at}: a key of letters, digits and '_' (no repeat) is needed`); continue; }
    if (!OPTION_TYPES.includes(o.type)) { errors.push(`${at}: type must be one of ${OPTION_TYPES.join(', ')}`); continue; }
    seen.add(o.key);
    const c = { key: o.key, type: o.type, label: str(o.label, 80) || o.key };
    if (o.note !== undefined) c.note = str(o.note, 400);
    if (o.type === 'check') c.default = !!o.default;
    else if (o.type === 'number') {
      const n = Number(o.default); c.default = Number.isFinite(n) ? n : 0;
      if (Number.isFinite(Number(o.min))) c.min = Number(o.min);
      if (Number.isFinite(Number(o.max))) c.max = Number(o.max);
    } else if (o.type === 'select') {
      const choices = Array.isArray(o.choices) ? o.choices.filter(x => isObj(x) && typeof x.value === 'string').slice(0, 50).map(x => ({ value: x.value.slice(0, 80), label: str(x.label, 80) || x.value.slice(0, 80) })) : [];
      if (!choices.length) { errors.push(`${at}: a select needs choices [{ value, label }]`); continue; }
      c.choices = choices;
      c.default = choices.some(x => x.value === o.default) ? o.default : choices[0].value;
    } else c.default = str(o.default, 500);
    out.push(c);
  }
  return out;
}

// the windows a plugin may have: [{ id, title, page, width, height }] (the user sees them in the list of windows; the plugin opens and closes them)
const WIN_ID = /^[a-z0-9_-]{1,24}$/;
const PAGE = /^[A-Za-z0-9_\-./]{1,200}\.html$/;
const validPage = f => typeof f === 'string' && PAGE.test(f) && !f.includes('..') && !f.startsWith('/') && !f.includes('//');
function cleanWindows(list, errors) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) { errors.push('windows: must be a list'); return []; }
  if (list.length > MAX_WINDOWS) errors.push(`windows: at most ${MAX_WINDOWS}`);
  const out = [], seen = new Set();
  for (const [i, w] of list.slice(0, MAX_WINDOWS).entries()) {
    const at = `windows[${i}]`;
    if (!isObj(w) || !WIN_ID.test(w.id || '') || seen.has(w.id)) { errors.push(`${at}: an id of letters, digits, '-' and '_' (no repeat) is needed`); continue; }
    if (!validPage(w.page)) { errors.push(`${at}: page must be a .html file inside the folder`); continue; }
    seen.add(w.id);
    const size = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(2000, Math.max(120, n)) : d; };
    out.push({ id: w.id, title: str(w.title, 40) || w.id, page: w.page, width: size(w.width, 420), height: size(w.height, 300) });
  }
  return out;
}
export const windowsOf = manifest => manifest.windows || [];

export function parseManifest(text, folder) {
  const errors = [], warnings = [];
  let m;
  try { m = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { return { ok: false, errors: ['plugin.json is not valid JSON: ' + (e && e.message)], warnings, manifest: null }; }
  if (!isObj(m)) return { ok: false, errors: ['plugin.json must be an object'], warnings, manifest: null };
  if (!validId(m.id)) errors.push("id: lower case letters, digits, '-' and '_' (at most 100)");
  else if (m.id !== folder) errors.push(`id "${m.id}" is not the name of the folder "${folder}"`);
  else if (m.id.length < RECOMMENDED_ID_LENGTH) warnings.push(`id is short (${m.id.length}): a long id that nobody else would choose avoids a clash with another plugin`);
  const name = str(m.name, 60);
  if (!name) errors.push('name is needed');
  const version = str(m.version, 30);
  if (!VERSION.test(version)) errors.push('version: like 1.0.0');
  if (!Number.isInteger(m.api) || m.api < 1) errors.push('api: the number of the plugin interface (now 1)');
  else if (m.api > API_VERSION) errors.push(`api ${m.api} is newer than this program speaks (${API_VERSION}): update the program`);
  const main = m.main === undefined ? 'background.html' : String(m.main);
  if (!/^[A-Za-z0-9_\-./]+\.html$/.test(main) || main.includes('..') || main.startsWith('/') || main.includes('//')) errors.push('main: a .html file inside the folder');
  let optionsPage = '';
  if (m.optionsPage !== undefined) {
    optionsPage = String(m.optionsPage);
    if (!/^[A-Za-z0-9_\-./]+\.html$/.test(optionsPage) || optionsPage.includes('..') || optionsPage.startsWith('/') || optionsPage.includes('//')) { errors.push('optionsPage: a .html file inside the folder'); optionsPage = ''; }
  }

  // permissions: only the known ones, in the exact shape
  const perms = { net: [], netAny: false, 'chat.inject': false, storage: false, widgets: false, windows: false };
  const p = m.permissions === undefined ? {} : m.permissions;
  if (!isObj(p)) errors.push('permissions: must be an object');
  else {
    for (const k of Object.keys(p)) if (!PERMISSIONS.includes(k)) errors.push(`permissions: "${k}" is not a permission of this program`);
    if (p.net !== undefined) {
      if (!Array.isArray(p.net) || p.net.length > 20) errors.push('permissions.net: a list of host names (at most 20)');
      else for (const h of p.net) {
        if (!validHost(h)) errors.push(`permissions.net: "${h}" is not an exact host name (no *, port, path, address or local name)`);
        else if (!perms.net.includes(h)) perms.net.push(h);
      }
    }
    for (const k of ['netAny', 'chat.inject', 'storage', 'widgets', 'windows']) if (p[k] !== undefined) { if (typeof p[k] !== 'boolean') errors.push(`permissions.${k}: true or false`); else perms[k] = p[k]; }
  }
  const reasons = {};
  if (m.reasons !== undefined) {
    if (!isObj(m.reasons)) errors.push('reasons: must be an object');
    else for (const [k, v] of Object.entries(m.reasons)) if (PERMISSIONS.includes(k) && typeof v === 'string') reasons[k] = v.trim().slice(0, 300);
  }
  for (const k of asked(perms)) if (!reasons[k]) warnings.push(`reasons.${k}: tell the user why "${k}" is needed (it is shown when they decide)`);
  const options = cleanOptions(m.options, errors);
  const windows = cleanWindows(m.windows, errors);
  if (windows.length && !perms.windows) warnings.push('windows are declared but the permission "windows" is not asked for: they are not used');
  for (const k of Object.keys(m)) if (!['id', 'name', 'version', 'api', 'author', 'description', 'main', 'optionsPage', 'permissions', 'reasons', 'options', 'windows'].includes(k)) warnings.push(`"${k}" is not known to this program (ignored)`);
  const manifest = { id: m.id, name, version, api: m.api, author: str(m.author, 80), description: str(m.description, 400), main, optionsPage, permissions: perms, reasons, options, windows };
  return { ok: errors.length === 0, errors, warnings, manifest: errors.length ? null : manifest };
}

// the permissions a manifest asks for, by name (net counts when it names a host)
export const asked = perms => PERMISSIONS.filter(k => (k === 'net' ? perms.net.length > 0 : !!perms[k]));

// granted: what the user allowed, kept in the settings: { net: [host...], 'chat.inject': bool, storage: bool }
const grantedOf = g => ({ net: Array.isArray(g && g.net) ? g.net.filter(validHost).slice(0, MAX_USER_HOSTS + 20) : [], netAny: !!(g && g.netAny), 'chat.inject': !!(g && g['chat.inject']), storage: !!(g && g.storage), widgets: !!(g && g.widgets), windows: !!(g && g.windows) });

// what is asked for and not yet allowed: [{ perm, host? }]
export function missing(manifest, granted) {
  const g = grantedOf(granted), out = [], p = manifest.permissions;
  for (const h of p.net) if (!g.net.includes(h)) out.push({ perm: 'net', host: h });
  if (p.netAny && !g.netAny) out.push({ perm: 'netAny' });
  if (p['chat.inject'] && !g['chat.inject']) out.push({ perm: 'chat.inject' });
  if (p.storage && !g.storage) out.push({ perm: 'storage' });
  if (p.widgets && !g.widgets) out.push({ perm: 'widgets' });
  if (p.windows && !g.windows) out.push({ perm: 'windows' });
  return out;
}

// what the plugin may do now: only what the manifest asks for AND the user allowed (a permission that was removed from the manifest is not used any more)
export function effective(manifest, granted) {
  const g = grantedOf(granted), p = manifest.permissions;
  // netAny: besides the hosts of the manifest, the hosts the user allowed one by one (they are in granted.net)
  const netAny = !!(p.netAny && g.netAny);
  return { net: netAny ? g.net.slice(0, MAX_USER_HOSTS + p.net.length) : p.net.filter(h => g.net.includes(h)), netAny, 'chat.inject': p['chat.inject'] && g['chat.inject'], storage: p.storage && g.storage, widgets: p.widgets && g.widgets, windows: p.windows && g.windows };
}

// is this address one the plugin may fetch? (https only; the host must be one of the allowed ones, exactly)
export function netAllowed(eff, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && eff.net.includes(u.hostname.toLowerCase());
}

// what a plugin asks for, as one text: when it changes (a new permission, a new host), the user is asked again
export const permsKey = manifest => JSON.stringify([manifest.id, [...manifest.permissions.net].sort(), !!manifest.permissions['chat.inject'], !!manifest.permissions.netAny, !!manifest.permissions.storage, !!manifest.permissions.widgets, !!manifest.permissions.windows, (manifest.windows || []).map(w => w.id).sort()]);

// a value of an option, made right for its declaration (a wrong one becomes the default)
export function cleanOptionValue(def, v) {
  if (def.type === 'check') return typeof v === 'boolean' ? v : !!def.default;
  if (def.type === 'number') {
    let n = Number(v);
    if (!Number.isFinite(n)) return def.default;
    if (def.min !== undefined) n = Math.max(def.min, n);
    if (def.max !== undefined) n = Math.min(def.max, n);
    return n;
  }
  if (def.type === 'select') return def.choices.some(c => c.value === v) ? v : def.default;
  return typeof v === 'string' ? v.slice(0, 500) : def.default;
}
// The values of all the options: what was set (cleaned for the declared ones) over the defaults. A plugin that draws its own options page (optionsPage) keeps its own settings here
// too (any key of letters, digits and '_' with a value JSON can hold; 100 keys, 100 KB in all): they are not shown by the program, they are only kept and given back.
export const FREE_KEYS = 100;
export const FREE_BYTES = 100_000;
export function optionValues(manifest, saved) {
  const out = Object.fromEntries(manifest.options.map(d => [d.key, saved && d.key in saved ? cleanOptionValue(d, saved[d.key]) : d.default]));
  if (!isObj(saved)) return out;
  const declared = new Set(manifest.options.map(d => d.key));
  let n = 0, bytes = 0;
  for (const [k, v] of Object.entries(saved)) {
    if (declared.has(k) || !KEY.test(k) || n >= FREE_KEYS) continue;
    let t; try { t = JSON.stringify(v); } catch { t = undefined; }
    if (t === undefined || bytes + t.length > FREE_BYTES) continue;
    out[k] = JSON.parse(t); n++; bytes += t.length;
  }
  return out;
}
