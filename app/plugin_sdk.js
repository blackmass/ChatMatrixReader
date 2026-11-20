// The way a plugin page talks to the program. The page loads it from its own address:  <script src="__sdk/plugin.js"></script>   (the program serves it to every plugin)
// It makes `window.cmr`. Everything goes by messages to the program, which checks the permissions and the limits (app/core/pluginbridge.js); a refused call rejects with an
// error that has `.code`: 'denied' (not allowed), 'limit' (too many / too big), 'args' (a wrong ask) or 'failed'.
//
//   await cmr.meta()                                      { id, name, version, api, allowed }
//   cmr.log('text')                                       a line in the log of the plugin (plugin tab)
//   await cmr.chat.inject({ text, sender })               a line in the chat windows            (permission chat.inject)
//   await cmr.storage.get(key) / set(key, value) / remove(key) / keys()    the plugin's own data (permission storage)
//   await cmr.net.fetch({ url, method, headers, body })   -> { status, body, url, type }        (permission net: https, the hosts the user allowed)
//   await cmr.options.get()                               the values of the options of the plugin (what the user set; the defaults of plugin.json)
//   cmr.options.onChange(fn)                              fn(values) when the user changes them
(() => {
  const pending = new Map();
  const listeners = [];
  let seq = 0;
  addEventListener('message', e => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.cmr !== 1) return;
    if (m.event === 'options') { for (const f of listeners) { try { f(m.value); } catch (err) { console.error(err); } } return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(Object.assign(new Error((m.error && m.error.message) || 'failed'), { code: (m.error && m.error.code) || 'failed' }));
  });
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ cmr: 1, id, method, args }, '*');
    setTimeout(() => { if (pending.delete(id)) reject(Object.assign(new Error('no answer from the program'), { code: 'failed' })); }, 60_000);
  });
  window.cmr = {
    meta: () => call('meta'),
    log: text => call('log', { text: String(text) }),
    chat: { inject: a => call('chat.inject', a) },
    storage: { get: key => call('storage.get', { key }), set: (key, value) => call('storage.set', { key, value }), remove: key => call('storage.remove', { key }), keys: () => call('storage.keys') },
    net: { fetch: a => call('net.fetch', a) },
    options: { get: () => call('options.get'), onChange: fn => { listeners.push(fn); } },
  };
  parent.postMessage({ cmr: 1, event: 'hello' }, '*');
})();
