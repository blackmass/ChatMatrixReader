// What a plugin may ask of the program, and the checks on every ask (no window code): the plugin page (a sandboxed frame) sends { method, args } by postMessage, the host (plugin_host.js)
// gives it to the bridge of that plugin, and the answer (or the error) goes back. A call is carried out only when the manifest asked for the permission AND the user allowed it, and every
// call that costs something has a limit. The bridge knows nothing of windows: what really happens (a line in the chat, a request, a file) is given in `hooks`.
//
//   const b = new PluginBridge({ manifest, granted, hooks: { inject(line), fetch(req, hosts), log(text), load(), save(obj) }, options, now })
//   await b.call('chat.inject', { text, sender })      -> value  |  throws PluginError { code: 'denied' | 'limit' | 'args' | 'failed' }
import { effective, netAllowed } from './plugins.js';

export class PluginError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const LIMITS = {
  injectPerMin: 30, injectText: 500, injectSender: 40,
  fetchPerMin: 20, fetchBody: 1_000_000, fetchAnswer: 2_000_000, fetchHeaders: 30,
  storageBytes: 1_000_000, storageKeys: 1000, storageKey: 100,
  logPerMin: 120, logText: 500,
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
    this.hooks = hooks;
    this.options = { ...Object.fromEntries(manifest.options.map(o => [o.key, o.default])), ...options };
    this.inject = new Limiter(LIMITS.injectPerMin, 60_000, now);
    this.fetches = new Limiter(LIMITS.fetchPerMin, 60_000, now);
    this.logs = new Limiter(LIMITS.logPerMin, 60_000, now);
    this.data = null;                                   // the storage, read at the first use
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
      case 'options.get': return { ...this.options };
      case 'log': {
        if (!this.logs.take()) return null;                          // (too many: dropped without a word)
        this.hooks.log(String(isObj(args) ? args.text : args).slice(0, LIMITS.logText));
        return null;
      }
      case 'chat.inject': {
        this.need('chat.inject');
        if (!isObj(args) || typeof args.text !== 'string' || !args.text.trim()) throw new PluginError('args', 'text is needed');
        if (!this.inject.take()) throw new PluginError('limit', `at most ${LIMITS.injectPerMin} lines a minute`);
        const sender = typeof args.sender === 'string' ? args.sender.trim().slice(0, LIMITS.injectSender) : '';
        this.hooks.inject({ text: args.text.trim().slice(0, LIMITS.injectText), sender });
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
      case 'net.fetch': {
        this.need('net');
        if (!isObj(args) || typeof args.url !== 'string') throw new PluginError('args', 'url is needed');
        if (!netAllowed(this.eff, args.url)) throw new PluginError('denied', 'this address is not allowed (https and an exact host the user allowed)');
        const method = String(args.method || 'GET').toUpperCase();
        if (!['GET', 'POST', 'HEAD'].includes(method)) throw new PluginError('args', 'only GET, POST and HEAD');
        const body = args.body === undefined || args.body === null ? undefined : String(args.body);
        if (body !== undefined && body.length > LIMITS.fetchBody) throw new PluginError('limit', 'the request is too big');
        const headers = isObj(args.headers) ? Object.entries(args.headers).slice(0, LIMITS.fetchHeaders).map(([k, v]) => [String(k), String(v)]) : [];
        if (!this.fetches.take()) throw new PluginError('limit', `at most ${LIMITS.fetchPerMin} requests a minute`);
        try { return await this.hooks.fetch({ url: args.url, method, headers, body, max: LIMITS.fetchAnswer }, this.eff.net); }
        catch (e) { throw new PluginError('failed', String((e && e.message) || e).slice(0, 200)); }
      }
      default: throw new PluginError('args', `unknown call "${method}"`);
    }
  }

  key(k) { if (typeof k !== 'string' || !KEY.test(k)) throw new PluginError('args', "a key of letters, digits and . _ : - (at most 100)"); }
}
