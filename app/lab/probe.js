// the questions a plugin-like code asks; used by the worker and by the frames (no import: a worker may not be a module)
async function probe(scope) {
  const r = [];
  r.push(`typeof __TAURI__=${typeof scope.__TAURI__}, __TAURI_INTERNALS__=${typeof scope.__TAURI_INTERNALS__}, location=${scope.location && scope.location.href}`);
  // raw requests to the exe's IPC address (the key the pages get is not known here: 'denied' is the good answer)
  for (const base of ['http://ipc.localhost/', 'ipc://localhost/']) {
    try {
      const res = await fetch(base + 'os_kind', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Tauri-Callback': '1', 'Tauri-Error': '2', 'Tauri-Invoke-Key': 'guess' }, body: '{}' });
      r.push(`IPC ${base}os_kind -> ${res.status} ${String(await res.text()).slice(0, 80)}`);
    } catch (e) { r.push(`IPC ${base}os_kind -> failed (${e && e.name}: ${e && e.message})`); }
  }
  // the app's own files
  for (const p of ['/core/version.js', '/hub.js', '/config.json', '/../config.json']) {
    try { const res = await fetch(p); r.push(`GET ${p} -> ${res.status}`); } catch (e) { r.push(`GET ${p} -> failed (${e && e.name})`); }
  }
  // a request to another site (no-cors: it is sent, the answer is not readable; 'resolved' means anything could be sent out)
  try { const res = await fetch('https://example.com/', { mode: 'no-cors' }); r.push(`OUT https://example.com no-cors -> resolved (${res.type})`); } catch (e) { r.push(`OUT https://example.com no-cors -> blocked (${e && e.name})`); }
  try { const res = await fetch('https://example.com/'); r.push(`OUT https://example.com cors -> ${res.status}`); } catch (e) { r.push(`OUT https://example.com cors -> failed (${e && e.name})`); }
  return r;
}
