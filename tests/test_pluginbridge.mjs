// The checks on what a plugin asks of the program (app/core/pluginbridge.js)
import { parseManifest } from '../app/core/plugins.js';
import { PluginBridge, PluginError, Limiter, LIMITS } from '../app/core/pluginbridge.js';
import { check, eq } from './helpers.mjs';

const ID = 'bridge-test-plugin-0123456789';
const manifest = parseManifest(JSON.stringify({ id: ID, name: 'T', version: '1.0.0', api: 1,
  permissions: { net: ['example.com'], 'chat.inject': true, storage: true }, reasons: { net: 'a', 'chat.inject': 'b', storage: 'c' },
  options: [{ key: 'url', type: 'text', default: 'u' }, { key: 'n', type: 'number', default: 3 }] }), ID).manifest;
const all = { net: ['example.com'], 'chat.inject': true, storage: true };
let clock = 0;
const make = (granted = all, extra = {}) => {
  const log = { injected: [], fetched: [], saved: [], logs: [] };
  const hooks = { inject: l => log.injected.push(l), fetch: async (r, hosts) => { log.fetched.push([r, hosts]); return { status: 200, body: 'ok', url: r.url, type: 'text/html' }; },
    log: t => log.logs.push(t), load: async () => extra.stored ?? null, save: async o => { log.saved.push(o); } };
  return { b: new PluginBridge({ manifest, granted, hooks, options: extra.options, now: () => clock }), log };
};
const code = async p => { try { await p; return 'ok'; } catch (e) { return e instanceof PluginError ? e.code : 'other:' + e; } };

{ // the limiter
  clock = 0; const l = new Limiter(2, 1000, () => clock);
  check(l.take() && l.take() && !l.take(), 'bridge: the limiter stops the third in a window');
  clock = 1001; check(l.take(), 'bridge: and lets go again later');
}
{ // permissions: nothing allowed
  const { b } = make({});
  eq(await code(b.call('chat.inject', { text: 'x' })), 'denied', 'bridge: chat.inject is denied without the permission');
  eq(await code(b.call('storage.get', { key: 'a' })), 'denied', 'bridge: storage is denied');
  eq(await code(b.call('net.fetch', { url: 'https://example.com/' })), 'denied', 'bridge: net.fetch is denied');
  eq((await b.call('meta')).allowed, { net: [], 'chat.inject': false, storage: false }, 'bridge: meta tells what is allowed');
  eq(await code(b.call('nothing')), 'args', 'bridge: an unknown call');
}
{ // chat.inject
  clock = 0; const { b, log } = make();
  await b.call('chat.inject', { text: '  새 글  ', sender: '커뮤니티' });
  eq(log.injected, [{ text: '새 글', sender: '커뮤니티' }], 'bridge: a line is given to the host, cleaned');
  await b.call('chat.inject', { text: 'x'.repeat(900), sender: 'y'.repeat(100) });
  eq([log.injected[1].text.length, log.injected[1].sender.length], [LIMITS.injectText, LIMITS.injectSender], 'bridge: a long line and name are cut');
  eq(await code(b.call('chat.inject', { text: '   ' })), 'args', 'bridge: an empty line is refused');
  eq(await code(b.call('chat.inject', 'x')), 'args', 'bridge: arguments must be an object');
  for (let i = 0; i < LIMITS.injectPerMin - 2; i++) await b.call('chat.inject', { text: 'a' });
  eq(await code(b.call('chat.inject', { text: 'one too many' })), 'limit', 'bridge: the lines a minute are limited');
  clock = 61_000; eq(await code(b.call('chat.inject', { text: 'again' })), 'ok', 'bridge: and free again a minute later');
}
{ // storage
  const { b, log } = make(all, { stored: { old: 1 } });
  eq(await b.call('storage.get', { key: 'old' }), 1, 'bridge: the stored value is read');
  eq(await b.call('storage.get', { key: 'none' }), null, 'bridge: a missing key is null');
  await b.call('storage.set', { key: 'a', value: { x: [1, 2] } });
  eq(log.saved.at(-1), { old: 1, a: { x: [1, 2] } }, 'bridge: set is saved with the rest');
  eq(await b.call('storage.keys'), ['old', 'a'], 'bridge: keys');
  await b.call('storage.remove', { key: 'old' });
  eq(log.saved.at(-1), { a: { x: [1, 2] } }, 'bridge: remove');
  eq(await code(b.call('storage.set', { key: 'bad key', value: 1 })), 'args', 'bridge: a bad key');
  eq(await code(b.call('storage.set', { key: 'f', value: () => 1 })), 'args', 'bridge: a value JSON cannot hold');
  eq(await code(b.call('storage.set', { key: 'big', value: 'x'.repeat(LIMITS.storageBytes) })), 'limit', 'bridge: the storage has a size limit');
  const v = await b.call('storage.get', { key: 'a' }); v.x.push(3);
  eq(await b.call('storage.get', { key: 'a' }), { x: [1, 2] }, 'bridge: what is read is a copy');
}
{ // storage: the number of keys
  const { b } = make(all, { stored: Object.fromEntries(Array.from({ length: LIMITS.storageKeys }, (_, i) => ['k' + i, 1])) });
  eq(await code(b.call('storage.set', { key: 'one-more', value: 1 })), 'limit', 'bridge: the number of keys is limited');
  eq(await code(b.call('storage.set', { key: 'k1', value: 2 })), 'ok', 'bridge: an existing key can still change');
}
{ // net.fetch
  clock = 0; const { b, log } = make();
  const r = await b.call('net.fetch', { url: 'https://example.com/list?page=1', headers: { 'X-A': 1 } });
  eq([r.status, log.fetched[0][0].method, log.fetched[0][0].headers, log.fetched[0][1]], [200, 'GET', [['X-A', '1']], ['example.com']], 'bridge: a request to an allowed host is made, with the hosts for the redirect check');
  eq(await code(b.call('net.fetch', { url: 'https://evil.org/' })), 'denied', 'bridge: another host is denied');
  eq(await code(b.call('net.fetch', { url: 'http://example.com/' })), 'denied', 'bridge: http is denied');
  eq(await code(b.call('net.fetch', { url: 'https://example.com/', method: 'DELETE' })), 'args', 'bridge: only GET POST HEAD');
  eq(await code(b.call('net.fetch', { url: 'https://example.com/', body: 'x'.repeat(LIMITS.fetchBody + 1), method: 'POST' })), 'limit', 'bridge: a big body');
  for (let i = 0; i < LIMITS.fetchPerMin - 1; i++) await b.call('net.fetch', { url: 'https://example.com/' });
  eq(await code(b.call('net.fetch', { url: 'https://example.com/' })), 'limit', 'bridge: requests a minute are limited');
}
{ // net.fetch: a host the manifest does not name is not used even if the user's list has it
  const { b } = make({ net: ['evil.org', 'example.com'], 'chat.inject': true, storage: true });
  eq(await code(b.call('net.fetch', { url: 'https://evil.org/' })), 'denied', 'bridge: allowed by the user but not asked for: denied');
}
{ // a failing request, options, log
  const hooks = { inject() {}, fetch: async () => { throw new Error('boom'); }, log: () => {}, load: async () => null, save: async () => {} };
  const b = new PluginBridge({ manifest, granted: all, hooks, options: { n: 9 } });
  eq(await code(b.call('net.fetch', { url: 'https://example.com/' })), 'failed', 'bridge: a failing request is "failed"');
  eq(await b.call('options.get'), { url: 'u', n: 9 }, 'bridge: options = defaults of the manifest + the user\'s values');
  const { b: b2, log } = make(); clock = 0;
  for (let i = 0; i < LIMITS.logPerMin + 5; i++) await b2.call('log', { text: 'x' });
  eq(log.logs.length, LIMITS.logPerMin, 'bridge: too many log lines are dropped');
}
