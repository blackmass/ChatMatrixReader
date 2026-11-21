// The plugins of the program (the hub runs this): looks in `plugins/` for folders with a plugin.json, keeps what the user decided (config.plugins: enabled, allowed permissions,
// option values), and runs the enabled ones, each in a SANDBOXED FRAME of this page whose address is the plugin's own (cmrplug, src-tauri/src/main.rs serve_plugin) and whose policy lets
// it load only its own files. The frame has no way to the exe; it sends messages and this file answers them through the bridge of that plugin (core/pluginbridge.js), which checks
// the permission and the limits of every call. The look of the plugin tab is the options window's job; this file gives it the state and takes its commands:
//   event 'plugin-state' { plugins: [ { id, ok, errors, warnings, manifest, enabled, running, missing, granted, options, lastError } ] }   (also on 'plugin-hello')
//   event 'plugin-command' { cmd: 'rescan' | 'enable' | 'disable' | 'grant' | 'option' | 'hash' | 'logs', id, ... }  ->  answers: 'plugin-result' { cmd, id, ... }
import { parseManifest, missing as missingOf, permsKey, cleanOptionValue, optionValues, validHost, MAX_USER_HOSTS, MAX_REQUESTS } from './core/plugins.js';
import * as winconf from './core/winconf.js';
import { Watchdog, PING_MS } from './core/watchdog.js';
import { PluginBridge, PluginError } from './core/pluginbridge.js';
import { log } from './core/log.js';
import { isMac } from './platform.js';
import { createWebHost } from './web_host.js';
import { webPatterns, openPatterns } from './core/plugins.js';

const LOG_KEEP = 200;
// what makes a plugin restart when it changes: the permissions (the hosts of netAny are not: they are changed while it runs)
// A request of a plugin looks like one of a browser unless the plugin says otherwise: many sites answer a request without a User-Agent with an empty or blocking page
const DEFAULT_HEADERS = [['User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'],
  ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7'], ['Accept-Language', 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7']];
const withDefaults = headers => { const have = new Set((headers || []).map(([k]) => String(k).toLowerCase())); return [...DEFAULT_HEADERS.filter(([k]) => !have.has(k.toLowerCase())), ...(headers || [])]; };
const restKey = g => JSON.stringify({ ...(g || {}), net: undefined, netAny: undefined });
const SAVE_DELAY_MS = 400;

export function startPlugins({ settings, files, publish, pipeline, invoke, emit, listen, widgets = null, windows = null, doc = document, win = window }) {
  const registry = new Map();                  // id -> { id, ok, errors, warnings, manifest }
  const running = new Map();                   // id -> { frame, bridge, token, granted, options }
  const logs = new Map();                      // id -> [text]
  const lastError = new Map();
  const dog = new Watchdog();
  const base = isMac ? 'cmrplug://localhost/' : 'http://cmrplug.localhost/';
  const holder = doc.createElement('div'); holder.hidden = true; holder.id = 'plugin-frames'; doc.body.append(holder);

  const entries = () => (settings.cfg().plugins && typeof settings.cfg().plugins === 'object' ? settings.cfg().plugins : {});
  const entry = id => ({ enabled: false, granted: {}, options: {}, ...(entries()[id] || {}) });
  const patchEntry = (id, patch) => settings.set({ plugins: { ...entries(), [id]: { ...entry(id), ...patch } } });

  const note = (id, text) => {
    const a = logs.get(id) || []; a.push(text); if (a.length > LOG_KEEP) a.shift(); logs.set(id, a);
    log.info(`플러그인 ${id}: ${text}`);
  };
  const fail = (id, text) => { lastError.set(id, text); note(id, '⚠ ' + text); publishState(); };

  function summary(id) {
    const r = registry.get(id), e = entry(id);
    return { id, ok: !!(r && r.ok), errors: r ? r.errors : [], warnings: r ? r.warnings : [], manifest: r ? r.manifest : null, enabled: !!e.enabled, running: running.has(id),
      missing: r && r.ok ? missingOf(r.manifest, e.granted) : [], granted: e.granted || {}, gone: !registry.has(id), requested: Array.isArray(e.requested) ? e.requested : [], web: { cookies: !!(e.web && e.web.cookies) }, webOpen: web.isOpen(id), options: r && r.ok ? optionValues(r.manifest, e.options) : (e.options || {}), lastError: lastError.get(id) || '',
      review: !!(r && r.ok && e.asked !== permsKey(r.manifest)) };       // review: nobody has decided about what it asks for yet (the options window asks the user, one plugin after the other)
  }
  const allIds = () => [...new Set([...registry.keys(), ...Object.keys(entries())])].sort();
  const publishState = () => emit('plugin-state', { plugins: allIds().map(summary) });

  // ---- the folders
  async function scan() {
    const found = new Set();
    let names = [];
    try { names = await files.list('plugins'); } catch { /* no plugins folder */ }
    for (const n of names) {
      if (!n.endsWith('/')) continue;
      const id = n.slice(0, -1);
      found.add(id);
      let text = null;
      try { text = await files.read(`plugins/${id}/plugin.json`); } catch { /* unreadable */ }
      registry.set(id, text === null ? { id, ok: false, errors: ['plugin.json is not there'], warnings: [], manifest: null } : { id, ...parseManifest(text, id) });
    }
    for (const id of [...registry.keys()]) if (!found.has(id)) registry.delete(id);
    pruneWindows();
    await reconcile();
    publishState();
    // a plugin nobody has decided about yet: the options window is opened once, it asks the user (api.askedOpen: only once in a run of the program)
    const pending = [...registry.values()].filter(r => r.ok && entry(r.id).asked !== permsKey(r.manifest) && !api.prompted.has(r.id));
    if (pending.length) { for (const r of pending) api.prompted.add(r.id); invoke('open_options').catch(() => {}); }
  }

  // ---- running
  const post = { send: (frame, msg) => { try { frame.contentWindow.postMessage(msg, '*'); } catch { /* the frame is gone */ } } };          // (the tests replace `send`)
  const sendTo = (frame, msg) => post.send(frame, msg);
  const storePath = id => `plugin-data/${id}.json`;

  function hooksFor(id, manifest) {
    let saveTimer = 0, pending = null;
    const flush = async () => { saveTimer = 0; if (pending === null) return; const o = pending; pending = null; try { await files.write(storePath(id), JSON.stringify(o)); } catch (e) { fail(id, 'the storage could not be saved: ' + e); } };
    return {
      inject: ({ text, sender }) => publish(pipeline.onLine({ channel: '!PLG', id: 0, sender: sender || manifest.name, text, cls: '', base: -1 })),
      fetch: async (r, hosts) => invoke('plugin_fetch', { url: r.url, method: r.method, headers: withDefaults(r.headers), body: r.body, hosts, maxBytes: r.max }),
      log: text => note(id, text),
      requestHost: async host => {                                    // (netAny) the plugin asks for a host: it waits in the list of the plugin tab for the user
        const e = entry(id), have = Array.isArray(e.requested) ? e.requested : [];
        if ((e.granted && e.granted.net || []).includes(host)) return 'allowed';
        if (have.includes(host)) return 'pending';
        if (have.length >= MAX_REQUESTS) throw new Error(`too many hosts wait for the user (${MAX_REQUESTS})`);
        patchEntry(id, { requested: [...have, host] });
        note(id, `asked for the host: ${host}`);
        return 'pending';
      },
      openUrl: async (url, hosts) => { await invoke('plugin_open_url', { url, hosts }); note(id, 'opened in the browser: ' + url); },
      webOpen: async (req, patterns, openAllow) => { await ensureWindows(id); return web.open(id, req, patterns, openAllow); },
      webClose: () => web.close(id),
      windowOpen: async name => { await ensureWindows(id); const c = windowEntry(id, name); if (c && windows) windows.openWindow(c.id); },
      windowClose: async name => { const c = windowEntry(id, name); if (c && windows) windows.closeWindow(c.id); },
      widgetRegister: def => { if (!widgets) throw new Error('the widgets of the program are not there'); widgets.registerDef(def); note(id, `widget registered: ${def.id}`); },
      widgetUpdate: (wid, patch) => { if (widgets) widgets.publish(wid, patch); },
      widgetUnregister: wid => { if (widgets) widgets.unregisterDef(wid); },
      load: async () => { const t = await files.read(storePath(id)); return t ? JSON.parse(t) : null; },
      save: async o => { pending = o; if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY_MS); },
      flush,
    };
  }

  const web = createWebHost({ getKeys: () => settings.cfg().interact_keys, getEntry: entry, getConf: id => webEntry(id), patchConf: (id, patch) => { const c = webEntry(id); if (c) settings.set({ child_windows: (settings.cfg().child_windows || []).map(x => (x === c || x.id === c.id ? { ...x, ...patch } : x)) }); }, invoke, note, wowTitle: () => settings.cfg().wow_window_title || 'World of Warcraft' });

  // One bridge for a plugin (its background page and its options page in the options window share it: one storage, one set of limits); a new one when the allowed permissions change
  const bridges = new Map();                   // id -> { key, bridge, hooks }
  function getBridge(id) {
    const r = registry.get(id), e = entry(id), key = restKey(e.granted);
    let b = bridges.get(id);
    if (!b || b.key !== key || b.manifest !== r.manifest) {
      if (b) b.bridge.shutdown();                                         // (the old one's widgets go; the plugin is restarted and registers them again)
      const hooks = hooksFor(id, r.manifest);
      hooks.setOptions = async o => patchEntry(id, { options: o });
      b = { key, manifest: r.manifest, hooks, bridge: new PluginBridge({ manifest: r.manifest, granted: e.granted, hooks, options: e.options }) };
      bridges.set(id, b);
    } else b.bridge.setGranted(r.manifest, e.granted);                  // (the hosts the user allows or takes away: no restart)
    return b;
  }

  // ---- the windows of a plugin: made in the list of windows (child_windows) when the plugin is on and allowed to have them; the plugin opens and closes them
  const webEntry = id => (settings.cfg().child_windows || []).find(c => c.owner === id && c.kind === 'web');
  const windowEntry = (id, name) => (settings.cfg().child_windows || []).find(c => c.owner === id && c.owner_win === name);
  const windowAllowed = (id, name) => { const run = running.get(id), r = registry.get(id); return !!(run && r && r.ok && run.bridge.eff.windows && (r.manifest.windows || []).some(w => w.id === name)); };
  async function ensureWindows(id) {
    const r = registry.get(id), run = running.get(id);
    if (!r || !r.ok || !run) return;
    let list = settings.cfg().child_windows || [], changed = false;
    if (run.bridge.eff.web && !webEntry(id)) {                          // the web window has its entry too (Options > Window): a fixed name; what the user chooses there is used when the plugin opens it
      list = [...list, { ...winconf.newConf(winconf.nextId(list), []), owner: id, owner_win: 'web', kind: 'web', name: r.manifest.name + " · " + "웹 창", open_mode: 'never', geometry: '360x640', topmost: true }];
      changed = true;
    }
    if (!run.bridge.eff.windows) { if (changed) settings.set({ child_windows: list }); return; }
    for (const w of r.manifest.windows || []) {
      if (list.some(c => c.owner === id && c.owner_win === w.id)) continue;
      const wid = winconf.nextId(list);
      list = [...list, { ...winconf.newConf(wid, []), owner: id, owner_win: w.id, kind: 'page', page: w.page, name: w.title, open_mode: 'never', geometry: `${w.width}x${w.height}` }];
      changed = true;
    }
    if (changed) settings.set({ child_windows: list });
  }

  // The windows of a plugin that the plugin does not have any more (it was changed: a window it declared is gone, it does not ask for the web window now) leave the list of windows.
  // A plugin that is not found at all keeps its entries: its folder may only be away for a moment (the user can clear it by hand, "forget")
  function pruneWindows() {
    const list = settings.cfg().child_windows || [];
    const stale = c => {
      if (!c.owner) return false;
      const r = registry.get(c.owner);
      if (!r || !r.ok) return false;
      return c.kind === 'page' ? !(r.manifest.windows || []).some(w => w.id === c.owner_win) : c.kind === 'web' ? !r.manifest.permissions.web : false;
    };
    if (list.some(stale)) settings.set({ child_windows: list.filter(c => !stale(c)) });
  }

  async function startOne(id) {
    const r = registry.get(id), e = entry(id);
    if (!r || !r.ok || running.has(id)) return;
    let token;
    try { token = await invoke('plugin_token', { id, renew: true }); } catch (err) { fail(id, 'could not start: ' + err); return; }
    const { bridge, hooks } = getBridge(id);
    const frame = doc.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');                       // (no same-origin: the page has no origin of its own, the program cannot be reached from it)
    frame.dataset.plugin = id;
    frame.src = base + token + '/' + r.manifest.main;
    dog.start(id, Date.now());
    running.set(id, { frame, bridge, hooks, token, granted: restKey(e.granted), options: JSON.stringify(e.options || {}) });
    lastError.delete(id);
    holder.append(frame);
    note(id, `started (${r.manifest.version})`);
    await ensureWindows(id);
    if (windows) windows.sync();
    publishState();
  }

  async function stopOne(id, why = 'stopped') {
    const run = running.get(id);
    if (!run) return;
    running.delete(id); dog.forget(id);
    run.bridge.shutdown();
    await web.close(id);                                                   // (its web window goes with it)
    try { await run.hooks.flush(); } catch { /* reported */ }
    run.frame.remove();
    invoke('plugin_forget', { id }).catch(() => {});
    note(id, why);
    if (windows) windows.sync();                                           // (its windows close)
    publishState();
  }

  async function reconcile() {
    for (const [id, b] of bridges) { const r = registry.get(id); if (r && r.ok) b.bridge.options = optionValues(r.manifest, entry(id).options); }      // (also for a plugin that is not running: its options page)
    for (const id of [...running.keys()]) {
      const r = registry.get(id), e = entry(id), run = running.get(id);
      if (!r || !r.ok || !e.enabled) { await stopOne(id); continue; }
      if (restKey(e.granted) !== run.granted) { await stopOne(id, 'restarted: the allowed permissions changed'); continue; }
      const hosts = JSON.stringify(run.bridge.eff.net);
      run.bridge.setGranted(r.manifest, e.granted);
      if (JSON.stringify(run.bridge.eff.net) !== hosts) web.allow(id, webPatterns(run.bridge.eff.net, run.bridge.eff.web), openPatterns(run.bridge.eff));      // (a host taken away: the web window may not go there any more)
      if (JSON.stringify(run.bridge.eff.net) !== hosts) sendTo(run.frame, { cmr: 1, event: 'hosts', value: run.bridge.eff.net });       // (the plugin is told: it may fetch now)
      if (JSON.stringify(e.options || {}) !== run.options) {                // (the options changed: the plugin is told; it keeps running)
        run.options = JSON.stringify(e.options || {});
        run.bridge.options = optionValues(r.manifest, e.options);
        sendTo(run.frame, { cmr: 1, event: 'options', value: run.bridge.options });
      }
    }
    for (const [id, r] of registry) if (r.ok && entry(id).enabled && !running.has(id)) await startOne(id);
  }

  // ---- what the frames say
  win.addEventListener('message', async ev => {
    const run = [...running.values()].find(x => x.frame.contentWindow && x.frame.contentWindow === ev.source);
    if (!run) return;
    const m = ev.data;
    if (!m || m.cmr !== 1) return;
    const id = run.frame.dataset.plugin;
    if (m.event === 'hello') { sendTo(run.frame, { cmr: 1, event: 'options', value: run.bridge.options }); return; }
    if (m.event === 'pong') { dog.pong(id, Date.now()); return; }
    if (m.event === 'error') { fail(id, 'page error: ' + String(m.value).slice(0, 300)); return; }
    if (typeof m.id !== 'number' || typeof m.method !== 'string') return;
    try { sendTo(run.frame, { cmr: 1, id: m.id, ok: true, value: await run.bridge.call(m.method, m.args) }); }
    catch (err) {
      const code = err instanceof PluginError ? err.code : 'failed';
      if (code === 'denied' || code === 'limit') note(id, `refused ${m.method}: ${err.message}`);
      else if (code === 'failed') note(id, `⚠ ${m.method} failed: ${String((err && err.message) || err).slice(0, 200)}`);
      sendTo(run.frame, { cmr: 1, id: m.id, ok: false, error: { code, message: String((err && err.message) || err).slice(0, 300) } });
    }
  });

  // ---- the pages of a plugin that are shown in the program's own windows: its options page (in the options window, from 'opt:...') and the page of its windows (from 'win:...').
  // Their calls come here by events and the same bridge answers; a window page is served only while the plugin runs and may have that window.
  listen('plugin-page', async ev => {
    const { from, owner, name } = ev.payload || {};
    const reply = token => emit('plugin-page-reply', { from, token });
    if (!windowAllowed(owner, name)) return reply('');
    try { reply(await invoke('plugin_token', { id: owner })); } catch { reply(''); }
  });
  listen('plugin-ui', async ev => {
    const { id, from, seq, method, args, name } = ev.payload || {};
    const r = registry.get(id);
    const reply = body => emit('plugin-ui-reply', { id, from, seq, ...body });
    const fromWindow = typeof from === 'string' && from.startsWith('win:');
    if (!r || !r.ok || typeof seq !== 'number' || typeof method !== 'string' || (fromWindow && !windowAllowed(id, name))) return reply({ ok: false, error: { code: 'failed', message: 'no such plugin' } });
    try { reply({ ok: true, value: await getBridge(id).bridge.call(method, args) }); }
    catch (err) { reply({ ok: false, error: { code: err instanceof PluginError ? err.code : 'failed', message: String((err && err.message) || err).slice(0, 300) } }); }
  });

  // ---- what the options window asks
  listen('plugin-hello', () => publishState());
  listen('plugin-command', async ev => {
    const { cmd, id } = ev.payload || {};
    const reply = extra => emit('plugin-result', { cmd, id, ...extra });
    try {
      if (cmd === 'rescan') { await scan(); return reply({}); }
      const seen = () => { const r = registry.get(id); return r && r.ok ? { asked: permsKey(r.manifest) } : {}; };       // (the user has dealt with it by hand: it need not be asked again)
      if (cmd === 'enable' || cmd === 'disable') { patchEntry(id, { enabled: cmd === 'enable', ...seen() }); return reply({}); }
      if (cmd === 'grant') { patchEntry(id, { granted: ev.payload.granted || {}, ...seen() }); return reply({}); }
      if (cmd === 'option') {
        const def = (registry.get(id) && registry.get(id).manifest ? registry.get(id).manifest.options : []).find(o => o.key === ev.payload.key);
        if (!def) return reply({ error: 'no such option' });
        patchEntry(id, { options: { ...entry(id).options, [def.key]: cleanOptionValue(def, ev.payload.value) } });
        return reply({});
      }
      if (cmd === 'review') {                                              // the answer of the user to "this plugin asks for ..." (granted: what was allowed, enable: turn it on)
        const r = registry.get(id);
        if (!r || !r.ok) return reply({ error: 'no such plugin' });
        patchEntry(id, { asked: permsKey(r.manifest), granted: ev.payload.granted || {}, enabled: !!ev.payload.enable });
        return reply({});
      }
      if (cmd === 'grantHost' || cmd === 'denyHost' || cmd === 'removeHost') {                  // (netAny: the answer of the user to a host the plugin asked for, or a host taken away)
        const r = registry.get(id), e = entry(id), host = String(ev.payload.host || '').toLowerCase();
        if (!r || !r.ok || !r.manifest.permissions.netAny || !validHost(host)) return reply({ error: 'not possible' });
        const net = Array.isArray(e.granted && e.granted.net) ? e.granted.net : [], requested = (Array.isArray(e.requested) ? e.requested : []).filter(h => h !== host);
        if (cmd === 'grantHost') {
          const user = net.filter(h => !r.manifest.permissions.net.includes(h));
          if (!net.includes(host) && user.length >= MAX_USER_HOSTS) return reply({ error: `at most ${MAX_USER_HOSTS} hosts` });
          patchEntry(id, { granted: { ...(e.granted || {}), net: [...new Set([...net, host])] }, requested });
        } else if (cmd === 'removeHost') patchEntry(id, { granted: { ...(e.granted || {}), net: net.filter(h => h !== host) } });
        else patchEntry(id, { requested });
        return reply({});
      }
      if (cmd === 'web') {                                                 // what the user chose for the web window: topmost, wow, through, lock, cookies (only these keys)
        const k = String(ev.payload.key || '');
        if (k !== 'cookies') return reply({ error: 'no such setting' });
        patchEntry(id, { web: { ...(entry(id).web || {}), [k]: !!ev.payload.value } });
        return reply({});
      }
      if (cmd === 'webClear') { if (!web.isOpen(id)) return reply({ error: 'open' }); await web.clearData(id); note(id, 'cookies and stored data of the web window cleared'); return reply({}); }
      if (cmd === 'forget') {                                              // the settings, windows and stored data of a plugin whose folder is not there (the user asked)
        if (registry.has(id)) return reply({ error: 'the plugin is there' });
        const rest = { ...entries() }; delete rest[id];
        bridges.delete(id);
        settings.set({ plugins: rest, child_windows: (settings.cfg().child_windows || []).filter(c => c.owner !== id) });
        await files.remove(storePath(id)).catch(() => {});
        publishState();
        return reply({});
      }
      if (cmd === 'hash') return reply(await invoke('plugin_hash', { id }));
      if (cmd === 'logs') return reply({ lines: logs.get(id) || [] });
    } catch (err) { reply({ error: String((err && err.message) || err) }); }
  });
  settings.onChange(() => { reconcile().then(publishState); });

  // the pages are asked "are you there?"; one that does not answer is started again (or stopped when it keeps happening)
  setInterval(async () => {
    if (!api.watch) return;
    for (const [id, run] of [...running]) {
      sendTo(run.frame, { cmr: 1, event: 'ping' });
      const verdict = dog.check(id, Date.now());
      if (verdict === 'restart') { note(id, '⚠ the plugin did not answer: it is started again'); await stopOne(id, 'stopped: no answer'); await startOne(id); }
      else if (verdict === 'stop') { fail(id, 'the plugin stops answering again and again: it was stopped (turn it on again when it is mended)'); await stopOne(id, 'stopped: no answer, too often'); patchEntry(id, { enabled: false }); }
    }
  }, PING_MS);
  setInterval(() => { for (const b of bridges.values()) b.bridge.pump(); }, 150);       // (the lines of the plugins wait in a queue and go out one by one: core/pluginbridge.js)

  const api = { watch: true, dog, prompted: new Set(), windowAllowed, scan, list: () => allIds().map(summary), registry, running, logs, stop: stopOne, post };
  scan();
  return api;
}
