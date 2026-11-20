// LAB (a test, to be removed): can a page / a worker that comes from the app's own folder reach the exe? Run by the hub at its start when this folder is there;
// the answers are written to logs/lab_isolation.txt. Nothing here is part of the program; delete the folder app/lab/ when the test is done.
{
  const k = globalThis.__TAURI__ ? await globalThis.__TAURI__.core.invoke('fs_kind', { path: 'app/lab/RUN' }).catch(e => 'error: ' + e) : 'no __TAURI__';
  if (k !== 'file') { if (globalThis.__TAURI__ && k !== '') await globalThis.__TAURI__.core.invoke('fs_append', { path: 'logs/lab_isolation.txt', text: '(lab module loaded, app/lab/RUN is: "' + k + '")\n' }).catch(() => {}); throw new Error('lab off'); }
}
const out = [];
const ROUND = 41;
const say = t => out.push(t);
const T = globalThis.__TAURI__;
const kind = (await (T && T.core ? T.core.invoke('os_kind').catch(() => '?') : '?'));
say(`== lab isolation round ${ROUND} ${new Date().toISOString()}  os=${kind}  page=${location.href}`);
say(`page: typeof __TAURI__=${typeof T}, __TAURI_INTERNALS__=${typeof globalThis.__TAURI_INTERNALS__}`);

try { await T.core.invoke('fs_append', { path: 'logs/lab_isolation.txt', text: '(lab round 4b started ' + new Date().toISOString() + ')\n' }); } catch (e) { /* the end tells */ }
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

// 4. the plugin address: a sample plugin (plugins/lab-sample/) in a sandboxed frame, served by the exe with its own policy
const pluginUrl = (kind === 'macos' ? 'cmrplug://localhost/' : 'http://cmrplug.localhost/') + 'lab-sample/index.html';
const pluginFrame = () => new Promise(r => {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0';
  f.setAttribute('sandbox', 'allow-scripts');
  f.src = pluginUrl;
  const on = e => { if (e.source === f.contentWindow) { removeEventListener('message', on); f.remove(); r(e.data); } };
  addEventListener('message', on);
  document.body.append(f);
  setTimeout(() => { removeEventListener('message', on); f.remove(); r(['plugin frame: no answer in 60 s (the page did not load or did not finish) url=' + pluginUrl]); }, 60000);
});
// does the address exist at all (asked by the page itself, not from a frame)? and does the frame report that it loaded?
try { const x = await Promise.race([fetch(pluginUrl.replace('index.html', 'data.json')), wait(8000, null)]); say('page fetch of ' + pluginUrl.replace('index.html', 'data.json') + ' -> ' + (x ? x.status + ' ' + (await x.text()).slice(0, 50) : 'no answer in 8 s')); } catch (e) { say('page fetch of the plugin address -> failed (' + (e && e.name) + ': ' + (e && e.message) + ')'); }
{
  const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0'; f.setAttribute('sandbox', 'allow-scripts');
  let ev = 'no load event'; f.onload = () => { ev = 'load event came'; }; f.onerror = () => { ev = 'error event'; };
  f.src = pluginUrl.replace('index.html', 'data.json'); document.body.append(f); await wait(4000); f.remove(); say('frame on data.json (sandbox): ' + ev);
}
try { say('-- plugin sample in a sandboxed frame: ' + pluginUrl); for (const l of await pluginFrame()) say('   ' + l); } catch (e) { say('   error: ' + e); }
say('== end');
try { await T.core.invoke('fs_append', { path: 'logs/lab_isolation.txt', text: out.join('\n') + '\n\n' }); } catch (e) { console.log(out.join('\n')); }
