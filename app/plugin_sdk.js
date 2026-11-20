// The way a plugin page talks to the program. The page loads it from its own address:  <script src="__sdk/plugin.js"></script>   (the program serves it to every plugin)
// It makes `window.cmr`. Everything goes by messages to the program, which checks the permissions and the limits (app/core/pluginbridge.js); a refused call rejects with an
// error that has `.code`: 'denied' (not allowed), 'limit' (too many / too big), 'args' (a wrong ask) or 'failed'.
//
//   await cmr.meta()                                      { id, name, version, api, allowed }
//   cmr.log('text')                                       a line in the log of the plugin (plugin tab)
//   await cmr.chat.inject({ text, sender })               a line in the chat windows            (permission chat.inject)
//   await cmr.storage.get(key) / set(key, value) / remove(key) / keys()    the plugin's own data (permission storage)
//   await cmr.net.fetch({ url, method, headers, body })   -> { status, body, url, type }        (permission net: https, the hosts the user allowed)
//   await cmr.widgets.register({ id, label, kind, styles, settings, hint }) / update(id, state) / unregister(id)     a small part on the chat windows (permission widgets)
//        (kind: meter | light | text; state: { active, value 0..1, marker, tone, text, tip }; the user turns it on and places it in the options)
//   await cmr.windows.open(id) / close(id)                a window the plugin declared in plugin.json ("windows"); its page is shown in it (permission windows)
//   await cmr.net.requestHost(host)                       (permission netAny) asks the user to allow a host: 'allowed' | 'pending'; the user answers in the plugin tab
//   await cmr.net.hosts()  /  cmr.net.onHosts(fn)         the hosts the plugin may fetch now / fn(hosts) when the user allows or takes away one
//   await cmr.options.get()                               the values of the options of the plugin (what the user set; the defaults of plugin.json)
//   await cmr.options.set({ key: value, ... })            keeps values (the declared options are made right; any other key is the plugin's own setting: letters, digits, '_'; JSON values)
//   cmr.options.onChange(fn)                              fn(values) when the options change (by the user, or by the plugin's own options page)
// A page of the plugin that is shown in the options window ("optionsPage" in plugin.json) tells its height by itself, so the program can give it the room it needs.
(() => {
  const pending = new Map();
  const listeners = [];
  const hostListeners = [];
  let seq = 0;
  addEventListener('message', e => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.cmr !== 1) return;
    if (m.event === 'ping') { parent.postMessage({ cmr: 1, event: 'pong' }, '*'); return; }          // ("are you there?": a page that is stuck in a loop cannot answer; the program starts it again)
    if (m.event === 'hosts') { for (const f of hostListeners) { try { f(m.value); } catch (err) { console.error(err); } } return; }
    if (m.event === 'options') { for (const f of listeners) { try { f(m.value); } catch (err) { console.error(err); } } return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(Object.assign(new Error((m.error && m.error.message) || 'failed'), { code: (m.error && m.error.code) || 'failed' }));
  });
  // an error of the page itself is told to the program (the log of the plugin shows it: a plugin that stops without a word is the hardest to mend)
  const report = text => { try { parent.postMessage({ cmr: 1, event: 'error', value: String(text).slice(0, 300) }, '*'); } catch { /* no parent */ } };
  addEventListener('error', e => report((e.message || 'error') + (e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : '')));
  addEventListener('unhandledrejection', e => report('unhandled: ' + ((e.reason && e.reason.message) || e.reason)));
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
    net: { fetch: a => call('net.fetch', a), requestHost: host => call('net.requestHost', { host }), hosts: () => call('net.hosts'), onHosts: fn => { hostListeners.push(fn); } },
    windows: { open: id => call('windows.open', { id }), close: id => call('windows.close', { id }) },
    widgets: { register: def => call('widgets.register', def), update: (id, state) => call('widgets.update', { id, state }), unregister: id => call('widgets.unregister', { id }) },
    options: { get: () => call('options.get'), set: values => call('options.set', values), onChange: fn => { listeners.push(fn); } },
  };
  parent.postMessage({ cmr: 1, event: 'hello' }, '*');
  // the height of the page (for the options window, which shows it in a frame)
  let lastHeight = 0;
  const tellHeight = () => { const h = Math.ceil(document.documentElement.scrollHeight); if (h !== lastHeight) { lastHeight = h; parent.postMessage({ cmr: 1, event: 'height', value: h }, '*'); } };
  const watch = () => { try { new ResizeObserver(tellHeight).observe(document.documentElement); } catch { /* no observer */ } tellHeight(); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', watch); else watch();
})();
