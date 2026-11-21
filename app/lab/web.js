// LAB (a test, to be removed): a frameless window of the web with a bar of ours drawn into it. Runs once at the start of the program when app/lab/RUN is there; writes logs/lab_web.txt.
const T = globalThis.__TAURI__;
if (!(T && await T.core.invoke('fs_kind', { path: 'app/lab/RUN' }).catch(() => '') === 'file')) throw new Error('lab off');
const invoke = T.core.invoke;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = text => invoke('fs_append', { path: 'logs/lab_web.txt', text: text + '\n' }).catch(() => {});
const L = 'labweb';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const info = async tag => { try { const i = await invoke('lab_web_info', { label: L }); await log(`[${tag}] ${JSON.stringify({ exists: i.exists, url: i.url, position: i.position, size: i.size })}`); return i; } catch (e) { await log(`[${tag}] info failed: ${e}`); return null; } };
const call = async (name, args) => invoke(name, { label: L, ...args }).catch(e => log(`   ${name} FAILED: ${e}`));
const phase = async text => { await log(`>>> ${text}`); };

await log(`== lab web window ${new Date().toISOString()}  os=${await invoke('os_kind').catch(() => '?')}`);
await sleep(6000);
await log('open https://m.dcinside.com/ (a phone) at 200,120 size 360x640');
try { await invoke('lab_web_open', { label: L, url: 'https://m.dcinside.com/', ua: MOBILE_UA, x: 200, y: 120, w: 360, h: 640 }); await log('opened'); }
catch (e) { await log('OPEN FAILED: ' + e); throw e; }

let game = null, wowOnly = false;
// like a translation window: no activation from the start, and the style kept every poll; in "above the game only" the window is put right above the game over and over
await call('lab_web_noactivate', { on: true });
setInterval(() => { call('lab_web_tick', { game: wowOnly && game ? game.hwnd : 0 }); }, 300);
const steps = {
  5: async () => phase('(no-activate is ON all the time, like a translation window.) LOOK: is there a bar of ours at the top (title + x)? does the page look like a phone page? drag the bar: does the window move? resize at the edges? press x only at the end'),
  10: async () => { await phase('TOPMOST ON: the window must stay above other programs (click another program: it must not cover this window)'); await call('lab_web_z', { topmost: true, game: 0, owner: 0 }); },
  25: async () => { await phase('TOPMOST OFF: now another program may cover it'); await call('lab_web_z', { topmost: false, game: 0, owner: 0 }); },
  30: async () => {
    game = await invoke('find_game', { known: null, title: 'World of Warcraft' }).catch(() => null);
    if (!game) return phase('WOW-ONLY: no game window found: skipped');
    await phase(`WOW-ONLY (owner = the game ${game.hwnd}): it must stay right above the game and go behind a program that covers the game`);
    wowOnly = true;
    await call('lab_web_z', { topmost: false, game: game.hwnd, owner: game.hwnd });
  },
  50: async () => { wowOnly = false; await phase('TOPMOST ON again, no owner'); await call('lab_web_z', { topmost: true, game: 0, owner: 0 }); },
  55: async () => { await phase('CLICK-THROUGH ON: the mouse goes through the window to what is behind it (for 10 s)'); await call('lab_web_ignore', { on: true }); },
  65: async () => { await phase('CLICK-THROUGH OFF'); await call('lab_web_ignore', { on: false }); },
  70: async () => { await phase('KEYBOARD TEST (no-activate is on): click on the page, then type in the game (or another program): the keyboard must stay there; does the window hide when the game is in front? (for 20 s)'); },
  90: async () => { await phase('end of the keyboard test'); },
};
for (let t = 5; t <= 120; t += 5) {
  await sleep(5000);
  if (steps[t]) await steps[t]();
  const i = await info('t+' + t);
  if (i && !i.exists) { await log('the window is gone (closed by the x?)'); break; }
}
const last = await info('end');
for (const line of (last && last.events) || []) await log('   event: ' + line);
await invoke('lab_web_close', { label: L }).catch(() => {});
await log('== end');
