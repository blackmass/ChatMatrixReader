// LAB (a test, to be removed): the window of the web flickers on a Mac when the game is clicked in "above the game only". Runs once at the start when app/lab/RUN is there; writes logs/lab_web.txt.
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
const game = await invoke('find_game', { known: null, title: 'World of Warcraft' }).catch(() => null);
if (!game) { await log('NO GAME WINDOW FOUND: start the game first (this test is about "above the game only")'); throw new Error('no game'); }
await log(`game window ${game.hwnd}`);
await call('lab_web_z', { topmost: false, game: game.hwnd, owner: 0 });
let alive = true, pollMs = 100, mode = 0;
(async () => { while (alive) { await call('lab_web_tick', { game: game.hwnd, mode }); await sleep(pollMs); } })();
// every change of the state of the window is written with its time: a hide shows as visible=0 or a change of occlusion / alpha / level / space
let last = '';
const watcher = setInterval(async () => {
  if (!alive) return;
  const s = await invoke('lab_web_diag', { label: L }).catch(() => '');
  if (s && s !== last) { last = s; await log(`${stamp()}  ${s}`); }
}, 60);

// all of these are "above the game only": click inside the GAME many times and hold W/A/S/D
const phases = [
  [0, 100, 0, 'PHASE 1 (the way it is now): put the window right above the game every 0.1 s'],
  [0, 30, 0, 'PHASE 2: the same every 0.03 s'],
  [0, 50, 1, 'PHASE 3: two states (the game in front: high level; another program in front: normal level right above the game)'],
  [5, 50, 1, 'PHASE 4: two states + no show/hide animation + the system may not hide the window'],
];
for (const [v, ms, m, text] of phases) {
  pollMs = ms; mode = m;
  await call('lab_web_variant', { v });
  await log(`${stamp()}  >>> ${text}   for 25 s`);
  await sleep(25000);
  const gone = await invoke('lab_web_info', { label: L }).then(i => !i.exists).catch(() => true);
  if (gone) { await log('the window is gone'); break; }
}
alive = false; clearInterval(watcher);
await invoke('lab_web_close', { label: L }).catch(() => {});
await sleep(1500);
await log('== end (the program is alive)');
