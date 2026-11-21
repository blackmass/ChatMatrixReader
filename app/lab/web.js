// LAB (a test, to be removed): the window of the web flickers on a Mac when the game is clicked. Runs once at the start when app/lab/RUN is there; writes logs/lab_web.txt.
const T = globalThis.__TAURI__;
if (!(T && await T.core.invoke('fs_kind', { path: 'app/lab/RUN' }).catch(() => '') === 'file')) throw new Error('lab off');
const invoke = T.core.invoke;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = text => invoke('fs_append', { path: 'logs/lab_web.txt', text: text + '\n' }).catch(() => {});
const stamp = () => String(Date.now() - t0).padStart(6, ' ') + ' ms';
const L = 'labweb';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const call = (name, args) => invoke(name, { label: L, ...args }).catch(e => log(`   ${name} FAILED: ${e}`));

await log(`== lab web flicker ${new Date().toISOString()}  os=${await invoke('os_kind').catch(() => '?')}`);
await sleep(6000);
await invoke('lab_web_open', { label: L, url: 'https://m.dcinside.com/', ua: MOBILE_UA, x: 200, y: 120, w: 360, h: 640 }).then(() => log('opened'), e => log('OPEN FAILED: ' + e));
await call('lab_web_z', { topmost: true, game: 0, owner: 0 });
let alive = true;
const ticker = setInterval(() => { if (alive) call('lab_web_tick', { game: 0 }); }, 100);
// every change of the state of the window is written with its time: a hide shows as visible=0 or a change of occlusion / alpha / level / space
let last = '';
const watcher = setInterval(async () => {
  if (!alive) return;
  const s = await invoke('lab_web_diag', { label: L }).catch(() => '');
  if (s && s !== last) { last = s; await log(`${stamp()}  ${s}`); }
}, 60);

const phases = [
  [0, 'PHASE 0 (nothing changed): click inside the GAME many times, hold W/A/S/D: does the window flicker?'],
  [1, 'PHASE 1: no show/hide animation'],
  [2, 'PHASE 2: the window is ordered to the front at every poll'],
  [4, 'PHASE 3: the system may not hide the window'],
  [7, 'PHASE 4: all of these together'],
];
for (const [v, text] of phases) {
  await call('lab_web_variant', { v });
  await log(`${stamp()}  >>> ${text}   (variant ${v}) for 20 s`);
  await sleep(20000);
  const gone = await invoke('lab_web_info', { label: L }).then(i => !i.exists).catch(() => true);
  if (gone) { await log('the window is gone'); break; }
}
alive = false; clearInterval(ticker); clearInterval(watcher);
await invoke('lab_web_close', { label: L }).catch(() => {});
await sleep(1500);
await log('== end (the program is alive)');
