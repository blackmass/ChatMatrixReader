// Plugins (no window code): reading the manifest (plugin.json) of a plugin folder, the permissions it asks for, and what the user has allowed.
// The folder `plugins/<id>/` holds the plugin; its manifest says who it is and what it needs. Nothing is allowed that the manifest does not ask for,
// and nothing that the user has not approved (the approvals are kept in the settings, never in the plugin folder).
//
//   const r = parseManifest(text, folderName)      -> { ok, errors: [], warnings: [], manifest }   (manifest = the clean version of it)
//   missing(manifest, granted)                     -> what is asked for and not yet allowed (to show for approval)
//   effective(manifest, granted)                   -> what the plugin may really do now (the asked for AND allowed)

export const API_VERSION = 1;                         // the version of the plugin interface this program speaks
export const MIN_TIMER_SEC = 5;                       // a timer of a plugin never runs more often than this
export const MAX_OPTIONS = 50;
export const PERMISSIONS = ['net', 'chat.inject', 'storage', 'timer'];
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
  const perms = { net: [], 'chat.inject': false, storage: false, timer: null };
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
    for (const k of ['chat.inject', 'storage']) if (p[k] !== undefined) { if (typeof p[k] !== 'boolean') errors.push(`permissions.${k}: true or false`); else perms[k] = p[k]; }
    if (p.timer !== undefined) {
      if (p.timer === true) perms.timer = { minIntervalSec: MIN_TIMER_SEC };
      else if (isObj(p.timer) && Number.isFinite(Number(p.timer.minIntervalSec))) perms.timer = { minIntervalSec: Math.max(MIN_TIMER_SEC, Math.round(Number(p.timer.minIntervalSec))) };
      else if (p.timer !== false) errors.push('permissions.timer: true or { "minIntervalSec": number }');
    }
  }
  const reasons = {};
  if (m.reasons !== undefined) {
    if (!isObj(m.reasons)) errors.push('reasons: must be an object');
    else for (const [k, v] of Object.entries(m.reasons)) if (PERMISSIONS.includes(k) && typeof v === 'string') reasons[k] = v.trim().slice(0, 300);
  }
  for (const k of asked(perms)) if (!reasons[k]) warnings.push(`reasons.${k}: tell the user why "${k}" is needed (it is shown when they decide)`);
  const options = cleanOptions(m.options, errors);
  for (const k of Object.keys(m)) if (!['id', 'name', 'version', 'api', 'author', 'description', 'main', 'optionsPage', 'permissions', 'reasons', 'options'].includes(k)) warnings.push(`"${k}" is not known to this program (ignored)`);
  const manifest = { id: m.id, name, version, api: m.api, author: str(m.author, 80), description: str(m.description, 400), main, optionsPage, permissions: perms, reasons, options };
  return { ok: errors.length === 0, errors, warnings, manifest: errors.length ? null : manifest };
}

// the permissions a manifest asks for, by name (net counts when it names a host)
export const asked = perms => PERMISSIONS.filter(k => (k === 'net' ? perms.net.length > 0 : k === 'timer' ? !!perms.timer : !!perms[k]));

// granted: what the user allowed, kept in the settings: { net: [host...], 'chat.inject': bool, storage: bool, timer: bool }
const grantedOf = g => ({ net: Array.isArray(g && g.net) ? g.net : [], 'chat.inject': !!(g && g['chat.inject']), storage: !!(g && g.storage), timer: !!(g && g.timer) });

// what is asked for and not yet allowed: [{ perm, host? }]
export function missing(manifest, granted) {
  const g = grantedOf(granted), out = [], p = manifest.permissions;
  for (const h of p.net) if (!g.net.includes(h)) out.push({ perm: 'net', host: h });
  if (p['chat.inject'] && !g['chat.inject']) out.push({ perm: 'chat.inject' });
  if (p.storage && !g.storage) out.push({ perm: 'storage' });
  if (p.timer && !g.timer) out.push({ perm: 'timer' });
  return out;
}

// what the plugin may do now: only what the manifest asks for AND the user allowed (a permission that was removed from the manifest is not used any more)
export function effective(manifest, granted) {
  const g = grantedOf(granted), p = manifest.permissions;
  return { net: p.net.filter(h => g.net.includes(h)), 'chat.inject': p['chat.inject'] && g['chat.inject'], storage: p.storage && g.storage, timer: p.timer && g.timer ? p.timer : null };
}

// is this address one the plugin may fetch? (https only; the host must be one of the allowed ones, exactly)
export function netAllowed(eff, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && eff.net.includes(u.hostname.toLowerCase());
}
