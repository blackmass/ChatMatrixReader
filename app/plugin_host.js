// The plugins of the program (the hub runs this): looks in `plugins/` for folders with a plugin.json, keeps what the user decided (config.plugins: enabled, allowed permissions,
// option values), and runs the enabled ones, each in a SANDBOXED FRAME of this page whose address is the plugin's own (cmrplug, src-tauri/src/main.rs serve_plugin) and whose policy lets
// it load only its own files. The frame has no way to the exe; it sends messages and this file answers them through the bridge of that plugin (core/pluginbridge.js), which checks
// the permission and the limits of every call. The look of the plugin tab is the options window's job; this file gives it the state and takes its commands:
//   event 'plugin-state' { plugins: [ { id, ok, errors, warnings, manifest, enabled, running, missing, granted, options, lastError } ] }   (also on 'plugin-hello')
//   event 'plugin-command' { cmd: 'rescan' | 'enable' | 'disable' | 'grant' | 'option' | 'hash' | 'logs', id, ... }  ->  answers: 'plugin-result' { cmd, id, ... }
import { parseManifest, missing as missingOf } from './core/plugins.js';
import { PluginBridge, PluginError } from './core/pluginbridge.js';
import { log } from './core/log.js';
import { isMac } from './platform.js';

const LOG_KEEP = 200;
const SAVE_DELAY_MS = 400;

export function startPlugins({ settings, files, publish, pipeline, invoke, emit, listen, doc = document, win = window }) {
  const registry = new Map();                  // id -> { id, ok, errors, warnings, manifest }
  const running = new Map();                   // id -> { frame, bridge, token, granted, options }
  const logs = new Map();                      // id -> [text]
  const lastError = new Map();
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
      missing: r && r.ok ? missingOf(r.manifest, e.granted) : [], granted: e.granted || {}, options: e.options || {}, lastError: lastError.get(id) || '' };
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
    await reconcile();
    publishState();
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
      fetch: async (r, hosts) => invoke('plugin_fetch', { url: r.url, method: r.method, headers: r.headers, body: r.body, hosts, maxBytes: r.max }),
      log: text => note(id, text),
      load: async () => { const t = await files.read(storePath(id)); return t ? JSON.parse(t) : null; },
      save: async o => { pending = o; if (!saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY_MS); },
      flush,
    };
  }

  async function startOne(id) {
    const r = registry.get(id), e = entry(id);
    if (!r || !r.ok || running.has(id)) return;
    let token;
    try { token = await invoke('plugin_token', { id, renew: true }); } catch (err) { fail(id, 'could not start: ' + err); return; }
    const hooks = hooksFor(id, r.manifest);
    const bridge = new PluginBridge({ manifest: r.manifest, granted: e.granted, hooks, options: e.options });
    const frame = doc.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');                       // (no same-origin: the page has no origin of its own, the program cannot be reached from it)
    frame.dataset.plugin = id;
    frame.src = base + token + '/' + r.manifest.main;
    running.set(id, { frame, bridge, hooks, token, granted: JSON.stringify(e.granted || {}), options: JSON.stringify(e.options || {}) });
    lastError.delete(id);
    holder.append(frame);
    note(id, `started (${r.manifest.version})`);
    publishState();
  }

  async function stopOne(id, why = 'stopped') {
    const run = running.get(id);
    if (!run) return;
    running.delete(id);
    try { await run.hooks.flush(); } catch { /* reported */ }
    run.frame.remove();
    invoke('plugin_forget', { id }).catch(() => {});
    note(id, why);
    publishState();
  }

  async function reconcile() {
    for (const id of [...running.keys()]) {
      const r = registry.get(id), e = entry(id), run = running.get(id);
      if (!r || !r.ok || !e.enabled) { await stopOne(id); continue; }
      if (JSON.stringify(e.granted || {}) !== run.granted) { await stopOne(id, 'restarted: the allowed permissions changed'); continue; }
      if (JSON.stringify(e.options || {}) !== run.options) {                // (the options changed: the plugin is told; it keeps running)
        run.options = JSON.stringify(e.options || {});
        run.bridge.options = { ...Object.fromEntries(r.manifest.options.map(o => [o.key, o.default])), ...(e.options || {}) };
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
    if (typeof m.id !== 'number' || typeof m.method !== 'string') return;
    try { sendTo(run.frame, { cmr: 1, id: m.id, ok: true, value: await run.bridge.call(m.method, m.args) }); }
    catch (err) {
      const code = err instanceof PluginError ? err.code : 'failed';
      if (code === 'denied' || code === 'limit') note(id, `refused ${m.method}: ${err.message}`);
      sendTo(run.frame, { cmr: 1, id: m.id, ok: false, error: { code, message: String((err && err.message) || err).slice(0, 300) } });
    }
  });

  // ---- what the options window asks
  listen('plugin-hello', () => publishState());
  listen('plugin-command', async ev => {
    const { cmd, id } = ev.payload || {};
    const reply = extra => emit('plugin-result', { cmd, id, ...extra });
    try {
      if (cmd === 'rescan') { await scan(); return reply({}); }
      if (cmd === 'enable' || cmd === 'disable') { patchEntry(id, { enabled: cmd === 'enable' }); return reply({}); }
      if (cmd === 'grant') { patchEntry(id, { granted: ev.payload.granted || {} }); return reply({}); }
      if (cmd === 'option') { patchEntry(id, { options: { ...entry(id).options, [ev.payload.key]: ev.payload.value } }); return reply({}); }
      if (cmd === 'hash') return reply(await invoke('plugin_hash', { id }));
      if (cmd === 'logs') return reply({ lines: logs.get(id) || [] });
    } catch (err) { reply({ error: String((err && err.message) || err) }); }
  });
  settings.onChange(() => { reconcile().then(publishState); });

  const api = { scan, list: () => allIds().map(summary), registry, running, logs, stop: stopOne, post };
  scan();
  return api;
}
