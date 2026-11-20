// What a plugin may ask of the program, and the checks on every ask (no window code): the plugin page (a sandboxed frame) sends { method, args } by postMessage, the host (plugin_host.js)
// gives it to the bridge of that plugin, and the answer (or the error) goes back. A call is carried out only when the manifest asked for the permission AND the user allowed it, and every
// call that costs something has a limit. The bridge knows nothing of windows: what really happens (a line in the chat, a request, a file) is given in `hooks`.
//
//   const b = new PluginBridge({ manifest, granted, hooks: { inject(line), fetch(req, hosts), log(text), load(), save(obj) }, options, now })
//   await b.call('chat.inject', { text, sender })      -> value  |  throws PluginError { code: 'denied' | 'limit' | 'args' | 'failed' }
import { effective, netAllowed, optionValues, validHost } from './plugins.js';
import { checkDef, cleanState } from '../widgets/registry.js';

export class PluginError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const LIMITS = {
  injectGapMs: 700, injectQueue: 50, injectText: 500, injectSender: 40,       // lines for the chat go out one by one, at least this far apart; more than the queue holds are dropped (and told)
  fetchGapMs: 1000, fetchQueue: 20, fetchBody: 1_000_000, fetchAnswer: 2_000_000, fetchHeaders: 30,       // requests to one host are spaced; they wait their turn in a queue
  storageBytes: 1_000_000, storageKeys: 1000, storageKey: 100,
  logPerMin: 120, logText: 500,
  windowCallsPerMin: 20, hostRequestsPerMin: 10, openUrlPerMin: 6,                               // opening / closing the plugin's windows; asking the user for a host                                                       // opening / closing the plugin's windows
  widgets: 8, widgetGapMs: 100,                                                // widgets a plugin may have; its state is passed on at most every 100 ms (the newest wins)
};

// at most `max` things in any window of `ms`
export class Limiter {
  constructor(max, ms, now = () => Date.now()) { this.max = max; this.ms = ms; this.now = now; this.at = []; }
  take() {
    const t = this.now();
    this.at = this.at.filter(x => t - x < this.ms);
    if (this.at.length >= this.max) return false;
    this.at.push(t);
    return true;
  }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

export class PluginBridge {
  constructor({ manifest, granted, hooks, options = {}, now = () => Date.now() }) {
    this.manifest = manifest;
    this.eff = effective(manifest, granted);
    this.manifestPerms = manifest.permissions;
    this.hooks = hooks;
    this.options = optionValues(manifest, options);
    this.now = now;
    this.sleep = hooks.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this.injectQ = []; this.lastInject = -1e12; this.dropped = 0;       // the lines waiting for their turn, when the last one went out, how many were dropped
    this.hosts = {};                                                    // host -> the time of the next free place for a request
    this.logs = new Limiter(LIMITS.logPerMin, 60_000, now);
    this.windowCalls = new Limiter(LIMITS.windowCallsPerMin, 60_000, now);
    this.hostRequests = new Limiter(LIMITS.hostRequestsPerMin, 60_000, now);
    this.opens = new Limiter(LIMITS.openUrlPerMin, 60_000, now);
    this.data = null;                                   // the storage, read at the first use
    this.widgetIds = new Set();                         // the full ids of the widgets this plugin registered
    this.widgetLast = {}; this.widgetPending = {};     // full id -> when its state went out last / a state that waits for its time
  }

  need(perm) { if (!(perm === 'net' ? this.eff.net.length : this.eff[perm])) throw new PluginError('denied', `the permission "${perm}" is not allowed for this plugin`); }

  async store() {
    if (this.data === null) {
      let d = null;
      try { d = await this.hooks.load(); } catch { /* an unreadable store starts empty */ }
      this.data = isObj(d) ? d : {};
    }
    return this.data;
  }

  async call(method, args) {
    args = args === undefined ? {} : args;
    switch (method) {
      case 'meta': return { id: this.manifest.id, name: this.manifest.name, version: this.manifest.version, api: this.manifest.api, allowed: this.eff };
      case 'options.get': return structuredClone(this.options);
      case 'options.set': {                                            // (the plugin's own settings: its options page saves them here; the others are told by the host)
        if (!isObj(args)) throw new PluginError('args', 'an object of values is needed');
        const next = optionValues(this.manifest, { ...this.options, ...args });
        this.options = next;
        await this.hooks.setOptions(structuredClone(next));
        return structuredClone(next);
      }
      case 'log': {
        if (!this.logs.take()) return null;                          // (too many: dropped without a word)
        this.hooks.log(String(isObj(args) ? args.text : args).slice(0, LIMITS.logText));
        return null;
      }
      case 'chat.inject': {
        this.need('chat.inject');
        if (!isObj(args) || typeof args.text !== 'string' || !args.text.trim()) throw new PluginError('args', 'text is needed');
        const sender = typeof args.sender === 'string' ? args.sender.trim().slice(0, LIMITS.injectSender) : '';
        // The plugin may call as often as it likes; what is limited is what comes out: the lines wait in a queue and go to the chat one by one (pump). A line that finds the queue
        // full is dropped, and the number of the dropped is told in a line of its own when there is room again (and in the log).
        if (this.injectQ.length >= LIMITS.injectQueue) { if (!this.dropped) this.hooks.log(`too many lines: the queue (${LIMITS.injectQueue}) is full, new lines are dropped`); this.dropped++; return null; }
        this.injectQ.push({ text: args.text.trim().slice(0, LIMITS.injectText), sender });
        this.pump();
        return null;
      }
      case 'storage.get': { this.need('storage'); const d = await this.store(); this.key(args.key); return d[args.key] === undefined ? null : structuredClone(d[args.key]); }
      case 'storage.keys': { this.need('storage'); return Object.keys(await this.store()); }
      case 'storage.set': {
        this.need('storage'); const d = await this.store(); this.key(args.key);
        let text;
        try { text = JSON.stringify(args.value); } catch { text = undefined; }
        if (text === undefined) throw new PluginError('args', 'the value must be something JSON can hold');
        const next = { ...d, [args.key]: JSON.parse(text) };
        if (Object.keys(next).length > LIMITS.storageKeys) throw new PluginError('limit', `at most ${LIMITS.storageKeys} keys`);
        if (JSON.stringify(next).length > LIMITS.storageBytes) throw new PluginError('limit', `the storage is full (${LIMITS.storageBytes} bytes)`);
        this.data = next; await this.hooks.save(next);
        return null;
      }
      case 'storage.remove': {
        this.need('storage'); const d = await this.store(); this.key(args.key);
        if (!(args.key in d)) return null;
        const next = { ...d }; delete next[args.key]; this.data = next; await this.hooks.save(next);
        return null;
      }
      case 'windows.open': case 'windows.close': {
        this.need('windows');
        if (!isObj(args) || !(this.manifest.windows || []).some(w => w.id === args.id)) throw new PluginError('args', 'this window is not declared in plugin.json');
        if (!this.windowCalls.take()) throw new PluginError('limit', `at most ${LIMITS.windowCallsPerMin} window calls a minute`);
        await (method === 'windows.open' ? this.hooks.windowOpen(args.id) : this.hooks.windowClose(args.id));
        return null;
      }
      case 'widgets.register': {
        this.need('widgets');
        if (!isObj(args) || typeof args.id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,47}$/i.test(args.id)) throw new PluginError('args', 'id: a short name (letters, digits, . _ -)');
        const full = this.manifest.id + ':' + args.id;
        if (!this.widgetIds.has(full) && this.widgetIds.size >= LIMITS.widgets) throw new PluginError('limit', `at most ${LIMITS.widgets} widgets`);
        let def;
        try { def = checkDef({ ...args, id: full, owner: this.manifest.id }); } catch (e) { throw new PluginError('args', String(e.message || e)); }
        this.widgetIds.add(full);
        this.hooks.widgetRegister(def);
        return full;
      }
      case 'widgets.update': {
        this.need('widgets');
        const full = isObj(args) && typeof args.id === 'string' ? this.manifest.id + ':' + args.id : '';
        if (!this.widgetIds.has(full)) throw new PluginError('args', 'this widget is not registered by the plugin');
        const patch = cleanState(args.state);
        const t = this.now();
        if (t - (this.widgetLast[full] ?? -1e12) >= LIMITS.widgetGapMs) { this.widgetLast[full] = t; delete this.widgetPending[full]; this.hooks.widgetUpdate(full, patch); }
        else this.widgetPending[full] = { ...(this.widgetPending[full] || {}), ...patch };
        return null;
      }
      case 'widgets.unregister': {
        this.need('widgets');
        const full = isObj(args) && typeof args.id === 'string' ? this.manifest.id + ':' + args.id : '';
        if (this.widgetIds.delete(full)) { delete this.widgetPending[full]; this.hooks.widgetUnregister(full); }
        return null;
      }
      case 'openUrl': {                                                  // an address in the user's own browser: https, a host the user allowed, a few a minute
        this.need('openUrl');
        if (!isObj(args) || typeof args.url !== 'string') throw new PluginError('args', 'url is needed');
        if (!netAllowed(this.eff, args.url)) throw new PluginError('denied', 'this address is not allowed (https and a host the user allowed)');
        if (!this.opens.take()) throw new PluginError('limit', `at most ${LIMITS.openUrlPerMin} addresses a minute`);
        try { await this.hooks.openUrl(args.url, this.eff.net); } catch (e) { throw new PluginError('failed', String((e && e.message) || e).slice(0, 200)); }
        return null;
      }
      case 'net.hosts': return [...this.eff.net];
      case 'net.requestHost': {                                         // (netAny) the plugin asks that the user allow a host; the user decides in the plugin tab
        if (!this.eff.netAny) throw new PluginError('denied', 'the plugin may not ask for hosts (permission netAny)');
        const host = isObj(args) && typeof args.host === 'string' ? args.host.trim().toLowerCase() : '';
        if (!validHost(host)) throw new PluginError('args', 'host: an exact host name (no *, port, path, address or local name)');
        if (this.eff.net.includes(host)) return 'allowed';
        if (!this.hostRequests.take()) throw new PluginError('limit', `at most ${LIMITS.hostRequestsPerMin} host requests a minute`);
        try { return await this.hooks.requestHost(host); } catch (e) { throw new PluginError('limit', String((e && e.message) || e).slice(0, 200)); }
      }
      case 'net.fetch': {
        this.need('net');
        if (!isObj(args) || typeof args.url !== 'string') throw new PluginError('args', 'url is needed');
        if (!netAllowed(this.eff, args.url)) throw new PluginError('denied', 'this address is not allowed (https and an exact host the user allowed)');
        const method = String(args.method || 'GET').toUpperCase();
        if (!['GET', 'POST', 'HEAD'].includes(method)) throw new PluginError('args', 'only GET, POST and HEAD');
        const body = args.body === undefined || args.body === null ? undefined : String(args.body);
        if (body !== undefined && body.length > LIMITS.fetchBody) throw new PluginError('limit', 'the request is too big');
        const headers = isObj(args.headers) ? Object.entries(args.headers).slice(0, LIMITS.fetchHeaders).map(([k, v]) => [String(k), String(v)]) : [];
        await this.turn(new URL(args.url).hostname.toLowerCase());
        try { return await this.hooks.fetch({ url: args.url, method, headers, body, max: LIMITS.fetchAnswer }, this.eff.net); }
        catch (e) { throw new PluginError('failed', String((e && e.message) || e).slice(0, 200)); }
      }
      default: throw new PluginError('args', `unknown call "${method}"`);
    }
  }

  // Gives the waiting lines to the chat, at most one in `injectGapMs` (the host calls this often; a new line calls it too). What was dropped is told as a line of its own.
  pump() {
    const t = this.now();
    for (const [full, patch] of Object.entries(this.widgetPending)) if (t - (this.widgetLast[full] ?? -1e12) >= LIMITS.widgetGapMs) { this.widgetLast[full] = t; delete this.widgetPending[full]; this.hooks.widgetUpdate(full, patch); }
    if (t - this.lastInject < LIMITS.injectGapMs) return;
    if (this.dropped && this.injectQ.length < LIMITS.injectQueue) {
      const n = this.dropped; this.dropped = 0; this.lastInject = t;
      this.hooks.inject({ text: `⚠ ${n} lines were left out because the plugin sent too many`, sender: this.manifest.name });
      this.hooks.log(`${n} lines were left out (too many)`);
      return;
    }
    const line = this.injectQ.shift();
    if (!line) return;
    this.lastInject = t;
    this.hooks.inject(line);
  }

  // the user allowed or took away hosts while the plugin runs (the other permissions need a restart)
  setGranted(manifest, granted) { this.eff = effective(manifest, granted); }

  // the plugin is stopped: its widgets are taken away
  shutdown() { for (const full of this.widgetIds) this.hooks.widgetUnregister(full); this.widgetIds.clear(); this.widgetPending = {}; }

  // a place in the line of the requests to one host: they are spaced `fetchGapMs`; the ones that wait are at most `fetchQueue`
  async turn(host) {
    const t = this.now(), next = Math.max(this.hosts[host] || 0, t);
    if ((next - t) / LIMITS.fetchGapMs >= LIMITS.fetchQueue) throw new PluginError('limit', `too many requests wait for ${host} (${LIMITS.fetchQueue})`);
    this.hosts[host] = next + LIMITS.fetchGapMs;
    if (next > t) await this.sleep(next - t);
  }

  key(k) { if (typeof k !== 'string' || !KEY.test(k)) throw new PluginError('args', "a key of letters, digits and . _ : - (at most 100)"); }
}
