// The checks on what a plugin asks of the program (app/core/pluginbridge.js)
import { parseManifest } from '../app/core/plugins.js';
import { PluginBridge, PluginError, Limiter, LIMITS } from '../app/core/pluginbridge.js';
import { check, eq } from './helpers.mjs';

const ID = 'bridge-test-plugin-0123456789';
const manifest = parseManifest(JSON.stringify({ id: ID, name: 'T', version: '1.0.0', api: 1,
  permissions: { net: ['example.com'], netAny: true, 'chat.inject': true, 'chat.read': false, capture: false, storage: true, widgets: true, windows: true, openUrl: true, web: 'domain' }, reasons: { net: 'a', 'chat.inject': 'b', storage: 'c', widgets: 'd', windows: 'e', openUrl: 'g' }, windows: [{ id: 'main', page: 'w.html' }],
  options: [{ key: 'url', type: 'text', default: 'u' }, { key: 'n', type: 'number', default: 3 }] }), ID).manifest;
const all = { net: ['example.com'], netAny: true, 'chat.inject': true, 'chat.read': false, capture: false, storage: true, widgets: true, windows: true, openUrl: true, web: 'domain' };
let clock = 0;
const make = (granted = all, extra = {}) => {
  const log = { injected: [], fetched: [], saved: [], logs: [] };
  const hooks = { inject: l => log.injected.push(l), fetch: async (r, hosts) => { log.fetched.push([r, hosts]); return { status: 200, body: 'ok', url: r.url, type: 'text/html' }; },
    log: t => log.logs.push(t), load: async () => extra.stored ?? null, save: async o => { log.saved.push(o); }, setOptions: async o => { (log.options = log.options || []).push(o); }, widgetRegister: d => (log.defs = log.defs || []).push(d), widgetUpdate: (id, p) => (log.states = log.states || []).push([id, p]), widgetUnregister: id => (log.gone = log.gone || []).push(id), webOpen: async (r, pat) => (log.webs = log.webs || []).push(['open', r, pat]), webClose: async () => (log.webs = log.webs || []).push(['close']), openUrl: async (u, hosts) => (log.opened = log.opened || []).push([u, hosts]), requestHost: async h => { (log.requests = log.requests || []).push(h); return 'pending'; }, windowOpen: async id => (log.wins = log.wins || []).push(['open', id]), windowClose: async id => (log.wins = log.wins || []).push(['close', id]), sleep: extra.sleep || (async ms => { clock += ms; }) };
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
  eq((await b.call('meta')).allowed, { net: [], netAny: false, 'chat.inject': false, 'chat.read': false, capture: false, storage: false, widgets: false, windows: false, openUrl: false, web: "" }, 'bridge: meta tells what is allowed');
  eq(await code(b.call('nothing')), 'args', 'bridge: an unknown call');
}
{ // chat.inject: the plugin may call as often as it likes; the lines go out one by one, spaced (a queue), and what does not fit is dropped and told
  clock = 0; const { b, log } = make();
  await b.call('chat.inject', { text: '  새 글  ', sender: '커뮤니티' });
  eq(log.injected, [{ text: '새 글', sender: '커뮤니티' }], 'bridge: the first line goes out at once, cleaned');
  await b.call('chat.inject', { text: 'x'.repeat(900), sender: 'y'.repeat(100) });
  await b.call('chat.inject', { text: 'third' });
  eq(log.injected.length, 1, 'bridge: the next lines wait their turn');
  clock = 300; b.pump(); eq(log.injected.length, 1, 'bridge: not before the gap has passed');
  clock = 700; b.pump();
  eq([log.injected.length, log.injected[1].text.length, log.injected[1].sender.length], [2, LIMITS.injectText, LIMITS.injectSender], 'bridge: then one line, a long line and name are cut');
  clock = 1400; b.pump(); eq(log.injected.map(l => l.text.slice(0, 5)), ['새 글', 'xxxxx', 'third'], 'bridge: in the order they came');
  eq(await code(b.call('chat.inject', { text: '   ' })), 'args', 'bridge: an empty line is refused');
  eq(await code(b.call('chat.inject', 'x')), 'args', 'bridge: arguments must be an object');
}
{ // chat.inject: a flood
  clock = 0; const { b, log } = make();
  for (let i = 0; i < 1 + LIMITS.injectQueue + 3; i++) await b.call('chat.inject', { text: 'line ' + i });       // 1 goes out, 50 wait, 3 do not fit
  eq(log.injected.length, 1, 'bridge: a flood: one out, the queue holds ' + LIMITS.injectQueue);
  eq(log.logs.filter(t => t.includes('queue')).length, 1, 'bridge: the log tells once that lines are dropped');
  for (let i = 1; i <= LIMITS.injectQueue + 2; i++) { clock = i * LIMITS.injectGapMs; b.pump(); }
  const texts = log.injected.map(l => l.text);
  eq([texts.length, texts.filter(t => t.startsWith('line ')).length, texts.some(t => t.includes('3 lines were left out'))], [LIMITS.injectQueue + 2, LIMITS.injectQueue + 1, true], 'bridge: the lines come one by one, then one line tells that 3 were left out: ' + texts.length);
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
  clock = 0; const c2 = make(); const t0 = clock;
  await c2.b.call('net.fetch', { url: 'https://example.com/a' }); await c2.b.call('net.fetch', { url: 'https://example.com/b' }); await c2.b.call('net.fetch', { url: 'https://example.com/c' });
  eq([c2.log.fetched.length, clock - t0], [3, 2 * LIMITS.fetchGapMs], 'bridge: requests to one host are spaced: they wait their turn, they are not refused');
}
{ // net.fetch: too many wait
  clock = 0; const { b } = make(all, { sleep: () => new Promise(() => {}) });
  const waiting = [];
  for (let i = 0; i < LIMITS.fetchQueue; i++) waiting.push(b.call('net.fetch', { url: 'https://example.com/' + i }));
  eq(await code(b.call('net.fetch', { url: 'https://example.com/more' })), 'limit', 'bridge: when too many wait for one host, the next is refused');
}
{ // net.fetch: a host the manifest does not name is not used even if the user's list has it
  const { b } = make({ net: ['evil.org', 'example.com'], 'chat.inject': true, 'chat.read': false, capture: false, storage: true, widgets: true, windows: true });
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
{ // options.set: the plugin's own settings (its options page)
  const { b, log } = make(all, { options: { n: 9 } });
  const r = await b.call('options.set', { interval: 5, mine: { a: [1] }, n: 2 });
  eq([r.interval, r.mine, r.url], [5, { a: [1] }, 'u'], 'bridge: options.set merges, the declared one is cleaned, the plugin\'s own key is kept: ' + JSON.stringify(r));
  eq(log.options.at(-1).mine, { a: [1] }, 'bridge: and the host is told to keep it');
  eq((await b.call('options.get')).mine, { a: [1] }, 'bridge: options.get gives it back');
  eq(await code(b.call('options.set', 'x')), 'args', 'bridge: options.set needs an object');
}
{ // widgets: the plugin registers its widgets under its own name, and says how they are now (at most every 100 ms: the newest wins)
  clock = 0; const { b, log } = make();
  const id = await b.call('widgets.register', { id: 'status', label: '상태', kind: 'light', styles: [{ id: 'dot', label: '점' }] });
  eq([id, log.defs[0].id, log.defs[0].owner, log.defs[0].kind], [ID + ':status', ID + ':status', ID, 'light'], 'bridge: a widget is registered under the id of the plugin');
  await b.call('widgets.update', { id: 'status', state: { text: 'one', tone: 'ok', active: true } });
  await b.call('widgets.update', { id: 'status', state: { text: 'two' } }); await b.call('widgets.update', { id: 'status', state: { tone: 'hot' } });
  eq(log.states.length, 1, 'bridge: the next states wait (at most every 100 ms)');
  clock = 100; b.pump();
  eq([log.states.length, log.states[1][1]], [2, { text: 'two', tone: 'hot' }], 'bridge: then the newest goes out, the waiting ones merged');
  eq(await code(b.call('widgets.update', { id: 'other', state: { text: 'x' } })), 'args', 'bridge: a widget the plugin did not register');
  eq(await code(b.call('widgets.register', { id: 'Bad Name', label: 'x' })), 'args', 'bridge: a bad widget name');
  for (let i = 0; i < LIMITS.widgets - 1; i++) await b.call('widgets.register', { id: 'w' + i, label: 'x', kind: 'text' });
  eq(await code(b.call('widgets.register', { id: 'one-more', label: 'x', kind: 'text' })), 'limit', 'bridge: the number of widgets is limited');
  await b.call('widgets.unregister', { id: 'status' }); eq(log.gone, [ID + ':status'], 'bridge: unregister');
  b.shutdown(); eq(log.gone.length, LIMITS.widgets, 'bridge: stopping the plugin takes all its widgets away');
  const none = make({ ...all, widgets: false });
  eq(await code(none.b.call('widgets.register', { id: 'a', label: 'x' })), 'denied', 'bridge: widgets are denied without the permission');
}
{ // windows: the plugin opens and closes the windows it declared
  clock = 0; const { b, log } = make();
  await b.call('windows.open', { id: 'main' }); await b.call('windows.close', { id: 'main' });
  eq(log.wins, [['open', 'main'], ['close', 'main']], 'bridge: the plugin opens and closes its window');
  eq(await code(b.call('windows.open', { id: 'other' })), 'args', 'bridge: a window that is not declared');
  for (let i = 0; i < LIMITS.windowCallsPerMin - 2; i++) await b.call('windows.open', { id: 'main' });
  eq(await code(b.call('windows.open', { id: 'main' })), 'limit', 'bridge: the window calls are limited');
  eq(await code(make({ ...all, windows: false }).b.call('windows.open', { id: 'main' })), 'denied', 'bridge: windows are denied without the permission');
}
{ // netAny: the plugin asks for a host; the user decides outside
  clock = 0; const { b, log } = make({ ...all, net: ['example.com', 'forum.example.org'] });
  eq(await b.call('net.requestHost', { host: 'Forum.Example.org' }), 'allowed', 'bridge: a host that is allowed already: "allowed"');
  eq(await b.call('net.requestHost', { host: 'new.example.net' }), 'pending', 'bridge: a new host waits for the user');
  eq(log.requests, ['new.example.net'], 'bridge: the host is handed over, lower case');
  for (const bad of ['*.example.com', 'localhost', '10.0.0.1', 'example.com:80', 'https://example.com', '', 5]) eq(await code(b.call('net.requestHost', { host: bad })), 'args', 'bridge: a wrong host is refused: ' + bad);
  eq(await b.call('net.hosts'), ['example.com', 'forum.example.org'], 'bridge: the plugin may ask which hosts it has');
  const r = await b.call('net.fetch', { url: 'https://forum.example.org/list' }); eq(r.status, 200, 'bridge: a host the user allowed can be fetched');
  b.setGranted(manifest, { ...all, net: ['example.com', 'forum.example.org', 'later.example.net'] });
  eq(await b.call('net.hosts'), ['example.com', 'forum.example.org', 'later.example.net'], 'bridge: hosts the user allows later are used without a restart');
  const off = make({ ...all, netAny: false });
  eq(await code(off.b.call('net.requestHost', { host: 'new.example.net' })), 'denied', 'bridge: without netAny a host cannot be asked for');
  clock = 0; const f = make({ ...all, net: ['example.com'] });
  for (let i = 0; i < LIMITS.hostRequestsPerMin; i++) await f.b.call('net.requestHost', { host: 'h' + i + '.example.net' });
  eq(await code(f.b.call('net.requestHost', { host: 'more.example.net' })), 'limit', 'bridge: the host requests are limited');
}
{ // openUrl: an address in the browser of the user
  clock = 0; const { b, log } = make();
  await b.call('openUrl', { url: 'https://example.com/view?no=3&id=x' });
  eq(log.opened, [['https://example.com/view?no=3&id=x', ['example.com', '*.example.com']]], 'bridge: an allowed address is handed over with the hosts');
  for (const bad of ['http://example.com/', 'https://evil.org/', 'https://user:pw@example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://example.com.evil.org/']) eq(await code(b.call('openUrl', { url: bad })), 'denied', 'bridge: openUrl refuses ' + bad);
  eq(await code(b.call('openUrl', {})), 'args', 'bridge: openUrl needs an url');
  for (let i = 0; i < LIMITS.openUrlPerMin - 1; i++) await b.call('openUrl', { url: 'https://example.com/' + i });
  eq(await code(b.call('openUrl', { url: 'https://example.com/more' })), 'limit', 'bridge: openUrl is limited');
  eq(await code(make({ ...all, openUrl: false, web: "" }).b.call('openUrl', { url: 'https://example.com/' })), 'denied', 'bridge: openUrl is denied without the permission');
}

{ // web.open: the page in a window of the program (https, a host the web permission covers)
  const { b, log } = make();
  await b.call('web.open', { url: 'https://m.example.com/a?x=1', title: 'T' });
  eq(log.webs[0][1], { url: 'https://m.example.com/a?x=1', title: 'T', mobile: true }, 'bridge: web.open passes the address');
  eq(log.webs[0][2], ['*.example.com'], 'bridge: web.open tells the window where it may go (domain)');
  for (const bad of ['http://example.com/', 'https://evil.org/', 'https://example.com.evil.org/', 'https://u:p@example.com/', 'javascript:1', 'nonsense']) eq(await code(b.call('web.open', { url: bad })), bad === 'nonsense' ? 'args' : 'denied', 'bridge: web.open refuses ' + bad);
  await b.call('web.close', {}); eq(log.webs[1][0], 'close', 'bridge: web.close');
  const h = make({ ...all, web: 'host' });
  eq(await code(h.b.call('web.open', { url: 'https://m.example.com/' })), 'denied', 'bridge: with "host" only the allowed host');
  await h.b.call('web.open', { url: 'https://example.com/' }); eq(h.log.webs[0][2], ['example.com'], 'bridge: web.open with host scope');
  eq(await code(make({ ...all, web: '' }).b.call('web.open', { url: 'https://example.com/' })), 'denied', 'bridge: web.open without the permission');
}
{ // openUrl with the web permission: the domain of an allowed host is allowed too (the same reach as the web window)
  const { b, log } = make();
  await b.call('openUrl', { url: 'https://m.example.com/x' });
  eq(log.opened[0][0], 'https://m.example.com/x', 'bridge: openUrl accepts a host under the domain when the web permission is "domain"');
  const h = make({ ...all, web: 'host' });
  eq(await code(h.b.call('openUrl', { url: 'https://m.example.com/x' })), 'denied', 'bridge: not with "host"');
}

{ // chat.inject with a link: the address must be one the permission covers; the link goes with the line
  clock = 0;
  const { b, log } = make();
  await b.call('chat.inject', { text: 'new: Hello world', sender: 's', link: { url: 'https://m.example.com/p/1', text: 'Hello world' } });
  b.pump();
  const first = log.injected.at(-1);
  eq(first && first.link && first.link.url, 'https://m.example.com/p/1', 'bridge: the line carries its link');
  eq(first.link.target + '|' + first.link.text, 'web|Hello world', 'bridge: the link target is the web window by default');
  for (const bad of ['http://example.com/', 'https://evil.org/', 'https://user:pw@example.com/', 'javascript:1']) eq(await code(b.call('chat.inject', { text: 'x', link: { url: bad } })), 'denied', 'bridge: a link to ' + bad + ' is refused');
  eq(await code(b.call('chat.inject', { text: 'x', link: { url: 'https://example.com/', target: 'browser' } })), 'ok', 'bridge: a link for the browser to an allowed site');
  eq(await code(make({ ...all, web: '' }).b.call('chat.inject', { text: 'x', link: { url: 'https://example.com/' } })), 'denied', 'bridge: no web permission: no link to the web window');
}

{ // pictures of the game and the lines read: the permissions, the checks on what is asked, one picture at a time, and the limit
  const man = parseManifest(JSON.stringify({ id: ID, name: 'T', version: '1.0.0', api: 1, permissions: { capture: true, 'chat.read': true }, reasons: { capture: 'a', 'chat.read': 'b' } }), ID).manifest;
  const grant = { capture: true, 'chat.read': true };
  let open = 0, maxOpen = 0; const asks = [];
  const mk = (granted = grant) => {
    open = 0; maxOpen = 0; asks.length = 0;
    const hooks = { log: () => {}, captureInfo: async () => ({ width: 1920, height: 1080 }),
      captureGrab: async r => { asks.push(r); open++; maxOpen = Math.max(maxOpen, open); await new Promise(res => setTimeout(res, 5)); open--; return { width: r.w * r.scale, height: r.h * r.scale, mime: 'image/png', base64: 'AAAA' }; },
      chatRecent: n => [{ channel: 'G', sender: 'a', text: 'hello' }].slice(0, n) };
    return new PluginBridge({ manifest: man, granted, hooks, now: () => clock });
  };
  clock = 0;
  const none = mk({});
  for (const m of ['capture.info', 'chat.recent']) eq(await code(none.call(m, {})), 'denied', `bridge: ${m} is denied without the permission`);
  eq(await code(none.call('capture.grab', { x: 0, y: 0, w: 100, h: 100 })), 'denied', 'bridge: a picture is denied without the permission');
  const b = mk();
  eq(await b.call('capture.info'), { width: 1920, height: 1080 }, 'bridge: the size of the game window');
  eq((await b.call('capture.grab', { x: 10, y: 20, w: 200, h: 60 })).width, 200, 'bridge: a part of the game window comes as a picture');
  eq(asks[0], { x: 10, y: 20, w: 200, h: 60, scale: 1, format: 'png' }, 'bridge: what the host is asked for (the defaults are filled in)');
  eq((await b.call('capture.grab', { x: 0, y: 0, w: 100, h: 50, scale: 2, format: 'jpeg' })).width, 200, 'bridge: a larger picture (scale)');
  for (const bad of [{ x: -1, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 4, h: 100 }, { x: 0.5, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100, scale: 0 }, { x: 0, y: 0, w: 100, h: 100, scale: 9 }, { x: 0, y: 0, w: 100, h: 100, format: 'gif' }, 'x', null])
    eq(await code(b.call('capture.grab', bad)), 'args', 'bridge: a wrong ask for a picture is refused: ' + JSON.stringify(bad));
  eq(await code(b.call('capture.grab', { x: 0, y: 0, w: 1920, h: 1080 })), 'ok', 'bridge: the whole 1080p picture is allowed');
  eq(await code(b.call('capture.grab', { x: 0, y: 0, w: 3840, h: 2160 })), 'limit', 'bridge: a whole 4K screen is too big');
  eq(await code(b.call('capture.grab', { x: 0, y: 0, w: 1920, h: 1080, scale: 3 })), 'limit', 'bridge: and so is a small part made too large');
  asks.length = 0;
  await Promise.all([1, 2, 3, 4].map(i => b.call('capture.grab', { x: i, y: 0, w: 100, h: 100 })));
  eq([asks.length, maxOpen], [4, 1], 'bridge: the pictures are taken one at a time');
  clock = 0; const c = mk();
  let ok = 0; for (let i = 0; i < LIMITS.captureCallsPerMin + 5; i++) { if (await code(c.call('capture.grab', { x: 0, y: 0, w: 100, h: 100 })) === 'ok') ok++; }
  eq(ok, LIMITS.captureCallsPerMin, 'bridge: a few pictures a second at most (a minute holds the limit)');
  eq(await b.call('chat.recent', { count: 5 }), [{ channel: 'G', sender: 'a', text: 'hello' }], 'bridge: the last readable lines');
  eq(await code(mk({ capture: true }).call('chat.recent', {})), 'denied', 'bridge: the lines need chat.read, a picture permission does not give them');
  eq(await code(mk({ 'chat.read': true }).call('capture.info', {})), 'denied', 'bridge: and the lines do not give a picture');
}
