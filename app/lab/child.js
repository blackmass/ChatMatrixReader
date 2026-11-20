// LAB (a test, to be removed): a web view INSIDE the main window. Runs once at the start of the program when app/lab/RUN is there; writes logs/lab_child.txt.
// What to look at on the screen is told in the log and in the message of the person who sent this file.
const T = globalThis.__TAURI__;
if (!(T && await T.core.invoke('fs_kind', { path: 'app/lab/RUN' }).catch(() => '') === 'file')) throw new Error('lab off');
const invoke = T.core.invoke;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = text => invoke('fs_append', { path: 'logs/lab_child.txt', text: text + '\n' }).catch(() => {});
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const info = async tag => { try { const i = await invoke('lab_child_info'); await log(`[${tag}] ${JSON.stringify({ exists: i.exists, url: i.url, position: i.position, size: i.size })}`); return i; } catch (e) { await log(`[${tag}] info failed: ${e}`); return null; } };

await log(`== lab child web view ${new Date().toISOString()}  os=${await invoke('os_kind').catch(() => '?')}`);
await sleep(6000);                                           // (the main window is there by now)

async function show(url, secs, ua) {
  await log(`-- open ${url}  (ua ${ua ? 'phone' : 'default'}) for ${secs}s`);
  try { await log('opened: ' + await invoke('lab_child_open', { label: 'main', url, x: 10, y: 40, w: 320, h: 220, ua: ua || null })); }
  catch (e) { await log('OPEN FAILED: ' + e); return false; }
  for (let t = 0; t < secs; t += 5) { await sleep(5000); if (t === 5) await invoke('lab_child_set', { x: 40, y: 70, w: 340, h: 200 }).then(() => log('moved and resized to 340x200 at 40,70')).catch(e => log('set failed: ' + e)); await info('t+' + (t + 5)); }
  const last = await info('end');
  for (const line of (last && last.events) || []) await log('   event: ' + line);
  await invoke('lab_child_close').then(() => log('closed')).catch(e => log('close failed: ' + e));
  return true;
}
// 1. what User-Agent does the web view send? (the page shows it)
if (await show('https://httpbin.org/user-agent', 15, MOBILE_UA)) await sleep(1500);
// 2. a phone page of a community
await show('https://m.dcinside.com/', 60, MOBILE_UA);
await log('== end (while the web view was shown: did it follow when you moved the main window? did Options > always on top / click-through do what it should?)');
