// LAB (a test, to be removed): can a page / a worker that comes from the app's own folder reach the exe? Run by the hub at its start when this folder is there;
// the answers are written to logs/lab_isolation.txt. Nothing here is part of the program; delete the folder app/lab/ when the test is done.
if (!(globalThis.__TAURI__ && await globalThis.__TAURI__.core.invoke('fs_kind', { path: 'app/lab/RUN' }).catch(() => '') === 'file')) throw new Error('lab off');     // (only when the file app/lab/RUN is there)
const out = [];
const say = t => out.push(t);
const T = globalThis.__TAURI__;
const kind = (await (T && T.core ? T.core.invoke('os_kind').catch(() => '?') : '?'));
say(`== lab isolation ${new Date().toISOString()}  os=${kind}  page=${location.href}`);
say(`page: typeof __TAURI__=${typeof T}, __TAURI_INTERNALS__=${typeof globalThis.__TAURI_INTERNALS__}`);

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

for (const [name, fn] of [['worker', worker], ['frame sandbox (allow-scripts only)', () => frame(true, 'sandboxed')], ['frame plain (same origin)', () => frame(false, 'plain')]]) {
  try { say(`-- ${name}`); for (const l of await fn()) say('   ' + l); } catch (e) { say('   error: ' + e); }
}
say('== end');
try { await T.core.invoke('fs_append', { path: 'logs/lab_isolation.txt', text: out.join('\n') + '\n\n' }); } catch (e) { console.log(out.join('\n')); }
