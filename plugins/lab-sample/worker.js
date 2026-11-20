// a classic worker file of the plugin
(async () => {
  const r = [];
  const t = async (n, f) => { try { r.push(n + ' -> ' + await f()); } catch (e) { r.push(n + ' -> blocked (' + (e && e.name) + ')'); } };
  r.push('typeof __TAURI__=' + typeof self.__TAURI__);
  await t('fetch own data.json', async () => (await fetch('data.json')).status);
  await t('fetch example.com no-cors', async () => (await fetch('https://example.com/', { mode: 'no-cors' })).type);
  await t('WebSocket', () => new Promise((ok, no) => { try { const w = new WebSocket('wss://example.com/'); w.onerror = () => no({ name: 'error event' }); w.onopen = () => ok('OPENED'); setTimeout(() => ok('no answer'), 3000); } catch (e) { no(e); } }));
  postMessage(r);
})();
