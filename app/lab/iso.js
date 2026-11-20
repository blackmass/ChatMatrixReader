// LAB (a test, to be removed): can a page / a worker that comes from the app's own folder reach the exe? Run by the hub at its start when this folder is there;
// the answers are written to logs/lab_isolation.txt. Nothing here is part of the program; delete the folder app/lab/ when the test is done.
{
  const k = globalThis.__TAURI__ ? await globalThis.__TAURI__.core.invoke('fs_kind', { path: 'app/lab/RUN' }).catch(e => 'error: ' + e) : 'no __TAURI__';
  if (k !== 'file') { if (globalThis.__TAURI__ && k !== '') await globalThis.__TAURI__.core.invoke('fs_append', { path: 'logs/lab_isolation.txt', text: '(lab module loaded, app/lab/RUN is: "' + k + '")\n' }).catch(() => {}); throw new Error('lab off'); }
}
const out = [];
const ROUND = 2;
const say = t => out.push(t);
const T = globalThis.__TAURI__;
const kind = (await (T && T.core ? T.core.invoke('os_kind').catch(() => '?') : '?'));
say(`== lab isolation round ${ROUND} ${new Date().toISOString()}  os=${kind}  page=${location.href}`);
say(`page: typeof __TAURI__=${typeof T}, __TAURI_INTERNALS__=${typeof globalThis.__TAURI_INTERNALS__}`);

try { await T.core.invoke('fs_append', { path: 'logs/lab_isolation.txt', text: '(lab round 2 started ' + new Date().toISOString() + ')\n' }); } catch (e) { /* the end tells */ }
const wait = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));

// 1. a worker from the app's folder
const worker = async () => {
  const w = new Worker(new URL('./iso_worker.js', import.meta.url));
  const res = await Promise.race([new Promise(r => { w.onmessage = e => r(e.data); w.onerror = e => r(['worker error: ' + (e.message || e)]); }), wait(8000, ['worker: no answer in 8 s'])]);
  w.terminate();
  return res;
};
// 2. frames: one with sandbox (no same-origin) and one plain
const frame = (sandbox, id) => new Promise(r => {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0';
  if (sandbox) f.setAttribute('sandbox', 'allow-scripts');
  f.src = new URL('./iso_frame.html?id=' + id, import.meta.url).href;
  const on = e => { if (e.source === f.contentWindow) { removeEventListener('message', on); f.remove(); r(e.data); } };
  addEventListener('message', on);
  document.body.append(f);
  setTimeout(() => { removeEventListener('message', on); f.remove(); r(['frame ' + id + ': no answer in 8 s']); }, 8000);
});

// 3. frames made from text (srcdoc, no files): the real calls of the exe (invoke), and a policy (CSP) that also holds a worker made inside
const SRCDOC = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'">
<script>
(async () => {
  const r = [];
  let viol = 0; addEventListener('securitypolicyviolation', () => viol++);
  const t = (name, fn) => Promise.resolve().then(fn).then(v => r.push(name + ' -> ' + v), e => r.push(name + ' -> blocked (' + (e && (e.name || e)) + ': ' + String(e && e.message || '').slice(0, 70) + ')'));
  r.push('typeof __TAURI__=' + typeof window.__TAURI__ + ', origin=' + String(location.origin));
  await t('invoke os_kind', () => window.__TAURI__.core.invoke('os_kind'));
  await t('invoke fs_kind app', () => window.__TAURI__.core.invoke('fs_kind', { path: 'app' }));
  await t('invoke fs_append logs/lab_should_not_exist.txt', () => window.__TAURI__.core.invoke('fs_append', { path: 'logs/lab_should_not_exist.txt', text: 'x' }));
  await t('event emit', () => window.__TAURI__.event.emit('lab-should-not-arrive', {}));
  await t('fetch no-cors example.com', async () => (await fetch('https://example.com/', { mode: 'no-cors' })).type);
  await t('fetch http://cmr.localhost/hub.js', async () => (await fetch('http://cmr.localhost/hub.js')).status);
  await t('sendBeacon', () => navigator.sendBeacon('https://example.com/', 'x'));
  await t('worker (blob) made in this frame', () => new Promise((res, rej) => {
    const code = "(async () => { const r = []; const t = async (n, f) => { try { r.push(n + ' -> ' + await f()); } catch (e) { r.push(n + ' -> blocked (' + (e && e.name) + ')'); } };" +
      "r.push('typeof __TAURI__=' + typeof self.__TAURI__);" +
      "await t('fetch no-cors', async () => (await fetch('https://example.com/', { mode: 'no-cors' })).type);" +
      "await t('WebSocket', () => new Promise((ok, no) => { try { const w = new WebSocket('wss://example.com/'); w.onerror = () => no({ name: 'error event' }); w.onopen = () => ok('OPENED'); setTimeout(() => ok('no answer'), 3000); } catch (e) { no(e); } }));" +
      "await t('importScripts', () => { importScripts('https://example.com/x.js'); return 'loaded'; });" +
      "postMessage(r); })();";
    const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    w.onmessage = e => res('\\n      ' + e.data.join('\\n      ')); w.onerror = e => rej(new Error('worker error ' + (e.message || ''))); setTimeout(() => rej(new Error('no answer in 6 s')), 6000);
  }));
  await t('parent.__TAURI__ (the page that made this frame)', () => typeof parent.__TAURI__);
  await t('parent.document.title', () => parent.document.title);
  r.push('security policy violations seen by this frame: ' + viol);
  parent.postMessage(r, '*');
})();
<\/script>`;
const srcdocFrame = sandbox => new Promise(r => {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0';
  if (sandbox) f.setAttribute('sandbox', 'allow-scripts');
  f.srcdoc = SRCDOC;
  const on = e => { if (e.source === f.contentWindow) { removeEventListener('message', on); f.remove(); r(e.data); } };
  addEventListener('message', on);
  document.body.append(f);
  setTimeout(() => { removeEventListener('message', on); f.remove(); r(['srcdoc frame: no answer in 20 s']); }, 20000);
});

for (const [name, fn] of [['srcdoc frame, sandbox allow-scripts, policy: nothing may go out', () => srcdocFrame(true)], ['srcdoc frame, NO sandbox (control: same origin as the app)', () => srcdocFrame(false)]]) {
  try { say(`-- ${name}`); for (const l of await fn()) say('   ' + l); } catch (e) { say('   error: ' + e); }
}
say('== end');
try { await T.core.invoke('fs_append', { path: 'logs/lab_isolation.txt', text: out.join('\n') + '\n\n' }); } catch (e) { console.log(out.join('\n')); }
