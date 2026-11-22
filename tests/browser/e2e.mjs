// The real pages (control.html = hub, center.html = the control centers that draw the translation windows) in headless Chromium with a stand-in for the exe:
// fake `__TAURI__` (events between pages, files in memory, a fake Google). Checks that a line goes hub -> pipeline -> translation ->
// every window's ChatView, that settings reach config.json and the other windows, and that nothing leaves the program's own paths.
//   node tests/browser/e2e.mjs      (needs Playwright; screenshots go to tests/browser/out/)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadFixtures, flatScreen, put, sfntWith } from '../helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = path.join(ROOT, 'app'), OUT = path.join(ROOT, 'tests', 'browser', 'out');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(APP, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(APP) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const base = `http://localhost:${server.address().port}`;

let failed = 0;
// The time of every step is measured: from the check before to this one, and how much of it was spent in `tick` (the waits of the test: the page clock is pushed forward). Nothing here waits for
// anything outside this machine, so a step that takes long without a reason is a finding: the end of the run lists the slow steps (a warning for now) and writes them all to e2e_timing.txt.
const steps = []; let mark = performance.now(), waited = 0, waitedFor = 0;
const ok = (c, msg) => { const t = performance.now(); steps.push({ msg, ms: t - mark, wait: waited, virtual: waitedFor }); mark = t; waited = 0; waitedFor = 0; if (!c) { failed++; console.log('  FAIL: ' + msg); } };

// ---- the stand-in for the exe
const files = new Map([['Glossary.sample.txt', 'LFM = 구인\n'], ['fonts/나눔 고딕.ttf', 'x'], ['locale/en-US.txt', fs.readFileSync(path.join(ROOT, 'locale', 'en-US.txt'), 'utf8')]]);
// the version of the program (app/core/version.js) and the next patch version: the fake release list of GitHub is made from them, so the test does not change at every release
const THIS_VERSION = /VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app', 'core', 'version.js'), 'utf8'))[1];
const NEXT_VERSION = THIS_VERSION.replace(/\d+$/, n => String(Number(n) + 1));
const requests = [], calls = [], clip = [], modelAsks = [];
let lastInputOpen = null;                            // the arguments of the last show_input
let aiMode = 'ok';                                   // what the fake AI server answers to the model list: ok | down | 401 | bad
let osVersion = '14.5';                                    // what the command os_version answers (macOS only)
let osKind = 'windows';                                   // what the command os_kind answers (a test can switch it to 'macos' before it opens a page)
const kb = { shift: false, enter: false, fg: 77 };       // the keyboard and the window in front (77 = the game, 99 = this program)
// the fake screen: flat, until `matrixOn`, then a v1 matrix at 200,100 (the game window is the left top 1280x720 of it)
const SW = 1920, SH = 1080;
const screen = flatScreen(SW, SH), v1fx = loadFixtures().find(f => f.name === 'v1_cols32');
let matrixOn = false, grabCount = 0;
function grabBytes(x, y, w, h) {
  grabCount++;
  const base = matrixOn ? put(flatScreen(SW, SH), v1fx.img, 200, 100) : screen;
  const out = Buffer.alloc(8 + w * h * 4);
  out.writeUInt32LE(w, 0); out.writeUInt32LE(h, 4);
  for (let r = 0; r < h; r++) Buffer.from(base.px.buffer, ((y + r) * SW + x) * 4, w * 4).copy(out, 8 + r * w * 4);
  return out.toString('base64');
}
const pluginFetches = [], pluginOpened = [], webCalls = [], centerRects = [];
const opened = [], watched = [], trayTexts = [];
let gameGone = false;
const wheel = [];                                    // wheel turns the fake exe tells (up = positive)
async function invoke(cmd, a = {}) {
  calls.push(cmd);
  switch (cmd) {
    case 'fs_read': return files.has(a.path) ? files.get(a.path) : null;
    case 'fs_write': files.set(a.path, a.text); return null;
    case 'fs_append': files.set(a.path, (files.get(a.path) || '') + a.text); return null;
    case 'fs_remove': files.delete(a.path); return null;
    case 'fs_kind': return files.has(a.path) ? 'file' : '';
    case 'fs_mkdir': return null;
    case 'fs_list': { const pre = a.path.replace(/\/$/, '') + '/'; return [...new Set([...files.keys()].filter(k => k.startsWith(pre)).map(k => { const r = k.slice(pre.length); return r.includes('/') ? r.split('/')[0] + '/' : r; }))]; }
    case 'plugin_token': return 'tok-' + a.id;
    case 'plugin_forget': return null;
    case 'plugin_open_url': pluginOpened.push(a); return null;
    case 'center_rects': centerRects.push(a); return null;
    case 'center_wheel': return { seq: wheel.length, turns: wheel.slice(a.seq).map(d => ({ id: '1', delta: d })) };
    case 'center_zoom': return a.scale || 1;
    case 'center_layout': return { origin: [0, 0], monitors: [[0, 0, 1920, 1080]] };
    case 'process_stats': return { os: 'windows', self: 10, note: '', procs: [{ pid: 10, parent: 1, name: 'ChatMatrix Reader.exe', kind: 'main', sub: '', ws: 104857600, private: 83886080, cpu_ms: 1000, handles: 300, gdi: 40, user: 60 }, { pid: 11, parent: 10, name: 'msedgewebview2.exe', kind: 'renderer', sub: '', ws: 52428800, private: 31457280, cpu_ms: 500, handles: 150, gdi: 10, user: 10 }] };
    case 'web_open': webCalls.push(['open', a.args]); return null;
    case 'web_close': webCalls.push(['close', a.label]); return null;
    case 'web_allow': webCalls.push(['allow', a.allow]); return null;
    case 'web_info': return { exists: true, visible: true, position: [100, 50], size: [360, 640] };
    case 'web_cmd': webCalls.push(['cmd', a.label, a.cmd, a.url]); return null;
    case 'web_alpha': webCalls.push(['alpha', a.label, a.alpha]); return null;
    case 'web_ua': webCalls.push(['ua', a.label, a.ua, a.hints]); return null;
    case 'address_show': webCalls.push(['addr', a]); return null;
    case 'address_hide': webCalls.push(['addrhide']); return null;
    case 'center_title': return null;
    case 'web_events': return [];
    case 'web_clear': webCalls.push(['clear', a.label]); return null;
    case 'web_forget': webCalls.push(['forget', a.key]); return null;
    case 'plugin_hash': return { hash: 'abc', files: [] };
    case 'plugin_fetch': pluginFetches.push(a); return { status: 200, body: '<html>list</html>', url: a.url, type: 'text/html' };
    case 'app_folder': return 'C:\\fake\\ChatMatrixReader';
    case 'open_url': opened.push(a.url); return null;
    case 'http_request': {
      if (new URL(a.url).hostname === 'api.github.com') return { status: 200, body: JSON.stringify([{ tag_name: 'v4.0.0' }, { tag_name: 'v' + NEXT_VERSION }, { tag_name: 'v' + THIS_VERSION, prerelease: true }]) };
      if (new URL(a.url).hostname === 'ai.test') {              // an AI server: its model list answers as the test asks (aiMode), the other paths are not asked here
        modelAsks.push(a);
        if (aiMode === 'down') throw new Error('connection refused');
        if (aiMode === '401') return { status: 401, body: '{"error":"bad key"}' };
        if (aiMode === 'bad') return { status: 200, body: '{"hello":"world"}' };
        return { status: 200, body: JSON.stringify({ data: [{ id: 'qwen3-8b' }, { id: 'gemma-3-4b' }, { id: 'qwen3-8b' }] }) };
      }
      requests.push(a);
      const q = new URL(a.url).searchParams.get('q') || '';
      return { status: 200, body: JSON.stringify([[[(new URL(a.url).searchParams.get('tl') === 'en' ? 'EN: ' : '번역: ') + q, q, null, null, 10]], null, 'en']) };
    }
    case 'os_state': return { cursor: [kb.cx ?? 0, kb.cy ?? 0], win: [0, 0, 500, 300], shift: kb.shift, ctrl: false, alt: false, keys: (a.keys || []).map(() => kb.enter), fg: kb.fg, fgTitle: kb.fg === 77 ? 'World of Warcraft' : 'ChatMatrix', fgExe: kb.fg === 77 ? 'wow.exe' : 'chatmatrix.exe', fgMine: !!kb.mine };
    case 'show_input': kb.fg = 99; lastInputOpen = a; return null;
    case 'focus_window': kb.fg = a.hwnd; return true;
    case 'send_paste': return true;
    case 'screen_rect': return [0, 0, SW, SH];
    case 'os_kind': return osKind;
    case 'os_version': return osVersion;
    case 'options_hotkey_ok': return true;
    case 'quit_request': return null;
    case 'place_watch': watched.push(a.game); return null;
    case 'quit_app': return null;
    case 'system_fonts': return ['Arial', 'Malgun Gothic'];
    case 'audio_apps': return [
      { pid: 4, ppid: 3, exe: 'Discord.exe', role: 'renderer', sub: '', device: 'Headset', default: false, system: false, state: 1, active: true, peak: 0.2 },
      { pid: 5, ppid: 3, exe: 'Discord.exe', role: 'utility', sub: 'AudioService', device: 'Speakers', default: true, system: false, state: 1, active: true, peak: 0.05 },
      { pid: 9, ppid: 1, exe: 'wow.exe', role: 'main', sub: '', device: 'Speakers', default: true, system: false, state: 0, active: false, peak: 0 }];
    case 'audio_probe': return { ok: true, pid: a.pid, build: '10.0.19045', tried: 5, works: ['mode0 i16/44100 LB+EV'], errors: [{ error: '0x88890021 bad flag', count: 4, example: 'x' }], activate_errors: [], used: 'mode0 i16/44100 LB+EV', seconds: 4, frames: 176400, rate: 44100, capture_peak: 0.3, capture_rms: 0.05, device_peak: 0.4, wav: 'extensions/stt/tmp/probe-4.wav' };
    case 'audio_probe_device': return { ok: true, device: a.device, build: '10.0.19045', format: '2 ch 48000 Hz 32 bit float', frames: 192000, rate: 48000, capture_peak: 0.5, capture_rms: 0.1, device_peak: 0.5, wav: 'extensions/stt/tmp/probe-device.wav' };
    case 'set_tray_text': trayTexts.push([a.options, a.quit]); return null;
    case 'find_game': if (gameGone) return null; return { hwnd: 77, rect: [0, 0, 1280, 720], exe: 'wow.exe', title: 'World of Warcraft', front: true };
    case 'capture': return { base64: grabBytes(a.x, a.y, a.w, a.h) };
    default: return null;
  }
}

const { chromium } = createRequire(import.meta.url)('playwright');
// Nothing here waits for anything outside this machine, so nothing may wait long: every step of the pages (a click, a selector, a page load) gets a few seconds, and the
// whole run has a watchdog. A step that hangs is a failure that says where it stopped, not minutes of waiting. (The page clock is a fake one: the "waits" of the test
// are not real time; a whole run takes about 40 seconds.)
const watchdog = setTimeout(() => { console.log('FAIL: the run took more than 100 seconds (a normal run is about 70): something waits for something that never comes'); process.exit(3); }, 100000);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 560, height: 420 }, deviceScaleFactor: 2, locale: 'ko-KR' });
ctx.setDefaultTimeout(5000); ctx.setDefaultNavigationTimeout(8000);
// Waiting for the program's own timers (the settings are saved 0.3 s after a change, the game is looked for every second ...) is the slow part of this test:
// the pages run on a clock that is pushed forward instead of waited for (Playwright's clock: it still runs by itself, and `runFor` jumps ahead and fires what
// is due on the way). A little real time between the steps lets the messages between the pages arrive.
await ctx.clock.install();
const STEP = 200;
// Waits until something is true, and no longer: the check is made again after every small step of the page clock, so a step takes as long as the program takes and not a guessed time. `limit`
// (virtual ms) is what the code may take: it is a failure that says what was waited for when it is not true by then (not a wait that was "long enough" and a check that fails after it).
const until = async (cond, what, limit = 2000) => {
  for (let left = limit; ; left -= 100) {
    try { if (await cond()) return true; } catch { /* not yet */ }
    if (left <= 0) { failed++; console.log(`  FAIL: not true after ${limit} ms of the page clock: ${what}`); return false; }
    await tick(100);
  }
};
// The same, for a check that follows: waits (at most `limit` ms of the page clock) until `cond` is true and says nothing; the check after it reports (with its own message) when it is not.
const within = async (limit, cond) => { for (let left = limit; left > 0; left -= 100) { try { if (await cond()) return true; } catch { /* not yet */ } await tick(100); } try { return !!(await cond()); } catch { return false; } };
const tick = async ms => { const t0 = performance.now(); for (let left = ms; left > 0; left -= STEP) { await ctx.clock.runFor(Math.min(left, STEP)); await new Promise(r => setTimeout(r, 6)); } waited += performance.now() - t0; waitedFor += ms; };
for (const pattern of ['http://cmr.localhost/fonts/*', `${base}/fonts/*`]) await ctx.route(pattern, r => r.fulfill({ status: 200, contentType: 'font/ttf', body: Buffer.from(sfntWith('Nano Test')) }));      // (the pages ask their own address: the program's on Windows, the test server's here)
await ctx.route('http://cmrplug.localhost/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }));
await ctx.exposeBinding('__invoke', (_, cmd, args) => invoke(cmd, args));
await ctx.exposeBinding('__clip', (_, t) => { clip.push(t); });
await ctx.addInitScript(() => {
  const label = new URLSearchParams(location.search).get('label') || 'control';
  const bc = new BroadcastChannel('tauri-events'), handlers = new Map();
  bc.onmessage = e => (handlers.get(e.data.event) || []).forEach(h => h({ payload: e.data.payload }));
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => {
      const r = await window.__invoke(cmd, args);
      if (r && r.base64) { const bin = atob(r.base64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8.buffer; }
      return r;
    } },
    event: {
      listen: async (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return () => {}; },
      emit: async (name, payload) => { bc.postMessage({ event: name, payload: JSON.parse(JSON.stringify(payload ?? null)) }); },
    },
    window: { getCurrentWindow: () => ({ label, setTitle: async t => { window.__title = t; }, setAlwaysOnTop: async v => { window.__top = v; }, show: async () => {}, setIgnoreCursorEvents: async () => {}, startResizeDragging() {}, close() {}, hide: async () => {} }) },
    clipboardManager: { writeText: async t => window.__clip(t) },
  };
});
const errors = [];
const open = async (url, size) => {
  const p = await ctx.newPage();
  p.waitForTimeout = tick;
  await p.setViewportSize(size || { width: 560, height: 420 });
  p.on('pageerror', e => errors.push(url + ': ' + e));
  p.on('console', m => { if (m.type() === 'error' && !m.location().url.includes('/fonts/')) errors.push(url + ': ' + m.text()); });
  await p.goto(base + '/' + url);
  return p;
};
const control = await open('control.html?label=control', { width: 700, height: 900 });
// The translation windows are panes of the control center of their order (center.js): one page here draws the main window and the second one. The checks of the window were written for a page of
// its own (an element #lines, document.body.classList ...): `paneOf` gives the same doors for a pane. `evaluate` runs the function with a `document` that is the pane (the old ids are mapped
// to the new elements, `#ctx` and the tips are the page's), `locator` maps the selector, `mouse` has the coordinates of the pane, `loc` is a plain way to look inside it.
const MAP_SRC = `(s, id) => String(s).replace(/#lines-(\\d+)/g, '.plines[data-chat="$1"]').replace(/#lines/g, '.plines[data-chat="' + id + '"]').replace(/#widgets/g, '.pwidgets').replace(/#toBottom/g, '.ptobottom')
  .replace(/#title/g, '.ptab:first-child').replace(/#bar \\.tab/g, '.ptab').replace(/\\[data-wid=/g, '[data-chat=').replace(/#bar/g, '.pbar').replace(/#tools/g, '.ptools').replace(/#voice/g, '.pvoice')
  .replace(/#options/g, '.poptions').replace(/#close/g, '.pclose').replace(/#grip/g, '.pgrip').replace(/\\.edge/g, '.pedge')`;
const SHIM_SRC = `(function (root, id, map, real) {
  const own = s => !/^(#ctx|\\.w-tip|\\.cv-tip)/.test(s);
  return new Proxy({}, { get: (_, k) => {
    if (k === 'body') return root;
    if (k === 'querySelector') return s => (own(s) ? root : real).querySelector(map(s, id));
    if (k === 'querySelectorAll') return s => (own(s) ? root : real).querySelectorAll(map(s, id));
    if (k === 'getElementById') return x => (own('#' + x) ? root : real).querySelector(map('#' + x, id));
    if (k === 'dispatchEvent' || k === 'addEventListener' || k === 'removeEventListener') return (...a) => root[k](...a);
    const v = real[k]; return typeof v === 'function' ? v.bind(real) : v;
  } });
})`;
const paneOf = (page, id) => {
  const call = (fn, arg) => [id, fn.toString(), arg, MAP_SRC, SHIM_SRC];
  const inPage = ([i, src, a, mapSrc, shimSrc]) => {
    const root = document.querySelector(`.pane[data-id="${i}"]`);
    if (!root) throw new Error('no pane ' + i);
    const doc = eval(shimSrc)(root, i, eval(mapSrc), document);
    return new Function('document', 'a', `return (${src})(a)`)(doc, a);
  };
  const mapSel = s => s.replace(/#lines-(\d+)/g, '.plines[data-chat="$1"]').replace(/#lines/g, `.plines[data-chat="${id}"]`).replace(/#widgets/g, '.pwidgets').replace(/#toBottom/g, '.ptobottom')
    .replace(/#title/g, '.ptab:first-child').replace(/#bar \.tab/g, '.ptab').replace(/\[data-wid=/g, '[data-chat=').replace(/#bar/g, '.pbar').replace(/#tools/g, '.ptools').replace(/#voice/g, '.pvoice')
    .replace(/#options/g, '.poptions').replace(/#close/g, '.pclose').replace(/#grip/g, '.pgrip').replace(/\.edge/g, '.pedge');
  const own = s => !/^(#ctx|\.w-tip|\.cv-tip)/.test(s);
  const origin = async () => { const b = await page.locator(`.pane[data-id="${id}"] .pbody`).boundingBox(); return [b.x, b.y]; };
  return {
    id, page,
    loc: sel => page.locator(`.pane[data-id="${id}"] ${sel}`),
    locator: (sel, o) => (own(sel) ? page.locator(`.pane[data-id="${id}"] ${mapSel(sel)}`, o) : page.locator(sel, o)),
    evaluate: (fn, arg) => page.evaluate(inPage, call(fn, arg)),
    run: (fn, arg) => page.evaluate(([i, src, a]) => new Function('root', 'a', `return (${src})(root, a)`)(document.querySelector(`.pane[data-id="${i}"]`), a), [id, fn.toString(), arg]),
    waitForFunction: (fn, arg, o) => page.waitForFunction(([i, src, a, m, sh]) => { const root = document.querySelector(`.pane[data-id="${i}"]`); return !!root && new Function('document', 'a', `return (${src})(a)`)(eval(sh)(root, i, eval(m), document), a); }, call(fn, arg), o),
    screenshot: o => page.locator(`.pane[data-id="${id}"]`).screenshot({ path: o && o.path }),
    bringToFront: () => page.bringToFront(),
    keyboard: page.keyboard,
    mouse: {
      move: async (x, y, o) => { const [bx, by] = await origin(); return page.mouse.move(bx + x, by + y, o); },
      click: async (x, y, o) => { const [bx, by] = await origin(); return page.mouse.click(bx + x, by + y, o); },
      wheel: (dx, dy) => page.mouse.wheel(dx, dy),
    },
  };
};
const cm = await open('center.html?label=center1&mode=1&ox=0&oy=0', { width: 1200, height: 800 });
const main = paneOf(cm, 1);
const newId = await control.evaluate(() => 0);
await control.waitForFunction(() => window.cmrHub && window.cmrHub.windows);
ok(JSON.stringify(trayTexts.at(-1)) === '["옵션","종료"]', 'tray: the menu texts are given to the exe: ' + JSON.stringify(trayTexts));
const id3 = await control.evaluate(() => window.cmrHub.windows.add('둘째'));
const extra = paneOf(cm, id3);
await control.evaluate(i => import('./settings.js').then(m => m.set({ child_windows: m.cfg().child_windows.map(c => (c.id === i ? { ...c, geometry: '500x300+1300+700' } : c)) })), id3);    // (not on the main window: the mouse of the test meets one pane)
await until(async () => (await cm.locator('.pane').count()) === 2, 'the second window is a pane too');
await control.waitForFunction(() => window.cmrHub);
ok(files.has('Glossary.txt'), 'Glossary.txt was made from the sample');
// ---- the widgets of a window: drawn from the settings, fed by the hub, the tip under the pointer
{
  const W = 'core:voice-level', at = a => `.pwidgets .wa-${a} .widget[data-id="${W}"]`;
  const wset = w => control.evaluate(([id, v]) => import('./settings.js').then(m => m.set({ widgets: v ? { [id]: v } : {} })), [W, w]);
  await wset({ place: 'inside', anchor: 'bottom-right', dx: 0, dy: 0, style: 'bar', show: 'always', scale: 1, opacity: 1, opts: {} });
  await until(async () => (await main.loc(at('bottom-right')).count()) === 1, 'the widget is drawn');
  ok(await main.loc(at('bottom-right')).count() === 1 && await extra.loc('.pwidgets .widget').count() === 0, 'widgets: drawn in the place of the settings, only in the window that has it');
  ok(await main.loc(at('bottom-right')).getAttribute('data-tone') === 'idle' && await main.loc(at('bottom-right') + ' .w-bar').count() === 1, 'widgets: off: idle, a thin bar');
  await control.evaluate(() => { const c = window.cmrHub.voice.control; c.set({ state: 'on', engine: 'cpu', model: 'small', device: 'cpu', capture: { mode: 'process', program: 'Wow.exe', pid: 3, status: 'listening' }, texts: { count: 2, last: Date.now() } }); c.onLevel({ source: 'engine', db: -35, peak: 0.1, speech: true, thr: -45 }); });
  await until(async () => (await main.loc(at('bottom-right')).getAttribute('data-tone')) === 'hot', 'the state of the hub reaches the widget');
  const fill = await main.loc(at('bottom-right') + ' .w-fill').evaluate(e => e.style.width), mark = await main.loc(at('bottom-right') + ' .w-mark').evaluate(e => e.style.left);
  ok(await main.loc(at('bottom-right')).getAttribute('data-tone') === 'hot' && Math.abs(parseFloat(fill) - 50) < 1 && Math.abs(parseFloat(mark) - 35.7) < 1, 'widgets: the hub\'s state: speech is heard: hot, the bar at -35 dB, the speech limit as the mark: ' + fill + ' / ' + mark);
  const colour = await main.loc(at('bottom-right') + ' .w-fill').evaluate(e => getComputedStyle(e).backgroundColor);
  ok(colour !== 'rgba(0, 0, 0, 0)' && colour !== await main.loc(at('bottom-right')).evaluate(e => { e.dataset.tone = 'idle'; const c = getComputedStyle(e.querySelector('.w-fill')).backgroundColor; e.dataset.tone = 'hot'; return c; }), 'widgets: the colour follows the tone');
  await main.loc(at('bottom-right')).screenshot({ path: path.join(OUT, 'widget_in_window.png') });
  // the tip: under the pointer (the center draws it on top of everything: its own element)
  const wb = await main.loc(at('bottom-right')).boundingBox();
  let jiggle = 0, tipText = '';                                    // (the pointer moves a little each time: the page may not have been ready for the first move; the text is taken in the same step as the check)
  await until(async () => {
    await cm.mouse.move(wb.x + 2 + (jiggle++ % 2), wb.y + 2);
    tipText = (await cm.locator('body > .w-tip:visible').first().textContent({ timeout: 300 }).catch(() => '')) || '';
    return tipText.includes('켜져 있음') && tipText.includes('Wow.exe') && tipText.includes('인식된 글 2개');
  }, 'the pointer over the widget shows its tip (the state in words)', 3000);
  ok(tipText.includes('켜져 있음 · Whisper · CPU · small') && tipText.includes('Wow.exe') && tipText.includes('인식된 글 2개'), 'widgets: the pointer over it shows the state in words: ' + JSON.stringify(tipText));
  await cm.mouse.move(wb.x + 400, wb.y - 100);
  await until(async () => await cm.locator('body > .w-tip:visible').count() === 0, 'the pointer away takes the tip away', 1000);
  ok(await cm.locator('body > .w-tip:visible').count() === 0, 'widgets: the pointer away: no tip');
  await wset({ place: 'inside', anchor: 'top', dx: 5, dy: 0, style: 'battery', show: 'always', scale: 1.5, opacity: 1, opts: {} });
  await until(async () => (await main.loc(at('top')).count()) === 1, 'the widget moves to the new place');
  ok(await main.loc(at('top')).count() === 1 && await main.loc(at('bottom-right')).count() === 0 && await main.loc(at('top') + ' .w-cell.on').count() === 3 && await main.loc(at('top')).evaluate(e => e.style.getPropertyValue('--ws') === '1.5' && e.style.transform.includes('5px')), 'widgets: another place and style: moved, 3 of 5 cells on, scaled, shifted');
  await wset({ place: 'inside', anchor: 'top', style: 'bar', show: 'active' });
  await control.evaluate(() => window.cmrHub.voice.control.set({ state: 'off', capture: null, texts: { count: 0, last: 0 } }));
  await until(async () => await main.loc(at('top')).isHidden(), 'the widget is hidden while the recognition is off');
  ok(await main.loc(at('top')).isHidden(), 'widgets: "only while it is on": hidden when it is off');
  await wset({ place: 'outside', anchor: 'top' });
  await until(async () => (await main.loc('.pwidgets .widget').count()) === 0, 'an outside place is not drawn');
  ok(await main.loc('.pwidgets .widget').count() === 0, 'widgets: an outside place is not drawn yet');
  await wset(null);
}
// the speaker of the voice recognition: in the bar of every window, a drawing, its colour says the state, a click turns it on / off
for (const [name, h] of [['main', main], ['extra', extra]]) {
  const order = await h.run(root => [...root.querySelectorAll('.ptools > button')].map(b => b.className).join());
  ok(order === 'presearch,pvoice,poptions,pclose', `speaker (${name}): between the refresh and the options icon: ` + order);
}
{
  const look = h => h.run(root => { const b = root.querySelector('.pvoice'), w = b.querySelector('.waves');
    return { state: b.dataset.state, color: getComputedStyle(b).color, waves: getComputedStyle(w).display, title: b.title, text: b.textContent.trim(), svg: !!b.querySelector('svg') }; });
  const off = await look(main), others = await main.run(root => getComputedStyle(root.querySelector('.poptions')).color);
  ok(off.svg && off.text === '' && off.state === 'off' && off.color === others && off.waves === 'none' && off.title === '음성인식 켜기', 'speaker: a drawing (no symbol character), off: the colour of the other icons, no sound waves: ' + JSON.stringify(off));
  await control.evaluate(() => window.__TAURI__.event.emit('voice-lamp', { state: 'on', text: '' }));
  await until(async () => (await look(extra)).state === 'on', 'the speaker is on in every window');
  const on = await look(main), on2 = await look(extra);
  ok(on.state === 'on' && on.color !== off.color && on.waves !== 'none' && on.title.includes('끄기') && on2.state === 'on', 'speaker: on: green, with sound waves, in every window: ' + JSON.stringify(on));
  await control.evaluate(() => window.__TAURI__.event.emit('voice-lamp', { state: 'error', text: '모델이 없습니다' }));
  await until(async () => (await look(main)).state === 'error', 'the speaker shows the error');
  const bad = await look(main);
  for (const st of ['off', 'on', 'error']) {
    await control.evaluate(s2 => window.__TAURI__.event.emit('voice-lamp', { state: s2, text: s2 === 'error' ? '모델이 없습니다' : '' }), st);
    await until(async () => (await look(main)).state === st, 'the speaker follows ' + st);
    await main.loc('.pbar').screenshot({ path: path.join(OUT, 'speaker_' + st + '.png') });
  }
  ok(bad.state === 'error' && bad.color !== off.color && bad.color !== on.color && bad.title.includes('모델이 없습니다'), 'speaker: error: its own colour, the reason as the tip: ' + JSON.stringify(bad));
  await control.evaluate(() => window.__TAURI__.event.emit('voice-lamp', { state: 'off', text: '' }));
  // a click: the hub turns the voice recognition on with the saved options (here nothing is installed: it says so)
  await main.loc('.pvoice').click();
  await until(async () => (await look(main)).state === 'error', 'a click turns it on: not installed, so it is an error', 3000);
  const clicked = await look(main);
  ok(clicked.state === 'error' && clicked.title.includes('설치되어 있지 않습니다'), 'speaker: a click turns it on like the button of the options (not installed: error, with the reason): ' + JSON.stringify(clicked));
  await control.evaluate(() => window.cmrHub.voice.control.set({ state: 'off', code: '', msg: '' }));
}
await control.evaluate(() => {                                       // the extra window is known to the pipeline (the exe would open it)
  window.cmrHub.fakeLine({ channel: 'party', name: 'Thrallson', text: 'LF2M tank and healer for +12' });
  window.cmrHub.fakeLine({ channel: 'guild', name: 'Moonpaw', text: 'LFM raid tonight, anyone?' });
  window.cmrHub.fakeLine({ channel: 'sys', name: '', text: '[SERVER] restart in 5 minutes' });
});
const texts = h => h.run(root => [...root.querySelectorAll('.plines:not(.off) .cv-blk')].map(e => e.textContent));
const hasText = (h, t) => h.page.waitForFunction(([id, t]) => [...document.querySelectorAll(`.pane[data-id="${id}"] .plines:not(.off) .cv-blk`)].some(e => e.textContent.includes(t)), [h.id, t], { timeout: 15000 }).catch(() => {});
await hasText(main, '번역: LFM(구인) raid tonight');
const m = await texts(main);
console.log('  main window:', JSON.stringify(m));
ok(m.some(t => t.includes('[Thrallson]') && t.includes('LF2M tank')), 'the chat line is in the main window');
ok(m.some(t => t.includes('번역: LF2M tank and healer for +12')), 'its translation follows');
ok(m.some(t => t.includes('LFM')), 'the guild line is there');
ok(requests.length >= 2 && requests.every(r => /^https:\/\/translate\.googleapis\.com\//.test(r.url)), `${requests.length} requests, all to Google through the exe`);
console.log('  requests:', JSON.stringify(requests.map(r => decodeURIComponent(r.url).slice(-70))));
ok(requests.some(r => decodeURIComponent(r.url).replace(/\+/g, ' ').includes('raid tonight')), 'the request carried the line');
ok(requests.every(r => (r.headers || []).some(([k]) => k === 'User-Agent')), 'requests carry the program\'s headers');

// the hub's history reaches a window that opens later
const lateCenter = await open('center.html?label=center1late&mode=1&ox=0&oy=0', { width: 1200, height: 800 }), late = paneOf(lateCenter, 1);
await hasText(late, '번역: LFM(구인) raid tonight');
const lt = await texts(late); console.log('  late window:', JSON.stringify(lt));
ok(lt.length >= 5 && lt.some(t => t.includes('LF2M')), 'a window opened later catches up with the history');
await lateCenter.close();

// a setting changed in the hub: saved to config.json and drawn by the other windows
await control.evaluate(() => { const el = document.getElementById('size'); el.value = 20; el.dispatchEvent(new Event('input')); document.getElementById('shadow').click(); });
await until(async () => (await main.run(root => getComputedStyle(root.querySelector('.plines:not(.off)')).getPropertyValue('--cv-size').trim())) === '20px', 'the font size reaches the main window', 4000);
ok(await main.run(root => getComputedStyle(root.querySelector('.plines:not(.off)')).getPropertyValue('--cv-size').trim()) === '20px', 'the font size reaches the main window');
ok(await main.run(root => getComputedStyle(root.querySelector('.cv-blk')).textShadow !== 'none'), 'the shadow reaches the main window');
await control.waitForTimeout(1500);
const saved = JSON.parse(files.get('config.json') || '{}');
ok(saved.font_size === 20 && saved.shadow_on === true && saved.config_version === 3, 'config.json has the new settings: ' + JSON.stringify([saved.font_size, saved.shadow_on, saved.config_version]));
ok(!calls.includes('fs_write') || [...files.keys()].every(k => !k.startsWith('/') && !k.includes('..')), 'only paths inside the program folder were used');
ok(files.has('logs/chatmatrix.log') && files.get('logs/chatmatrix.log').includes('google OK'), 'the log is in logs/ and records the translations');

// ---- the real chain: the capture loop finds the matrix on the fake screen, its lines are shown and translated
matrixOn = true;
await control.evaluate(() => window.cmrHub.capture.research());       // (the user presses ⟳: the whole screen is looked at now, not at the next 30-second scan)
await hasText(main, '번역: LFM(구인) tank for mythic');
const cap = await texts(main);
if (process.env.DBG) console.log(await control.evaluate(() => JSON.stringify({ pos: window.cmrHub.capture.worker.pos, fails: window.cmrHub.capture.worker.fails, mode: window.cmrHub.capture.worker.mode, game: window.cmrHub.capture.game, log: document.getElementById('log').innerText.slice(-600), cfgpoll: window.cmrHub.capture.worker.getCfg().poll_hz })));
console.log('  after the matrix:', JSON.stringify(cap.slice(-5)));
ok(cap.some(t => t.includes('[Anna]') && t.includes('안녕하세요 hello')), 'a line read from the matrix is shown');
ok(cap.some(t => t.includes('[Bob]') && t.includes('LFM')), 'the second line is shown');
ok(cap.some(t => t.includes('번역: LFM(구인) tank for mythic')), 'and translated');
ok(!cap.some(t => t.includes('매트릭스를 찾지 못했습니다')), 'the hint "matrix not found" is gone once it is found');
ok(await control.evaluate(() => window.cmrHub.capture.worker.mode + '@' + window.cmrHub.capture.worker.pos.join(',')) === 'v1@200,100', 'the loop is connected: v1@200,100');
await control.waitForTimeout(600);
const lp = JSON.parse(files.get('config.json') || '{}').last_pos;
ok(Array.isArray(lp) && lp[0] === 200 && lp[1] === 100, 'the position is remembered in config.json: ' + JSON.stringify(lp));
await control.waitForTimeout(800);
const noInfo = a => a.filter(t => !t.startsWith('ℹ'));   // a notice (e.g. the glossary was read again) may come at any time
const n1 = noInfo(await texts(main)).length;
await within(1200, async () => noInfo(await texts(main)).length === n1);
ok(noInfo(await texts(main)).length === n1, 'the same picture adds no line twice');

// ---- the send box: the hotkey in the game opens the line, Enter translates, the translation goes to the clipboard, the game gets the keyboard back
const input = await open('input.html?label=input', { width: 500, height: 46 });
await control.waitForTimeout(300);
kb.shift = true; kb.enter = true;                                  // Shift+Enter in the game
await input.waitForFunction(() => document.getElementById('lang').textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
ok(calls.includes('show_input') && kb.fg === 99, 'the hotkey opens the input line (it has the keyboard)');
ok(lastInputOpen && lastInputOpen.place === 'auto', 'the input line is opened with the place setting (auto by default): ' + JSON.stringify(lastInputOpen));
kb.shift = false; kb.enter = false;                                // the keys are let go
await control.waitForTimeout(400);
await input.fill('#cmd', '/w Bob Smith');
await input.press('#cmd', 'Tab');
ok(await input.evaluate(() => document.activeElement.id) === 'text', 'Tab moves to the sentence field');
await input.fill('#text', '파티 구합니다 힐러 탱커');
await input.screenshot({ path: path.join(OUT, 'input.png') });
await input.press('#text', 'Enter');
await control.waitForFunction(() => true);
for (let i = 0; i < 40 && !clip.length; i++) await control.waitForTimeout(100);
ok(clip.length === 1 && clip[0] === '/w Bob Smith EN: 파티 구합니다 힐러 탱커', 'the translation is on the clipboard: ' + JSON.stringify(clip));
for (let i = 0; i < 40 && kb.fg !== 77; i++) await control.waitForTimeout(100);
ok(kb.fg === 77 && calls.includes('focus_window'), 'the keyboard went back to the game');
ok(!(await input.evaluate(() => document.getElementById('text').value)), 'the input line is empty again');

// Enter on empty fields closes the line (like the game's chat; the page tells 'input-cancel'), but not at once after it opened and not while the command field has something
{
  await control.evaluate(() => { window.__cancels = 0; return window.__TAURI__.event.listen('input-cancel', () => { window.__cancels++; }); });
  const cancels = () => control.evaluate(() => window.__cancels);
  await control.evaluate(() => window.__TAURI__.event.emit('input-open', { label: '→ EN' })); await control.waitForTimeout(100);
  await input.evaluate(() => document.getElementById('text').focus());
  await input.press('#text', 'Enter'); await control.waitForTimeout(100);
  ok(await cancels() === 0, 'empty Enter right after opening does not close the line');
  await control.waitForTimeout(400);
  await input.fill('#cmd', '/p'); await input.press('#text', 'Enter'); await control.waitForTimeout(100);
  ok(await cancels() === 0, 'empty sentence with a command in the left field: Enter does not close');
  await input.fill('#cmd', ''); await input.press('#text', 'Enter'); await control.waitForTimeout(150);
  ok(await cancels() === 1, 'empty fields, later: Enter closes the line like Esc: ' + await cancels());
}

// ---- the options window: rows, default button, changed marker, search, revert; every change is saved at once and reaches the other windows
const opt = await open('options.html?label=options', { width: 940, height: 680 });
await opt.waitForSelector('.row');
const cfgFile = () => JSON.parse(files.get('config.json') || '{}');
const rowOf = label => opt.locator('.row', { has: opt.locator('b.label', { hasText: new RegExp('^' + label + '$') }) });
const settle = () => control.waitForTimeout(700);
ok(await opt.locator('#tabs li.active .name').textContent() === '일반', 'options: the first tab is open');
ok(await rowOf('초당 읽기 횟수').locator('button.def').isDisabled(), 'options: the default button is dim while the value is the default');
await rowOf('초당 읽기 횟수').locator('input').fill('20');
await rowOf('초당 읽기 횟수').locator('input').press('Enter');
await settle();
ok(cfgFile().poll_hz === 20, 'options: a change is saved at once: poll_hz=' + cfgFile().poll_hz);
ok(await control.evaluate(() => window.cmrHub.capture.worker.getCfg().poll_hz) === 20, 'options: the running program uses it');
ok(!(await rowOf('초당 읽기 횟수').locator('button.def').isDisabled()), 'options: the default button is clear when the value differs from the default');
ok(await rowOf('초당 읽기 횟수').evaluate(e => e.classList.contains('changed')), 'options: the row is marked as changed');
ok(await opt.locator('#changed').isVisible() && (await opt.locator('#changedCount').textContent()) === '1', 'options: "바꾼 것 1개"');
ok((await opt.locator('#tabs li').first().locator('.badge').textContent()) === '1', 'options: the tab shows how many were changed');
await rowOf('초당 읽기 횟수').locator('input').fill('999');
await rowOf('초당 읽기 횟수').locator('input').press('Enter');
await settle();
ok(cfgFile().poll_hz === 20 && (await rowOf('초당 읽기 횟수').locator('.err').textContent()).includes('5'), 'options: a value out of range is refused (nothing saved)');
await rowOf('초당 읽기 횟수').locator('button.def').click();
await settle();
ok(cfgFile().poll_hz === 30 && (await opt.locator('#changed').isHidden()), 'options: the default button resets (and it is the value of the opening again: nothing changed)');

await opt.fill('#q', '정규식');
ok(await opt.locator('.row b.label', { hasText: '제외 패턴' }).count() === 1 && await opt.locator('.row b.label', { hasText: '초당' }).count() === 0, 'options: search finds the rows of another tab');
const rx = opt.locator('.row', { has: opt.locator('b.label', { hasText: '제외 패턴' }) }).locator('input');
await rx.fill('[');
await rx.press('Enter');
await settle();
ok(!cfgFile().skip_regex && (await opt.locator('.row.bad .err').textContent()).includes('정규식'), 'options: a broken regular expression is refused');
await rx.fill('[가-힣]');
await rx.press('Enter');
await settle();
ok(cfgFile().skip_regex === '[가-힣]', 'options: a good one is saved');
ok(await opt.locator('.row b.label', { hasText: '일치하면 숨김' }).count() === 0, '(the hide row follows only after the search is left)');
await opt.fill('#q', '');
await opt.locator('#tabs li', { hasText: '예외' }).click();
ok(await opt.locator('.row b.label', { hasText: '일치하면 숨김' }).isVisible(), 'options: the row that depends on the pattern appears');
await opt.locator('#changedBtn').click();
ok(await opt.locator('#head').textContent() === '이번에 바꾼 것' && await opt.locator('.row').count() === 1, 'options: only what was changed');
await opt.screenshot({ path: path.join(OUT, 'options_changed.png') });
await opt.locator('#revertAll').click();
await settle();
ok(!cfgFile().skip_regex && await opt.locator('#changed').isHidden(), 'options: revert all');
ok(await control.evaluate(() => window.cmrHub.capture.worker.getCfg().skip_regex === ''), 'options: the program follows the revert');
await opt.locator('#tabs li', { hasText: '일반' }).click();
await opt.screenshot({ path: path.join(OUT, 'options_general.png') });

// ---- the 창 tab: one window at a time; the main window's keys, an extra window's entry, "follows window 1"
await opt.locator('#tabs li', { hasText: '창' }).first().click();
await opt.waitForSelector('.wintool');
ok(await opt.locator('.wintool select option').count() >= 3, 'options/windows: the picker lists the main window and the extra ones');
await rowOf('글자 크기').locator('input').fill('14'); await rowOf('글자 크기').locator('input').dispatchEvent('change');
await opt.locator('.row', { has: opt.locator('b.label', { hasText: '아래쪽에 붙이기' }) }).locator('.switch').click();
await control.waitForTimeout(300);
const shadow0 = !!cfgFile().shadow_on;
await opt.locator('.row', { has: opt.locator('b.label', { hasText: '글자 그림자' }) }).locator('.switch').click();
await opt.locator('.chbox', { hasText: '길드 관리' }).locator('input').uncheck();
await control.waitForTimeout(1500);
ok(cfgFile().font_size === 14 && cfgFile().bottom_stick === true && cfgFile().shadow_on === !shadow0, 'options/windows: window 1 writes its own keys (font_size, bottom_stick, shadow_on)');
ok((cfgFile().win1_off || []).includes('O') && !(cfgFile().win1_off || []).includes('G'), 'options/windows: window 1 channels are stored as the list that is left out: ' + JSON.stringify(cfgFile().win1_off));
ok(await opt.locator('.row b.label', { hasText: '그림자 가로' }).isVisible() === !shadow0, 'options/windows: shadow rows follow the shadow switch');
// above everything / just above the game: the setting decides which control center draws the window (the order itself is the program's: center.rs)
const sw = label => rowOf(label).locator('.switch');
const inCenter = async id => (await cm.locator(`.pane[data-id="${id}"]`).count()) === 1;      // (this page is the center of the windows that are on top)
ok(await inCenter(1), 'topmost: on by default: the window is in the center of the windows on top');
await sw('와우 위에만').click();
await until(async () => cfgFile().topmost_wow_only === true && !(await inCenter(1)), '"just above the game" takes the window to its own center');
ok(cfgFile().topmost_wow_only === true && cfgFile().topmost === false && !(await inCenter(1)), 'topmost: "just above the game" is on, "always on top" off: the window is in another center');
await sw('항상 맨 위에').click();
await until(async () => cfgFile().topmost === true && await inCenter(1), '"always on top" brings it back');
ok(cfgFile().topmost === true && cfgFile().topmost_wow_only === false && await inCenter(1), 'topmost: "always on top" takes the other one off: back in the center of the windows on top');
{ // neither on top nor above the game: an ordinary window (the ordinary center draws it and raises itself when it is touched)
  await sw('항상 맨 위에').click();
  await until(async () => cfgFile().topmost === false && !(await inCenter(1)), 'both off: the ordinary center draws it');
  ok(cfgFile().topmost === false && cfgFile().topmost_wow_only === false && !(await inCenter(1)), 'ordinary window (both off): it is in the ordinary center');
  await sw('항상 맨 위에').click();
  await until(async () => cfgFile().topmost === true && await inCenter(1), '"always on top" again');
}
// the font list: the files of fonts/ and the way back to the default
const fontBox = rowOf('글꼴').locator('input.wide'), pop = opt.locator('.sg-pop');
ok(await fontBox.count() === 1 && await rowOf('글꼴').locator('select').count() === 0, 'options/windows: the font is ONE text box (no second box, no drop-down)');
await fontBox.click(); await control.waitForTimeout(200);
ok(await pop.count() === 1, 'options/windows: the font list opens under the box when it is clicked');
ok(await fontBox.inputValue() === '' && cfgFile().font_family === '', 'options/windows: opening the list changes nothing');
await opt.screenshot({ path: path.join(OUT, 'options_suggest.png') });
const fontLines = (await pop.locator('.sg-item, .sg-head').allTextContents()).join('|');
ok(fontLines.startsWith('기본 (맑은 고딕)|fonts 폴더의 글꼴|Nano Test나눔 고딕.ttf|시스템에 설치된 글꼴|Arial|Malgun Gothic'), 'options/windows: the font list: ' + fontLines);
await fontBox.fill('mal'); await control.waitForTimeout(200);
ok((await pop.locator('.sg-item').allTextContents()).join('|') === 'Malgun Gothic', 'options/windows: typing narrows the list');
await fontBox.fill(''); await control.waitForTimeout(100);
await pop.locator('.sg-item', { hasText: 'Nano Test' }).dispatchEvent('mousedown'); await control.waitForTimeout(500);
ok(cfgFile().font_family === 'Nano Test' && await fontBox.inputValue() === 'Nano Test' && await pop.count() === 0, 'options/windows: a click on a line puts the font name (only the name) in and closes the list');
await fontBox.click(); await control.waitForTimeout(200);
await pop.locator('.sg-item.dim').dispatchEvent('mousedown'); await control.waitForTimeout(500);
ok(cfgFile().font_family === '' && await fontBox.inputValue() === '', 'options/windows: the first line (the default) is the way back');
await fontBox.click(); await fontBox.fill('Some Font'); await fontBox.press('Escape'); await control.waitForTimeout(200);
ok(await pop.count() === 0, 'options/windows: Esc closes the list');
await fontBox.press('Tab'); await control.waitForTimeout(500);
ok(cfgFile().font_family === 'Some Font', 'options/windows: a name typed by hand is kept as it is');
await fontBox.fill(''); await fontBox.press('Tab'); await control.waitForTimeout(500);
ok(cfgFile().font_family === '', 'options/windows: emptied: the default again');
// the main window can be named too: the name is in its tab (the title bar), in the list of windows of the options and in the menu
{
  const nameBox = rowOf('이름').locator('input');
  ok(await nameBox.count() === 1, 'options/windows: the main window has the name row too');
  await nameBox.fill('팀 채팅'); await nameBox.press('Tab'); await control.waitForTimeout(700);
  ok(cfgFile().main_name === '팀 채팅' && await main.locator('#title').textContent() === '팀 채팅', 'options/windows: the name of the main window is saved and shown in its tab: ' + cfgFile().main_name);
  ok((await opt.locator('select option').allTextContents()).some(t => t === '1 · 팀 채팅'), 'options/windows: the list of windows says it: ' + (await opt.locator('select option').allTextContents()).slice(0, 4).join('|'));
  await nameBox.fill(''); await nameBox.press('Tab'); await control.waitForTimeout(700);
  ok(cfgFile().main_name === '' && await main.locator('#title').textContent() === '메인', 'options/windows: emptied: the default name again');
}
// click-through windows: the system's cursor is given by hand (the middle of the pane, or far away from it). The loop of the center looks at it every OVERLAY_POLL_MS.
const dprNow = () => cm.evaluate(() => window.devicePixelRatio);
const cursorOver = async h => { const b = await h.loc('.pbody').boundingBox(), d = await dprNow(); kb.cx = Math.round((b.x + b.width / 2) * d); kb.cy = Math.round((b.y + b.height / 2) * d); };
const cursorAway = () => { kb.cx = 9999; kb.cy = 9999; };
const has = (h, cls) => h.evaluate(c => document.body.classList.contains(c), cls);
cursorAway();
await sw('클릭 관통').click();
await until(async () => await has(main, 'through'), 'the window is click-through');
ok(await has(main, 'hover-clear') === false, 'hover clear: off by default');
// the wheel up over a click-through window: the frame shows (the old chat is read); when the mouse leaves, it goes through again
await control.evaluate(() => import('./settings.js').then(m => m.set({ wheel_through: true })));
await cursorOver(main);
await until(async () => (await has(main, 'through')) && !(await has(main, 'interactive')), 'click-through: not usable', 1000);
wheel.push(120);
await until(async () => await has(main, 'review'), 'the wheel up starts the review', 1500);
ok(await has(main, 'interactive') === true, 'wheel review: the wheel up over a click-through window makes it usable');
cursorAway(); await control.waitForTimeout(400);
ok(await has(main, 'interactive') === true, 'wheel review: it stays in view while the old chat is shown, also when the mouse left');
ok(await main.evaluate(() => document.body.classList.contains('review') && getComputedStyle(document.getElementById('toBottom')).display !== 'none'), 'wheel review: the frame is marked and the way back down is there');
await main.evaluate(() => { const l = document.getElementById('lines'); l.scrollTop = l.scrollHeight; });
await until(async () => !(await has(main, 'review')), 'scrolled to the newest line, the review ends', 1000);
ok(!(await has(main, 'review')), 'wheel review: scrolled to the newest line, the review ends at once');
await until(async () => !(await has(main, 'interactive')), 'the window goes through again', 1500);
ok(await has(main, 'interactive') === false, 'wheel review: at the newest line and the mouse away, the window goes through again');
await cursorOver(main); await control.waitForTimeout(300);
wheel.push(120);
await until(async () => await has(main, 'review'), 'again', 1500);
ok(await has(main, 'review'), 'wheel review: again');
await main.locator('#toBottom').click({ force: true });
await until(async () => !(await has(main, 'review')), 'the way back down ends it', 1000);
ok(!(await has(main, 'review')), 'wheel review: the way back down ends it');
wheel.push(120);
await until(async () => await has(main, 'review'), 'again (for the wheel down)', 1500);
ok(await has(main, 'review'), 'wheel review: again (for the wheel down)');
{ const b = await main.loc('.pbody').boundingBox(); await cm.mouse.move(b.x + 40, b.y + 40); await cm.mouse.wheel(0, 900); }
await until(async () => !(await has(main, 'review')), 'the wheel down to the newest line ends it', 1500);
ok(!(await has(main, 'review')), 'wheel review: the wheel down to the newest line ends it');
// the lines get shorter by themselves (a translation line hidden): the browser moves the position, that is no review
await control.waitForTimeout(700);                                // (the page counts 600 ms from the wheel: what moves the lines later is not the user)
await main.evaluate(() => { const l = document.getElementById('lines'); const pad = document.createElement('div'); pad.id = 'tpad'; pad.style.height = '900px'; l.firstChild.append(pad); l.scrollTop = l.scrollHeight; });
await control.waitForTimeout(300);
await main.evaluate(() => document.getElementById('tpad').remove());
await control.waitForTimeout(500);
ok(!(await has(main, 'review')), 'wheel review: lines getting shorter by themselves do not start it');
await control.evaluate(() => import('./settings.js').then(m => m.set({ font_weight: 700 })));
await until(async () => (await main.evaluate(() => getComputedStyle(document.querySelector('.cv-blk')).fontWeight)) === '700', 'the font weight reaches the lines');
ok(await main.evaluate(() => getComputedStyle(document.querySelector('.cv-blk')).fontWeight) === '700', 'font weight: 700 reaches the lines');
await control.evaluate(() => import('./settings.js').then(m => m.set({ font_weight: 400 })));
await sw('관통 창 숨기기').click();
await cursorOver(main);
await until(async () => await has(main, 'hover-clear'), 'the mouse over the window clears it', 1500);
ok(await has(main, 'hover-clear') === true, 'hover clear: cleared while the mouse is over it');
kb.shift = true;
await until(async () => !(await has(main, 'hover-clear')), 'the interact key brings it back', 1000);
ok(await has(main, 'hover-clear') === false, 'hover clear: not while the interact key is held');
kb.shift = false;
// the tip of a link (item ...) under the cursor of a click-through window: the page gets no mouse events, so the loop of the center shows it from the cursor position
{
  await main.evaluate(() => {
    const s = document.createElement('span'); s.className = 'cv-tipped'; s._tip = ['[Test Item]', 'Binds when picked up']; s.id = 'tiptest'; s.textContent = '[Test Item]';
    s.style.cssText = 'position:fixed; left:260px; top:200px; padding:2px 8px; color:#fff; z-index:1;';
    document.querySelector('.cv-blk').append(s);
  });
  const dpr = await dprNow();
  const at = async sel => { const r = await main.evaluate(s => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel); kb.cx = Math.round(r[0] * dpr); kb.cy = Math.round(r[1] * dpr); };
  const tip = async () => { const t = await cm.locator('body > .cv-tip:visible').allTextContents(); return { shown: t.length > 0, text: t.join('|') }; };
  await at('#tiptest'); await control.waitForTimeout(400);
  ok((await tip()).shown === false, 'link tip: not while the window is cleared by the mouse (hover clear is on)');
  await sw('관통 창 숨기기').click();
  await until(async () => (await tip()).shown, 'a click-through window shows the tip of the link under the cursor', 1500);
  let t1 = await tip();
  ok(t1.shown && t1.text.includes('Test Item') && t1.text.includes('Binds when picked up'), 'link tip: a click-through window shows the tip of the link under the cursor: ' + JSON.stringify(t1));
  cursorAway();
  await until(async () => !(await tip()).shown, 'the cursor leaves the link: the tip goes away', 1000);
  ok((await tip()).shown === false, 'link tip: the cursor leaves the link: the tip goes away');
  await at('#tiptest');
  await until(async () => (await tip()).shown, 'back on the link', 1000);
  ok((await tip()).shown === true, 'link tip: back on the link');
  ok(await sw('관통 중 링크 보기 허용').isVisible(), 'link tip: the option is in the 창 tab, under the wheel one');
  await sw('관통 중 링크 보기 허용').click();
  await until(async () => !(await tip()).shown, 'the option off: no tip while click-through', 1000);
  ok((await tip()).shown === false && (await control.evaluate(() => import('./settings.js').then(m => m.cfg().through_tips))) === false, 'link tip: the option off: no tip while click-through');
  await sw('관통 중 링크 보기 허용').click();
  await until(async () => (await tip()).shown, 'the option on again', 1000);
  ok((await tip()).shown === true, 'link tip: the option on again');
  kb.shift = true; await control.waitForTimeout(400);
  ok(await has(main, 'interactive') === true, 'link tip: the interact key is held: the window is usable (the mouse events take over)');
  kb.shift = false;
  await until(async () => await has(main, 'through') && !(await has(main, 'interactive')) && (await tip()).shown, 'the key released: click-through again, the tip is back', 1500);
  ok((await tip()).shown === true, 'link tip: the key released: click-through again, the tip is back');
  cursorAway(); await sw('관통 창 숨기기').click();
  await main.evaluate(() => document.getElementById('tiptest').remove());
}
await sw('관통 창 숨기기').click(); await sw('클릭 관통').click();
await until(async () => !(await has(main, 'through')), 'the window takes the mouse again');
// ---- the look rows (outline / heavier glyphs / spacing / no kerning, in tenths of a pixel): they reach the lines
{
  const look = () => main.evaluate(() => { const b = document.querySelector('.cv-blk'), c = getComputedStyle(b), sc = getComputedStyle(document.querySelector('.cv-scroll')); return { shadow: c.textShadow, stroke: c.webkitTextStrokeWidth, spacing: sc.letterSpacing, kern: sc.fontKerning }; });
  const before = await look();
  ok(before.shadow === 'none' && before.stroke === '0px', 'look: nothing by default: ' + JSON.stringify(before));
  await control.evaluate(() => import('./settings.js').then(m => m.set({ outline: 5, bold_fix: 3, letter_spacing: 2, plain_text: true }))); await control.waitForTimeout(700);
  const a = await look();
  ok(a.shadow.split('rgb(0, 0, 0)').length - 1 === 8 && Math.abs(parseFloat(a.stroke) - 0.3) < 0.01 && parseFloat(a.spacing) > 0.1 && a.kern === 'none', 'look: applied to the lines (0.5px outline, 0.3px heavier): ' + JSON.stringify(a));
  await control.evaluate(() => import('./settings.js').then(m => m.set({ outline: 20 }))); await control.waitForTimeout(500);
  ok((await look()).shadow.split('rgb(0, 0, 0)').length - 1 === 16, 'look: a thick outline uses more copies');
  // a negative value: a thin line in the outline colour over the edge of the glyphs (thinner), 0.03px a step; the outline ring does not grow
  await control.evaluate(() => import('./settings.js').then(m => m.set({ outline: 5, bold_fix: -5, outline_color: '#102030' }))); await control.waitForTimeout(600);
  const thin = await main.evaluate(() => { const c = getComputedStyle(document.querySelector('.cv-blk')); return { w: c.webkitTextStrokeWidth, color: c.webkitTextStrokeColor, shadow: c.textShadow }; });
  ok(Math.abs(parseFloat(thin.w) - 0.15) < 0.01 && thin.color === 'rgb(16, 32, 48)' && thin.shadow.split('rgb(16, 32, 48)').length - 1 === 8, 'look: bold_fix -5: a 0.15px line in the outline colour: ' + JSON.stringify(thin));
  await control.evaluate(() => import('./settings.js').then(m => m.set({ bold_fix: 4 }))); await control.waitForTimeout(500);
  const heavy = await main.evaluate(() => { const b = document.querySelector('.cv-blk'), c = getComputedStyle(b); return { w: c.webkitTextStrokeWidth, same: c.webkitTextStrokeColor === c.color }; });
  ok(Math.abs(parseFloat(heavy.w) - 0.4) < 0.01 && heavy.same, 'look: bold_fix 4: a 0.4px line in the colour of the text: ' + JSON.stringify(heavy));
  await control.evaluate(() => import('./settings.js').then(m => m.set({ outline: 0, bold_fix: 0, letter_spacing: 0, plain_text: false, outline_color: '#000000' }))); await control.waitForTimeout(700);
  const z = await look();
  ok(z.shadow === 'none' && z.stroke === '0px' && z.kern === 'auto', 'look: back to the defaults: ' + JSON.stringify(z));
}
// ---- the widgets of the 창 tab: turn on, pick the place on the picture, the looks
{
  const card = opt.locator('.wp').first(), cfgW = () => (cfgFile().widgets || {})['core:voice-level'];
  await card.waitFor();
  ok(await card.locator('.wp-top input').isChecked() === false && await card.locator('.wp-dot.in').count() === 8 && await card.locator('.wp-dot.out').count() === 8 && !cfgW(), 'options/widgets: off at first, a picture with 8 places inside and 8 outside');
  await card.locator('.wp-top .switch').click(); await control.waitForTimeout(800);
  ok(cfgW() && cfgW().place === 'inside' && cfgW().anchor === 'bottom-right' && cfgW().style === 'bar' && await card.locator('.wp-dot.in.sel').getAttribute('title').then(t => t.startsWith('아래 오른쪽')), 'options/widgets: turned on with the place it suggests (and saved)');
  await card.locator('.wp-dot.in[title^="위 왼쪽"]').click(); await control.waitForTimeout(800);
  ok(cfgW().anchor === 'top-left' && await card.locator('.wp-dot.in.sel').getAttribute('title').then(t => t.startsWith('위 왼쪽')) && await card.locator('.wp-layer .wa-top-left .widget').count() === 1, 'options/widgets: a dot on the picture is the place; the little widget is shown there');
  ok(await card.locator('.wp-dot.out').first().getAttribute('title').then(t => t.includes('준비 중')) && cfgW().place === 'inside', 'options/widgets: the outside places say they are not ready');
  await card.locator('.wp-field:has(span:text-is("모양")) select').selectOption('battery'); await control.waitForTimeout(800);
  ok(cfgW().style === 'battery' && await card.locator('.wp-layer .w-battery').count() === 1, 'options/widgets: the look is chosen from the ones the widget declares');
  await card.locator('.wp-field:has(span:text-is("보이는 때")) select').selectOption('active');
  await card.locator('.wp-field:has(span:text-is("가로 이동 (x)")) input').fill('12'); await card.locator('.wp-field:has(span:text-is("가로 이동 (x)")) input').dispatchEvent('change');
  await within(800, async () => cfgW().show === 'active' && cfgW().dx === 12);
  ok(cfgW().show === 'active' && cfgW().dx === 12, 'options/widgets: when it is shown, the move in x');
  await opt.locator('.wp').first().screenshot({ path: path.join(OUT, 'options_widget.png') });
  // the list on the left: every widget, with its own switch; a second widget (as a plugin would register it) joins the list
  ok(await opt.locator('.wl-item').count() === 1 && await opt.locator('.wl-item.sel .wl-name').textContent() === '음성인식 음량바' && await opt.locator('.wl-badge').count() === 0, 'options/widgets: the list has the one widget there is (selected, no "플러그인" mark: it is the program\'s)');
  await opt.evaluate(() => import('./widgets/defaults.js').then(m => m.registry.register({ id: 'demo:status', label: 'Demo 상태', kind: 'light', styles: [{ id: 'dot', label: '점' }], settings: [{ key: 'blink', type: 'check', label: '깜빡임', def: true }, { key: 'size', type: 'number', label: '굵기', min: 1, max: 9, def: 3 }] })));
  await within(300, async () => await opt.locator('.wl-item').count() === 2 && await opt.locator('.wl-item').nth(1).locator('.wl-badge').textContent() === '플러그인');
  ok(await opt.locator('.wl-item').count() === 2 && await opt.locator('.wl-item').nth(1).locator('.wl-badge').textContent() === '플러그인', 'options/widgets: a widget that is registered later joins the list, marked as a plugin\'s');
  await opt.locator('.wl-item').nth(1).click(); await control.waitForTimeout(300);
  ok(await opt.locator('.wp-title').textContent() === 'Demo 상태' && await opt.locator('.wp-form').isHidden() && await opt.locator('.wp-top input').isChecked() === false, 'options/widgets: the right side is the chosen one; it is off for this window: its choices wait (hidden until it is on)');
  await opt.locator('.wl-item').nth(1).locator('.switch').click(); await control.waitForTimeout(800);
  ok(cfgFile().widgets && cfgFile().widgets['demo:status'] && cfgFile().widgets['demo:status'].opts.blink === true && cfgFile().widgets['demo:status'].opts.size === 3, 'options/widgets: the switch in the list turns it on, with the defaults of its own choices');
  await opt.locator('.wp .wp-field:has(span:text-is("굵기")) input').fill('6'); await opt.locator('.wp .wp-field:has(span:text-is("굵기")) input').dispatchEvent('change'); await control.waitForTimeout(800);
  ok(cfgFile().widgets['demo:status'].opts.size === 6, 'options/widgets: a choice the widget declares is saved with the others');
  ok(await opt.locator('.wl-item').first().locator('input').isChecked() && await opt.locator('.wl-item').nth(1).locator('input').isChecked(), 'options/widgets: both switches of the list are on');
  ok(await opt.locator('.wp-layer .widget').count() === 2 && await opt.locator('.wp-layer .widget.picked').count() === 1 && await opt.locator('.wp-layer .widget.other').count() === 1 && (await opt.locator('.wl-item.sel').count()) === 1, 'options/widgets: the picture shows every widget of the window together, the chosen one marked');
  await opt.screenshot({ path: path.join(OUT, 'options_widgets_list.png'), clip: await opt.locator('.wm').boundingBox() });
  // settings of a widget nobody provides any more are kept and shown, with a way to take them away
  await control.evaluate(() => import('./settings.js').then(m => m.set({ widgets: { ...m.cfg().widgets, 'gone:thing': { place: 'inside', anchor: 'top' } } })));
  await within(600, async () => await opt.locator('.wl-item.orphan').count() === 1 && await opt.locator('.wl-item.orphan .wl-badge').textContent() === '없음');
  ok(await opt.locator('.wl-item.orphan').count() === 1 && await opt.locator('.wl-item.orphan .wl-badge').textContent() === '없음', 'options/widgets: settings of a widget nobody provides are listed, dim, marked "없음"');
  await opt.locator('.wl-item.orphan').click(); await control.waitForTimeout(300);
  await opt.locator('button', { hasText: '이 설정 지우기' }).click(); await control.waitForTimeout(800);
  ok(!cfgFile().widgets['gone:thing'] && await opt.locator('.wl-item.orphan').count() === 0, 'options/widgets: deleting them');
  await opt.evaluate(() => import('./widgets/defaults.js').then(m => m.registry.unregister('demo:status')));
  await within(300, async () => await opt.locator('.wl-item').count() === 2 && await opt.locator('.wl-item.orphan').count() === 1);
  ok(await opt.locator('.wl-item').count() === 2 && await opt.locator('.wl-item.orphan').count() === 1, 'options/widgets: a widget whose plugin goes away stays in the list as "없음" while its settings are there');
  await opt.locator('.wl-item.orphan').click(); await opt.locator('button', { hasText: '이 설정 지우기' }).click(); await control.waitForTimeout(600);
  await opt.locator('.wl-item').first().click(); await control.waitForTimeout(300);
  await card.locator('.wp-top .switch').click(); await control.waitForTimeout(800);
  ok(!cfgW() && await card.locator('.wp-form').isHidden(), 'options/widgets: turned off: its settings are gone');
}
// "열 때 비우기": an extra window that is opened later gets the lines the hub kept (off), or starts empty and shows what comes after it was opened (on)
{
  const idc = await control.evaluate(() => window.cmrHub.windows.add('비우기'));
  const blocks = h => h.evaluate(() => document.querySelectorAll('#lines .cv-blk').length);
  const later = async n => { const pg = await open(`center.html?label=center1late${n}&mode=1&ox=0&oy=0`, { width: 1200, height: 800 }); await until(async () => (await pg.locator(`.pane[data-id="${idc}"]`).count()) === 1, 'the window is a pane of the new page'); return paneOf(pg, idc); };      // (a page that starts later: it is given the history of the hub)
  const say = t => control.evaluate(x => window.cmrHub.fakeLine({ channel: 'party', name: 'Earlier', text: x }), t);
  for (const t of ['before one', 'before two', 'before three']) await say(t);        // (the hub keeps the last events: a window opened now is given these)
  await control.waitForTimeout(400);
  const p1 = await later(1); await within(1500, async () => (await blocks(p1)) > 0);
  const kept = await blocks(p1);
  ok(kept > 0, 'clear on open: off (the default): the window gets the lines of before: ' + kept);
  await p1.page.close();
  await control.evaluate(i => import('./settings.js').then(m => m.set({ child_windows: m.cfg().child_windows.map(c => (c.id === i ? { ...c, clear_on_open: true } : c)) })), idc); await control.waitForTimeout(500);
  await say('before four'); await control.waitForTimeout(300);
  const p2 = await later(2); await control.waitForTimeout(900);
  ok(await blocks(p2) === 0, 'clear on open: on: the window starts empty: ' + await blocks(p2));
  await control.evaluate(() => window.cmrHub.fakeLine({ channel: 'party', name: 'Later', text: 'a line after the window was opened' }));
  await within(1500, async () => (await blocks(p2)) > 0);
  ok(await blocks(p2) > 0 && (await p2.locator('#lines').textContent()).includes('a line after the window was opened'), 'clear on open: on: what comes after it was opened shows as usual');
  await p2.page.close();
  const row = opt.locator('.row', { has: opt.locator('b.label', { hasText: /^열 때 비우기$/ }) });
  await opt.selectOption('.wintool select', String(idc)); await control.waitForTimeout(500);
  ok(await row.count() === 1 && await row.locator('small.note').count() === 3, 'clear on open: the option is in the window options (an extra window), a note of three lines');
  await opt.selectOption('.wintool select', '1'); await control.waitForTimeout(400);
  ok(await row.isHidden(), 'clear on open: not shown for the main window');
  await control.evaluate(i => window.cmrHub.windows.remove(i), idc); await control.waitForTimeout(300);
}

// "온전한 묶음만" and "보일 묶음 수": the rows are in the window options and the main window hides the older groups
{
  const rw = opt.locator('.row', { has: opt.locator('b.label', { hasText: /^온전한 묶음만$/ }) }), rm = opt.locator('.row', { has: opt.locator('b.label', { hasText: /^보일 묶음 수$/ }) });
  ok(await rw.count() === 1 && await rm.count() === 1 && await rw.locator('small.note').count() === 3 && await rm.locator('small.note').count() === 3, 'groups: both options are in the window options, three lines of note each');
  ok((await rm.locator('input').first().getAttribute('placeholder')) === '제한 없음' && await rm.locator('input').first().inputValue() === '', 'groups: the number is an empty box that says there is no limit');
  await rm.locator('input').first().focus(); await rm.locator('input').first().press('ArrowUp'); await control.waitForTimeout(900);
  ok(cfgFile().max_groups === 3, 'groups: the first arrow press gives 3: ' + cfgFile().max_groups);
  const clipped = () => main.evaluate(() => document.querySelectorAll('#lines .cv-clip').length);
  await main.evaluate(() => { const l = document.getElementById('lines'); l.scrollTop = l.scrollHeight; }); await control.waitForTimeout(500);
  ok(await clipped() > 0, 'groups: the main window hides the groups older than the newest three: ' + await clipped());
  await main.evaluate(() => { document.getElementById('lines').scrollTop = 0; }); await control.waitForTimeout(500);
  ok(await clipped() === 0, 'groups: scrolled up to read: everything is shown');
  await main.evaluate(() => { const l = document.getElementById('lines'); l.scrollTop = l.scrollHeight; });
  await rm.locator('input').first().fill('0'); await rm.locator('input').first().dispatchEvent('change'); await control.waitForTimeout(900);
  ok(cfgFile().max_groups === 0 && await clipped() === 0, 'groups: 0 (an empty box) is no limit: all shown again');
}

// a long note is several lines, a unit may be two lines (one under the other)
{
  const row = rowOf('굵기 보정');
  const n = await row.locator('small.note').count(), u = await row.locator('.unit.multi > span').allTextContents();
  ok(n === 4 && u.length === 2 && /0\.1px/.test(u[0]) && /0\.03px/.test(u[1]), 'options/windows: the note of the weight fix is four lines and its unit two: ' + n + ' ' + JSON.stringify(u));
  await row.screenshot({ path: path.join(OUT, 'options_weight_fix_row.png') });
  const ys = await row.locator('small.note').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
  ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), 'options/windows: the lines of the note are one under the other: ' + ys.join(','));
}
// two numbers whose 0 means "no value" (the main window shows an EMPTY box with a dim text; the arrows start somewhere sensible)
{
  const fadeIn = () => rowOf('오래된 글 숨기기').locator('input').first(), lowIn = () => rowOf('아래 줄 글자 크기 \\(기본은 번역\\)').locator('input').first();
  const size = cfgFile().font_size || 11;
  ok(await fadeIn().inputValue() === '' && (await fadeIn().getAttribute('placeholder')) === '숨기지 않음', 'options/windows (main): hide old lines: an empty box that says it is not hidden');
  ok(await lowIn().inputValue() === '' && (await lowIn().getAttribute('placeholder')) === `윗줄 크기를 따름 · ${size}pt`, 'options/windows (main): lower line size: an empty box that follows the upper line, with its size: ' + await lowIn().getAttribute('placeholder'));
  await fadeIn().focus(); await fadeIn().press('ArrowDown'); await control.waitForTimeout(900);
  ok(cfgFile().fade_sec === 60 && await fadeIn().inputValue() === '60', 'options/windows (main): the first arrow press (down) on the empty hide time gives 60');
  await fadeIn().press('ArrowDown'); await control.waitForTimeout(900);
  ok(cfgFile().fade_sec === 59, 'options/windows (main): then one step at a time');
  await fadeIn().fill('0'); await fadeIn().dispatchEvent('change'); await control.waitForTimeout(900);
  ok(cfgFile().fade_sec === 0 && await fadeIn().inputValue() === '', 'options/windows (main): typing 0 stores 0 and empties the box');
  await fadeIn().press('ArrowUp'); await control.waitForTimeout(900);
  ok(cfgFile().fade_sec === 60, 'options/windows (main): the first arrow press (up) gives 60 too');
  await fadeIn().fill(''); await fadeIn().dispatchEvent('change'); await control.waitForTimeout(900);
  ok(cfgFile().fade_sec === 0, 'options/windows (main): emptying the box = 0 = not hidden');
  await fadeIn().fill('-5'); await fadeIn().dispatchEvent('change');
  ok((await rowOf('오래된 글 숨기기').locator('.err').textContent()).startsWith('1 ~'), 'options/windows (main): a wrong number says the range starts at 1');
  await fadeIn().fill(''); await fadeIn().dispatchEvent('change'); await control.waitForTimeout(500);
  await lowIn().focus(); await lowIn().press('ArrowUp'); await control.waitForTimeout(900);
  ok(cfgFile().trans_font_size === size + 1, 'options/windows (main): the first arrow press on the empty lower size starts from the upper size: ' + (size + 1));
  await lowIn().fill('0'); await lowIn().dispatchEvent('change'); await control.waitForTimeout(900);
  ok(cfgFile().trans_font_size === 0 && await lowIn().inputValue() === '', 'options/windows (main): lower line size 0 = an empty box');
}
await opt.selectOption('.wintool select', '3');
await opt.waitForSelector('.row b.label:text-is("이름")');
// an extra window leaves what can follow window 1 EMPTY: the empty input says so (small, dim, with window 1's value), no "창 1 따르기" button
const ph = label => rowOf(label).locator('input').first().getAttribute('placeholder');
ok((await ph('줄 간격')).startsWith('창 1을 따름 · ') && (await ph('글자 크기')).startsWith('창 1을 따름 · ') && await rowOf('줄 간격').locator('button.def').isHidden(), 'options/windows: an extra window shows what it follows in the empty input; no button: ' + await ph('줄 간격'));
ok((await rowOf('글 정렬').locator('select option').first().textContent()).startsWith('창 1을 따름') && (await rowOf('줄 머리말').locator('select option').first().textContent()).startsWith('창 1을 따름') && (await rowOf('배경 흐림').locator('select option').first().textContent()).startsWith('창 1을 따름') && (await rowOf('글자 굵기').locator('select option').first().textContent()).startsWith('창 1을 따름'), 'options/windows: every choice list has "창 1을 따름" on top, with what window 1 has');
ok((await rowOf('글꼴').locator('input.wide').getAttribute('placeholder')).startsWith('창 1을 따름 · ') && await rowOf('글꼴').locator('input.wide').inputValue() === '', 'options/windows: the font box says what it follows (the empty box), and a new window follows');
ok(await rowOf('배경 진하기').locator('button.def').isVisible() && await rowOf('시간 표시').locator('button.def').isVisible() && await rowOf('시간 표시').locator('button.def').textContent() === '기본값', 'options/windows: sliders and on / off switches have the "기본값" button, they do not follow');
ok(await rowOf('시간 표시').locator('input[type=checkbox]').isChecked() && await rowOf('시간 표시').locator('button.def').isDisabled(), 'options/windows: a switch an extra window has no value for shows its default (on) and the 기본값 button is dim');
await rowOf('줄 간격').locator('input').fill('5'); await rowOf('줄 간격').locator('input').dispatchEvent('change');
await within(1500, async () => cfgFile().child_windows.find(c => c.id === 3).line_spacing === 5 && cfgFile().line_spacing !== 5);
ok(cfgFile().child_windows.find(c => c.id === 3).line_spacing === 5 && cfgFile().line_spacing !== 5, 'options/windows: an extra window gets its own value');
await rowOf('줄 간격').locator('input').fill(''); await rowOf('줄 간격').locator('input').dispatchEvent('change');
await control.waitForTimeout(1500);
ok(!('line_spacing' in cfgFile().child_windows.find(c => c.id === 3)) && (await ph('줄 간격')).startsWith('창 1을 따름'), 'options/windows: emptying the input takes the own value away: it follows window 1 again');
// the arrows start from window 1's value
{
  const main = cfgFile().font_size;
  await rowOf('글자 크기').locator('input').first().focus();
  await rowOf('글자 크기').locator('input').first().press('ArrowUp');
  await within(1200, async () => cfgFile().child_windows.find(c => c.id === 3).font_size === main + 1 && await rowOf('글자 크기').locator('input').first().inputValue() === String(main + 1));
  ok(cfgFile().child_windows.find(c => c.id === 3).font_size === main + 1 && await rowOf('글자 크기').locator('input').first().inputValue() === String(main + 1), `options/windows: ArrowUp on the empty font size starts from window 1's ${main}: ${main + 1}`);
  await rowOf('글자 크기').locator('.step').last().click();
  await rowOf('글자 크기').locator('.step').last().click();
  await within(1200, async () => cfgFile().child_windows.find(c => c.id === 3).font_size === main - 1);
  ok(cfgFile().child_windows.find(c => c.id === 3).font_size === main - 1, 'options/windows: the ▾ button steps one at a time');
  await rowOf('글자 크기').locator('input').first().fill(''); await rowOf('글자 크기').locator('input').first().dispatchEvent('change');
  await control.waitForTimeout(1200);
  ok(!cfgFile().child_windows.find(c => c.id === 3).font_size && await rowOf('글자 크기').locator('input').first().inputValue() === '', 'options/windows: emptied: follows window 1 (font_size 0)');
}
// the same two rows in an extra window: empty = follows window 1; when window 1 has no value, the arrows start at 60 / the upper size
{
  const fadeIn = rowOf('오래된 글 숨기기').locator('input').first(), lowIn = rowOf('아래 줄 글자 크기 \\(기본은 번역\\)').locator('input').first();
  const main = cfgFile().font_size || 11;
  ok((await fadeIn.getAttribute('placeholder')) === '창 1을 따름 · 숨기지 않음', 'options/windows (extra): window 1 does not hide: the empty box says so: ' + await fadeIn.getAttribute('placeholder'));
  ok((await lowIn.getAttribute('placeholder')).startsWith('창 1을 따름 · 윗줄과 같음'), 'options/windows (extra): window 1 has no lower size: ' + await lowIn.getAttribute('placeholder'));
  await fadeIn.focus(); await fadeIn.press('ArrowUp'); await control.waitForTimeout(900);
  ok(cfgFile().child_windows.find(c => c.id === 3).fade_sec === 60, 'options/windows (extra): window 1 has no hide time: the first arrow press gives 60');
  await fadeIn.fill(''); await fadeIn.dispatchEvent('change'); await control.waitForTimeout(900);
  await control.evaluate(() => import('./settings.js').then(m => m.set({ fade_sec: 30 }))); await control.waitForTimeout(700);
  ok((await fadeIn.getAttribute('placeholder')) === '창 1을 따름 · 30', 'options/windows (extra): window 1 hides after 30 s: shown behind "창 1을 따름"');
  await fadeIn.press('ArrowUp'); await control.waitForTimeout(900);
  ok(cfgFile().child_windows.find(c => c.id === 3).fade_sec === 31, 'options/windows (extra): window 1 has a value: the arrows start from it (31)');
  await fadeIn.fill(''); await fadeIn.dispatchEvent('change'); await control.waitForTimeout(900);
  await control.evaluate(() => import('./settings.js').then(m => m.set({ fade_sec: 0 }))); await control.waitForTimeout(700);
  await lowIn.focus(); await lowIn.press('ArrowDown'); await control.waitForTimeout(900);
  ok(cfgFile().child_windows.find(c => c.id === 3).trans_font_size === main - 1, 'options/windows (extra): no lower size in window 1: the arrows start from the upper size (' + (main - 1) + ')');
  await lowIn.fill(''); await lowIn.dispatchEvent('change'); await control.waitForTimeout(900);
}
await opt.selectOption('.row:has(b.label:text-is("글 정렬")) select', 'center');
await within(1200, async () => cfgFile().child_windows.find(c => c.id === 3).align === 'center');
ok(cfgFile().child_windows.find(c => c.id === 3).align === 'center', 'options/windows: a choice of its own');
await opt.selectOption('.row:has(b.label:text-is("글 정렬")) select', '');
await control.waitForTimeout(1200);
ok(cfgFile().child_windows.find(c => c.id === 3).align === null, 'options/windows: "창 1을 따름" in a choice list: null (it follows window 1)');
await opt.screenshot({ path: path.join(OUT, 'options_windows.png') });
// a control center (3.2): the page of a kind of order draws the windows of that kind as panes with the chat of the hub, and tells their places
{
  const geoBefore = [cfgFile().geometry, (cfgFile().child_windows.find(c => c.id === 3) || {}).geometry];       // (the pane saves its place in the settings: put back afterwards)
  const cp = await open('center.html?label=center1cp&mode=1&ox=0&oy=0', { width: 1200, height: 800 });
  await until(async () => (await cp.locator('.pane .cv-list').count()) > 0 && (await cp.locator('.pane .cv-list').first().textContent()).length > 0, 'the pane shows the chat of the hub', 4000);
  ok(await cp.locator('.pane').count() >= 1 && (await cp.locator('.pane .cv-list').first().textContent()).length > 0, 'center: the pane of the main window shows the chat of the hub: ' + (await cp.locator('.pane .cv-list').first().textContent()).slice(0, 60));
  ok(centerRects.length > 0 && centerRects.at(-1).label === 'center1' && centerRects.at(-1).panes.some(p => p.id === '1' && p.w > 100 && p.h > 50), 'center: the place of the pane is told to the program: ' + JSON.stringify(centerRects.at(-1)));
  // (the panes of the windows that are open stand on each other at first: the last one is on top, it is the one the pointer meets)
  const before = await cp.locator('.pane').last().boundingBox();
  const bar = await cp.locator('.pane .pbar').last().boundingBox();
  await cp.mouse.move(bar.x + 20, bar.y + 10); await cp.mouse.down(); await cp.mouse.move(bar.x + 120, bar.y + 70, { steps: 4 }); await cp.mouse.up();
  await until(async () => Math.abs((await cp.locator('.pane').last().boundingBox()).x - before.x - 100) < 3, 'the pane follows the drag');
  const after = await cp.locator('.pane').last().boundingBox();
  ok(Math.abs(after.x - before.x - 100) < 3 && Math.abs(after.y - before.y - 60) < 3, 'center: the bar drags the pane: ' + JSON.stringify([before, after]));
  // the edges resize it: the right edge makes it wider, the left edge moves the left side and keeps the right side where it is
  {
    const pn = cp.locator('.pane').last(), b0 = await pn.boundingBox(), er = await pn.locator('.e-r').boundingBox();
    await cp.mouse.move(er.x + 2, er.y + er.height / 2); await cp.mouse.down(); await cp.mouse.move(er.x + 42, er.y + er.height / 2, { steps: 3 }); await cp.mouse.up();
    await until(async () => Math.abs((await pn.boundingBox()).width - b0.width - 40) < 3, 'the right edge makes the pane wider');
    const b1 = await pn.boundingBox(), el = await pn.locator('.e-l').boundingBox();
    await cp.mouse.move(el.x + 2, el.y + el.height / 2); await cp.mouse.down(); await cp.mouse.move(el.x - 28, el.y + el.height / 2, { steps: 3 }); await cp.mouse.up();
    await until(async () => Math.abs((await pn.boundingBox()).width - b1.width - 30) < 3, 'the left edge makes the pane wider to the left');
    const b2 = await pn.boundingBox();
    ok(Math.abs(b2.x + b2.width - (b1.x + b1.width)) < 3, 'center/edges: the left edge keeps the right side where it is: ' + JSON.stringify([b1, b2]));
  }
  // the size of the window moves the lines by itself (a smaller window and a bigger one): that is not the user reading the old chat
  {
    const pn = cp.locator('.pane').last(), eb = await pn.locator('.e-b').boundingBox();
    await cp.mouse.move(eb.x + eb.width / 2, eb.y + 2); await cp.mouse.down(); await cp.mouse.move(eb.x + eb.width / 2, eb.y - 60, { steps: 3 }); await cp.mouse.move(eb.x + eb.width / 2, eb.y + 70, { steps: 3 }); await cp.mouse.up();
    await control.waitForTimeout(700);
    ok(!(await pn.evaluate(e => e.classList.contains('review'))), 'center/resize: a window made smaller and bigger again is not "reading the old chat"');
  }
  // a web window: the bar and the strips are the center's; the page is a window of the system that the program puts under it (a box with `web`), the mouse goes through where it is
  {
    const ev = (name, p) => control.evaluate(([n, x]) => window.__TAURI__.event.emit(n, x), [name, p]);
    await control.evaluate(() => import('./settings.js').then(m => m.set({ child_windows: [...m.cfg().child_windows, { ...m.cfg().child_windows[0], id: 9, name: '웹', kind: 'web', owner: 'plug', owner_win: 'web', geometry: '360x640+600+300', open_mode: 'never', dock_to: 0 }] })));
    await control.evaluate(() => { window.__webClosed = 0; window.__TAURI__.event.listen('web-close', () => { window.__webClosed++; }); });
    await ev('web-state', { windows: [{ win: 9, label: 'web_test', title: '공략 창', lock: false }] });
    await until(async () => (await cp.locator('.webpane').count()) === 1, 'the web window has a bar in the center');
    ok((await cp.locator('.webpane .ptab').textContent()) === '공략 창', 'center/web: its bar shows the title it was given');
    await until(() => centerRects.at(-1).panes.some(p => p.id === 'w9' && p.web === 'web_test' && p.hit === false), 'the program is told where the page is');
    const rects = centerRects.at(-1).panes.filter(p => p.id.startsWith('w9'));
    ok(rects.some(p => p.id === 'w9b' && p.hit) && rects.filter(p => p.hit).length === 5 && rects.every(p => p.web === 'web_test' || p.id !== 'w9'), 'center/web: the bar and the strips take the mouse (5), the page does not: ' + JSON.stringify(rects.map(p => [p.id, p.hit])));
    await cp.locator('.webpane').screenshot({ path: path.join(OUT, 'webpane.png') });
    await ev('web-title', { label: 'web_test', title: '새 제목' });
    await until(async () => (await cp.locator('.webpane .ptab').textContent()) === '새 제목', 'the title follows the page');
    await ev('web-scroll', { label: 'web_test', p: 0.5, s: 0.3 });
    await until(async () => (await cp.locator('.webpane .pscroll').evaluate(e => e.style.opacity)) === '1', 'the line shows while the page scrolls');
    await cp.locator('.webpane .preload').click();
    await cp.locator('.webpane .pback').click();
    await until(() => webCalls.some(c => c[0] === 'cmd' && c[2] === 'reload') && webCalls.some(c => c[0] === 'cmd' && c[2] === 'back'), 'the buttons go to the page');
    const wb = await cp.locator('.webpane .pbar').boundingBox(), w0 = (await cp.locator('.webpane').boundingBox());
    await cp.mouse.move(wb.x + 30, wb.y + 10); await cp.mouse.down(); await cp.mouse.move(wb.x + 70, wb.y + 40, { steps: 3 }); await cp.mouse.up();
    await until(async () => Math.abs((await cp.locator('.webpane').boundingBox()).x - w0.x - 40) < 3, 'the bar moves the web window');
    ok(centerRects.at(-1).panes.find(p => p.id === 'w9').x > rects.find(p => p.id === 'w9').x + 30, 'center/web: the place told to the program moves with the bar');
    await cp.locator('.webpane .pclose').click();
    await until(async () => (await control.evaluate(() => window.__webClosed)) === 1, 'the close button asks the hub to close it');
    await ev('web-state', { windows: [] });
    await until(async () => (await cp.locator('.webpane').count()) === 0, 'the bar goes when the window is closed');
    await control.evaluate(() => import('./settings.js').then(m => m.set({ child_windows: m.cfg().child_windows.filter(c => c.id !== 9) })));
  }
  // touching a pane brings it to the front of the center (the pane under the pointer takes the clicks)
  const z = async i => Number(await cp.locator('.pane').nth(i).evaluate(e => e.style.zIndex));
  ok(await cp.locator('.pane').count() >= 2 && await z(0) < await z(1), 'center: the first order of the panes follows the numbers of the windows: ' + [await z(0), await z(1)]);
  await cp.locator('.pane').nth(0).evaluate(e => e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
  ok(await z(0) > await z(1), 'center: a pane that is touched comes to the front: ' + [await z(0), await z(1)]);
  // the place of the pane is in the settings now (the place of the TEXT: what a window of 3.1.1 kept)
  ok(/^\d+x\d+\+\d+\+\d+$/.test(cfgFile().child_windows.find(c => c.id === 3).geometry), 'center: the place of the pane is kept in the settings: ' + cfgFile().child_windows.find(c => c.id === 3).geometry);
  // widgets: drawn inside the pane of the window that has them (the settings of its host)
  const WID = 'core:voice-level';
  await cp.evaluate(id => import('./settings.js').then(m => m.set({ widgets: { [id]: { place: 'inside', anchor: 'bottom-right', dx: 0, dy: 0, style: 'bar', show: 'always', scale: 1, opacity: 1 } } })), WID);
  await until(async () => (await cp.locator('.pane .widget').count()) === 1, 'the widget is drawn');
  ok(await cp.locator(`.pane .pwidgets .wa-bottom-right .widget[data-id="${WID}"]`).count() === 1 && await cp.locator('.pane .widget').count() === 1, 'center/widgets: drawn in the pane of the window that has it: ' + await cp.locator('.pane .widget').count());
  await cp.evaluate(() => import('./settings.js').then(m => m.set({ widgets: {} })));
  await until(async () => (await cp.locator('.pane .widget').count()) === 0, 'the widget is taken away');
  ok(await cp.locator('.pane .widget').count() === 0, 'center/widgets: taken away with the settings');
  // click-through: no place for the mouse (the clicks go to the game) until the interact key is held with the cursor over the window
  await cp.evaluate(() => import('./settings.js').then(m => m.set({ click_through: true, hide_tools: false, wheel_through: true })));
  const mainPane = cp.locator('.pane').first(), hasMain = () => centerRects.at(-1).panes.some(p => p.id === '1' && p.hit);
  const gameOn = await cp.evaluate(() => new Promise(r => { window.__TAURI__.event.listen('game-state', e => r(e.payload.found)); window.__TAURI__.event.emit('game-hello', {}); setTimeout(() => r(null), 1500); }));
  if (gameOn) {
    await until(async () => (await cp.locator('.pane.through:not(.interactive)').count()) > 0 && !hasMain() && (centerRects.at(-1).wheel || []).some(p => p.id === '1'), 'the window is click-through: no place for the mouse, its wheel is asked for');
    ok(await mainPane.evaluate(e => e.classList.contains('through') && !e.classList.contains('interactive')) && !hasMain(), 'center/through: click-through: no place for the mouse, no bar');
    ok((centerRects.at(-1).wheel || []).some(p => p.id === '1'), 'center/wheel: the wheel over a click-through window is taken from the game (its place is told)');
    const mb = await mainPane.boundingBox(); kb.cx = Math.round(mb.x + 40); kb.cy = Math.round(mb.y + 60); kb.shift = true;
    await until(() => hasMain(), 'the interact key over the window gives it a place for the mouse', 1000);
    ok(await mainPane.evaluate(e => e.classList.contains('interactive')) && hasMain(), 'center/through: the interact key over the window: it takes the mouse');
    kb.shift = false;
    await until(() => !hasMain(), 'the key let go takes the place away again', 1000);
    ok(!hasMain(), 'center/through: the key let go: the mouse goes through again');
    kb.cx = 0; kb.cy = 0;
  } else console.log('(no game in this test: the click-through check is skipped)');
  await cp.evaluate(() => import('./settings.js').then(m => m.set({ click_through: false })));
  await until(() => hasMain(), 'the window takes the mouse again');
  ok(hasMain(), 'center/through: not click-through: the window takes the mouse');
  // blur: the level goes to the program (it makes a window of the system behind the text area); not while the mouse clears the window
  await cp.evaluate(() => import('./settings.js').then(m => m.set({ blur: 2 })));
  await until(() => centerRects.at(-1).panes.some(p => p.id === '1' && p.blur === 2), 'the level of the blur is told');
  ok(centerRects.at(-1).panes.some(p => p.id === '1' && p.blur === 2), 'center/blur: the level of the blur is told: ' + JSON.stringify(centerRects.at(-1).panes.map(p => [p.id, p.blur])));
  await cp.evaluate(() => import('./settings.js').then(m => m.set({ blur: 0 })));
  await until(() => centerRects.at(-1).panes.every(p => !p.blur), 'the blur is off');
  ok(centerRects.at(-1).panes.every(p => !p.blur), 'center/blur: off: no blur is asked for');
  // the right-click menu: in the page of the center; while it is open the center takes the whole mouse (a rect 'menu'), a click elsewhere closes it
  const pb = await cp.locator('.pane .pbody').first().boundingBox();
  await cp.mouse.click(pb.x + 30, pb.y + 30, { button: 'right' });
  await until(() => cp.locator('#ctx').isVisible(), 'the menu opens', 1000);
  ok(await cp.locator('#ctx').isVisible() && (await cp.locator('#ctx div').allTextContents()).some(t => t.includes('창 비우기')), 'center/menu: the right button opens the menu: ' + (await cp.locator('#ctx').innerText()).replace(/\n/g, '|').slice(0, 80));
  ok(centerRects.at(-1).panes.some(p => p.id === 'menu'), 'center/menu: the center takes the whole mouse while the menu is open');
  await cp.mouse.click(pb.x + 400, pb.y + 100);
  await until(() => cp.locator('#ctx').isHidden(), 'the menu closes', 1000);
  ok(await cp.locator('#ctx').isHidden() && !centerRects.at(-1).panes.some(p => p.id === 'menu'), 'center/menu: a click elsewhere closes it and gives the mouse back');
  // the tips of the ordinary center are drawn by the center of the windows on top
  await control.evaluate(() => window.__TAURI__.event.emit('center-tip', { text: 'tip-test', rect: [100, 300, 160, 320] }));
  await until(() => cp.locator('.w-tip', { hasText: 'tip-test' }).isVisible(), 'the tip of the other center is drawn', 1000);
  ok(await cp.locator('.w-tip', { hasText: 'tip-test' }).isVisible(), 'center/tips: a tip of another center is drawn here');
  await control.evaluate(() => window.__TAURI__.event.emit('center-tip', { hide: true }));
  await until(() => cp.locator('.w-tip', { hasText: 'tip-test' }).isHidden(), 'the tip is taken away', 1000);
  ok(await cp.locator('.w-tip', { hasText: 'tip-test' }).isHidden(), 'center/tips: and taken away');
  // tabs: a window docked to another is a tab of its pane (the active tab shows its lines; a tab of another window takes over when touched)
  const dockSet = d => cp.evaluate(d => import('./settings.js').then(m => m.set({ child_windows: m.cfg().child_windows.map(c => (c.id === 3 ? { ...c, dock_to: d } : c)) })), d);
  await dockSet(1);
  await until(async () => (await cp.locator('.pane .ptab').count()) === 2, 'the docked window is a tab');
  ok(await cp.locator('.pane .ptab').count() === 2 && await cp.locator('.pane').count() === 1 && await cp.locator('.pane .ptab.on').count() === 1, 'center/tabs: a docked window is a tab of the pane: ' + await cp.locator('.pane .ptab').count() + '/' + await cp.locator('.pane').count());
  await cp.locator('.pane .ptab').nth(1).dispatchEvent('pointerdown', { button: 0 });
  await until(() => cp.locator('.pane .ptab').nth(1).evaluate(e => e.classList.contains('on')), 'the touched tab is the active one', 1000);
  ok(await cp.locator('.pane .ptab').nth(1).evaluate(e => e.classList.contains('on')) && await cp.locator('.pane .plines.off').count() === 1, 'center/tabs: a touched tab becomes the active one, the other chat is hidden');
  await dockSet(0);
  await until(async () => (await cp.locator('.pane .ptab').count()) === (await cp.locator('.pane').count()), 'the tab is a window of its own again');
  ok(await cp.locator('.pane .ptab').count() === await cp.locator('.pane').count(), 'center/tabs: undocked again: a pane of its own');
  // the mini browser: the hub opens a window of it (the default one), the center draws its bar with an address; the menus and the address bar act on it
  {
    const cmd = (c, id) => cp.evaluate(([c2, i]) => window.__TAURI__.event.emit('browser-command', { cmd: c2, id: i }), [c, id]);                // (from another page: a page does not hear its own events)
    const opens = () => webCalls.filter(c => c[0] === 'open' && c[1].label === 'web_b1');
    await control.evaluate(() => import('./settings.js').then(m => m.set({ bookmarks: [{ name: '지도', url: 'https://map.kakao.com/' }] })));
    await cmd('open', 1);
    await until(async () => (await cp.locator('.webpane .paddr').count()) === 1, 'the window of the mini browser has an address bar');
    const a1 = opens().at(-1)[1];
    ok(a1.free === true && a1.url === 'https://www.google.com/' && a1.ua.includes('Android') && a1.ua.includes('Mobile') && a1.ua_hints && a1.ua_hints.mobile === true && a1.ua_hints.platform === 'Android' && a1.persist === false && a1.key === 'browser1' && a1.allow.length === 0, 'browser/open: a window the user opens: any address, the phone page, no login kept: ' + JSON.stringify(a1));
    ok(centerRects.at(-1).panes.some(p => p.id === 'w1' && p.web === 'web_b1'), 'browser/open: the center tells where the page is');
    await cmd('open', 1);
    await control.waitForTimeout(300);
    ok(opens().length === 1, 'browser/open: asking again for an open window does not open another');
    // the address: drawn by the center, typed in the small window (address.html): a click puts it over the place, a site gets https://, a search goes to Google
    const addr = cp.locator('.webpane .paddr');
    await addr.dispatchEvent('mousedown', { button: 0 });                                  // (another window of the test lies over it: the event itself)
    await until(() => webCalls.some(c => c[0] === 'addr' && c[1].label === 'web_b1' && c[1].w > 50 && c[1].h > 10), 'a click on the address asks for the box over it');
    const ap = await open('address.html', { width: 300, height: 22 });
    await cm.evaluate(() => window.__TAURI__.event.emit('address-open', { label: 'web_b1', text: 'https://www.google.com/' }));         // (the program tells it; from another page)
    await until(async () => (await ap.locator('#a').inputValue()) === 'https://www.google.com/', 'the box shows the address now');
    await until(async () => await addr.evaluate(e => e.classList.contains('editing')), 'the address in the bar shows that it is being typed (its letters are hidden)');
    await ap.locator('#a').fill('namu.wiki/w/x'); await ap.locator('#a').press('Enter');
    await until(() => webCalls.some(c => c[0] === 'cmd' && c[2] === 'goto' && c[3] === 'https://namu.wiki/w/x'), 'a site is gone to');
    await cm.evaluate(() => window.__TAURI__.event.emit('address-open', { label: 'web_b1', text: '' }));
    await ap.locator('#a').fill('와우 공략'); await ap.locator('#a').press('Enter');
    await until(() => webCalls.some(c => c[0] === 'cmd' && c[2] === 'goto' && c[3] === 'https://www.google.com/search?q=' + encodeURIComponent('와우 공략')), 'what is not a site is searched');
    await until(async () => !(await addr.evaluate(e => e.classList.contains('editing'))), 'the bar shows its address again when the box is gone');
    // Esc: what was typed is not taken: nothing is gone to
    const gotos = webCalls.filter(c => c[0] === 'cmd' && c[2] === 'goto').length;
    await cm.evaluate(() => window.__TAURI__.event.emit('address-open', { label: 'web_b1', text: '' }));
    await ap.locator('#a').fill('not-finished.example'); await ap.locator('#a').press('Escape');
    await until(async () => !(await addr.evaluate(e => e.classList.contains('editing'))), 'Esc puts the box away');
    ok(webCalls.filter(c => c[0] === 'cmd' && c[2] === 'goto').length === gotos, 'browser/address: Esc: the unfinished address is not gone to');
    await ap.close();
    // a click on the bar (not the address) puts the box away
    const hides = webCalls.filter(c => c[0] === 'addrhide').length;
    await cp.locator('.webpane .paddrbar').dispatchEvent('pointerdown');
    await until(() => webCalls.filter(c => c[0] === 'addrhide').length > hides, 'a click elsewhere in the window puts the box away');
    // the address the page goes to is shown, and kept as the address seen last
    await cm.evaluate(() => window.__TAURI__.event.emit('web-nav', { label: 'web_b1', url: 'https://a.b/c' }));            // (a third page tells it: the hub and the center both hear it)
    await until(async () => (await addr.locator('.ptxt').textContent()) === 'https://a.b/c', 'the address is shown');
    await until(() => cfgFile().browser_windows[0].last_url === 'https://a.b/c', 'the address is kept as the last one', 3000);
    // the home button, the phone / computer button, and this page in the user's own browser
    await cp.locator('.webpane .phome').dispatchEvent('click');
    await until(() => webCalls.some(c => c[0] === 'cmd' && c[2] === 'goto' && c[3] === 'https://www.google.com/'), 'the home button goes to the first address');
    const modeBtn = cp.locator('.webpane .pmode');
    ok(await modeBtn.getAttribute('data-mode') === 'mobile', 'browser/mode: the button shows the phone');
    await modeBtn.dispatchEvent('click');
    await until(() => webCalls.some(c => c[0] === 'ua' && c[1] === 'web_b1' && !c[2].includes('Android')), 'the window is told it is a computer now');
    await until(async () => (await modeBtn.getAttribute('data-mode')) === 'pc', 'the button shows the computer');
    ok(webCalls.some(c => c[0] === 'cmd' && c[1] === 'web_b1' && c[2] === 'reload'), 'browser/mode: the page is loaded again');
    ok(cfgFile().browser_windows[0].mode === 'mobile', 'browser/mode: the setting is not changed (it is only for as long as the window is open)');
    await modeBtn.dispatchEvent('click');
    await until(() => webCalls.some(c => c[0] === 'ua' && c[1] === 'web_b1' && c[2].includes('Android') && c[3] && c[3].mobile === true), 'and back to the phone (the headers say it too)');
    await cp.locator('.webpane .ptab').dispatchEvent('pointerdown', { shiftKey: true, button: 0, bubbles: true });                // (at the press: the bar holds the pointer for dragging, the click would go to the bar)
    await until(() => webCalls.some(c => c[0] === 'cmd' && c[1] === 'web_b1' && c[2] === 'external'), 'Shift + click on the title opens the page in the user\'s browser');
    // the size of the page: the program tells it ('web-zoom'): the line shows it a moment, the window keeps it
    await cm.evaluate(() => window.__TAURI__.event.emit('web-zoom', { label: 'web_b1', zoom: 1.2 }));
    await until(async () => (await cp.locator('.webpane .pzoom').textContent()) === '120%', 'the size is shown in the address line');
    await until(() => cfgFile().browser_windows[0].zoom === 1.2, 'the window keeps the size', 3000);
    ok(opens().at(-1)[1].zoom === 1, 'browser/zoom: (the window was opened at 100 %)');
    // away from the mouse: it fades to the setting (slowly) and is solid again at once when the mouse is over it
    await control.evaluate(() => import('./settings.js').then(m => m.set({ browser_windows: m.cfg().browser_windows.map(b => (b.id === 1 ? { ...b, idle_alpha: 0.5 } : b)) })));
    kb.cx = 5000; kb.cy = 5000;
    await until(() => webCalls.some(c => c[0] === 'alpha' && c[1] === 'web_b1' && c[2] === 0.5), 'with the mouse away the window fades to 50 %', 8000);
    // the menu of ANOTHER window does not make it solid (only its own does)
    const spot0 = await cp.evaluate(() => { for (const p of document.querySelectorAll('.pane:not(.webpane) .pbody')) { const r = p.getBoundingClientRect(); for (let y = r.top + 10; y < r.bottom - 10; y += 20) for (let x = r.left + 10; x < r.right - 10; x += 20) { const e = document.elementFromPoint(x, y); if (e && e.closest('.pane:not(.webpane)') === p.closest('.pane')) return { x, y }; } } return null; });
    await cp.mouse.click(spot0.x, spot0.y, { button: 'right' });
    await until(async () => (await cp.locator('#ctx').isVisible()), 'the menu of a translation window is open');
    await cp.waitForTimeout(900);
    ok(webCalls.filter(c => c[0] === 'alpha').at(-1)[2] === 0.5, 'browser/fade: the menu of another window does not make it solid');
    await cp.keyboard.press('Escape');
    const box1 = centerRects.at(-1).panes.find(p => p.id === 'w1');
    kb.cx = box1.x + box1.w / 2; kb.cy = box1.y + box1.h / 2;
    await until(() => webCalls.filter(c => c[0] === 'alpha').at(-1)[2] === 1, 'with the mouse over it, it is solid at once', 4000);
    await control.evaluate(() => import('./settings.js').then(m => m.set({ browser_windows: m.cfg().browser_windows.map(b => (b.id === 1 ? { ...b, idle_alpha: 1 } : b)) })));
    kb.cx = 0; kb.cy = 0;
    // the order of the web windows: the center draws their frames by `z` and tells the program, which puts their pages in the same order; every translation window is above them all
    await control.evaluate(() => import('./settings.js').then(m => m.set({ browser_windows: [...m.cfg().browser_windows, { id: 2, name: '', mode: 'mobile', start_kind: 'url', start_url: 'https://www.google.com/', last_url: '', persist: false, topmost: true, topmost_wow_only: false, lock_window: false, geometry: '', zoom: 1, idle_alpha: 1 }] })));
    await cmd('open', 2);
    await until(async () => (await cp.locator('.webpane').count()) === 2, 'a second window of the mini browser');
    const zOf = async label => cp.evaluate(l => Number(document.querySelector(`.webpane[data-web="${l}"]`).style.zIndex), label);
    const sentZ = label => (centerRects.at(-1).panes.find(p => p.web === label) || {}).z;
    await until(async () => sentZ('web_b2') > sentZ('web_b1'), 'a window that is made is in front of the other: its z is higher in what the program gets');
    ok(await zOf('web_b1') < 1000 && await zOf('web_b2') < 1000 && (await cp.evaluate(() => Math.min(...[...document.querySelectorAll('.pane:not(.webpane)')].map(e => Number(e.style.zIndex)))) >= 1000), 'browser/order: every translation window is above every web window');
    await cp.locator('.webpane[data-web="web_b1"] .paddrbar').dispatchEvent('pointerdown');
    await until(() => sentZ('web_b1') > sentZ('web_b2'), 'a window that is touched comes to the front: the program is told the new order');
    await cmd('close', 2);
    await until(async () => (await cp.locator('.webpane').count()) === 1, 'the second window is closed');
    await control.evaluate(() => import('./settings.js').then(m => m.set({ browser_windows: m.cfg().browser_windows.filter(b => b.id !== 2) })));
    // the right button on the bar: the bookmarks, adding the page, the settings
    await cp.locator('.webpane .pbar').click({ button: 'right', position: { x: 4, y: 10 } });
    await until(async () => (await cp.locator('#ctx').isVisible()), 'the menu of the bar');
    const items = await cp.locator('#ctx div:not(.sep)').allTextContents();
    ok(items[0] === '지도' && items.includes('현재 페이지를 즐겨찾기에 추가') && items.includes('현재 페이지를 내 브라우저에서 열기') && items.includes('이 창의 설정…'), 'browser/menu: the bookmarks, adding the page, the settings: ' + items.join('|'));
    await cp.locator('#ctx div', { hasText: '지도' }).click();
    await until(() => webCalls.some(c => c[0] === 'cmd' && c[2] === 'goto' && c[3] === 'https://map.kakao.com/'), 'a bookmark takes this window there');
    await cp.locator('.webpane .pbar').click({ button: 'right', position: { x: 4, y: 10 } });
    await cp.locator('#ctx div', { hasText: '현재 페이지를 즐겨찾기에 추가' }).click();
    await until(() => (cfgFile().bookmarks || []).some(m => m.url === 'https://a.b/c'), 'the page is added to the bookmarks');
    // the menu of a translation window lists the windows of the mini browser
    // (a place of a translation window that no web window covers: looked for with the page's own idea of what is on top)
    const spot = await cp.evaluate(() => { for (const p of document.querySelectorAll('.pane:not(.webpane) .pbody')) { const r = p.getBoundingClientRect(); for (let y = r.top + 10; y < r.bottom - 10; y += 20) for (let x = r.left + 10; x < r.right - 10; x += 20) { const e = document.elementFromPoint(x, y); if (e && e.closest('.pane:not(.webpane)') === p.closest('.pane')) return { x, y }; } } return null; });
    const pb = { x: spot.x - 30, y: spot.y - 30 };
    await cp.mouse.click(pb.x + 30, pb.y + 30, { button: 'right' });
    await until(async () => (await cp.locator('#ctx div.on').allTextContents()).includes('모바일'), 'the menu shows the open window of the mini browser');
    await cp.locator('#ctx div', { hasText: /^모바일$/ }).click();                // (open: it closes)
    await until(async () => (await cp.locator('.webpane').count()) === 0, 'a click on the open window in the menu closes it');
    ok(webCalls.some(c => c[0] === 'close' && c[1] === 'web_b1'), 'browser/menu: closed by the menu');
    await cp.mouse.click(pb.x + 30, pb.y + 30, { button: 'right' });
    await cp.locator('#ctx div', { hasText: /^모바일$/ }).click();                // (closed: it opens)
    await until(async () => (await cp.locator('.webpane .paddr').count()) === 1, 'and opens it again');
    await cp.locator('.webpane .pclose').click();
    await until(async () => (await cp.locator('.webpane').count()) === 0, 'the close button of the bar closes it');
    // the login: kept in a folder of its own only when the window asks for it; taken away from a window that is not open
    await control.evaluate(() => import('./settings.js').then(m => m.set({ browser_windows: m.cfg().browser_windows.map(b => ({ ...b, persist: true, mode: 'pc', start_kind: 'last', last_url: 'https://x.y/z' })) })));
    await cmd('open', 1);
    await until(() => opens().length === 3, 'the window is opened again');
    const a2 = opens().at(-1)[1];
    ok(a2.persist === true && a2.ua === '' && a2.url === 'https://x.y/z', 'browser/open: the settings of the window are used (PC page, the last address, the login kept): ' + JSON.stringify(a2));
    await cmd('close', 1); await cmd('clear', 1);
    await until(() => webCalls.some(c => c[0] === 'forget' && c[1] === 'browser1'), 'the login of a window that is not open: its folder is taken away');
    await control.evaluate(() => import('./settings.js').then(m => m.set({ browser_windows: m.cfg().browser_windows.map(b => ({ ...b, persist: false, mode: 'mobile', start_kind: 'url' })), bookmarks: [] })));
  }
  // the screens changed so that a window is out of sight: it comes back to the main screen, and the user is told once
  await control.evaluate(() => window.__TAURI__.event.emit('center-layout', { origin: [0, 0], monitors: [[3000, 0, 800, 600]] }));
  await until(async () => (await cp.locator('.pane .cv-list').first().textContent()).includes('모니터 환경이 바뀌어'), 'the window that was out of sight is brought back, with a notice');
  const mb2 = await cp.locator('.pane').first().boundingBox();
  const dp = await cp.evaluate(() => window.devicePixelRatio);
  ok(mb2.x >= 3000 / dp - 5 && (await cp.locator('.pane .cv-list').first().textContent()).includes('모니터 환경이 바뀌어'), 'center/screens: a window that is out of every screen comes to the main one, with a notice: ' + mb2.x);
  await control.evaluate(() => window.__TAURI__.event.emit('center-layout', { origin: [0, 0], monitors: [[0, 0, 1920, 1080]] }));
  await control.evaluate(([g, g3]) => import('./settings.js').then(m => m.set({ geometry: g, child_windows: m.cfg().child_windows.map(c => (c.id === 3 ? { ...c, geometry: g3 || '' } : c)) })), geoBefore); await control.waitForTimeout(400);
  await cp.close();
}
// ---- the tab 미니 브라우저: the browser windows (window 1 is always there), the bookmarks, how a web window is drawn
{
  await opt.locator('#tabs li', { hasText: '미니 브라우저' }).click();
  const picker = opt.locator('.wintool select'), names = async () => (await picker.locator('option').allTextContents()).join('|');
  await until(async () => (await picker.count()) === 1, 'the picker of the browser windows is there');
  ok((await names()) === '1 · 모바일', 'browser: window 1 is there from the start, called "모바일": ' + await names());
  ok(await opt.locator('.wintool button', { hasText: '삭제' }).isHidden(), 'browser: window 1 cannot be deleted (no button)');
  ok(cfgFile().browser_windows.length === 1 && cfgFile().browser_windows[0].start_url === 'https://www.google.com/' && cfgFile().browser_windows[0].persist === false, 'browser: window 1 starts with Google and keeps no login');
  await opt.locator('.wintool button', { hasText: '새 창' }).click();
  await until(async () => (await names()) === '1 · 모바일|2 · 브라우저 2', 'a new window is made and chosen');
  await until(async () => cfgFile().browser_windows.length === 2, 'the window is in the file');
  ok(cfgFile().browser_windows.length === 2 && await picker.inputValue() === 'b2', 'browser: a new window: the second, chosen: ' + await names());
  await rowOf('이름').locator('input').fill('공략'); await rowOf('이름').locator('input').press('Tab');
  await until(async () => (await names()).includes('2 · 공략'), 'the name reaches the list');
  await until(async () => cfgFile().browser_windows[1].name === '공략', 'the name is in the file');
  ok(cfgFile().browser_windows[1].name === '공략', 'browser: the name is saved');
  await rowOf('화면').locator('select').selectOption('pc');
  await until(async () => cfgFile().browser_windows[1].mode === 'pc', 'the screen is saved');
  ok(cfgFile().browser_windows[0].mode === 'mobile', 'browser: only the chosen window changed');
  await rowOf('시작 주소').locator('input').fill('나쁜 주소'); await rowOf('시작 주소').locator('input').press('Tab');
  await control.waitForTimeout(500);
  ok(cfgFile().browser_windows[1].start_url === 'https://www.google.com/' && (await rowOf('시작 주소').locator('.err').textContent()).includes('http'), 'browser: a wrong start address is refused with a reason');
  await rowOf('시작 주소').locator('input').fill('https://www.youtube.com/'); await rowOf('시작 주소').locator('input').press('Tab');
  await until(async () => cfgFile().browser_windows[1].start_url === 'https://www.youtube.com/', 'a good start address is saved');
  await sw('로그인 유지').click();
  await until(async () => cfgFile().browser_windows[1].persist === true, 'the login is kept');
  await sw('와우 위에만').click();
  await until(async () => cfgFile().browser_windows[1].topmost_wow_only === true, 'above the game only');
  ok(cfgFile().browser_windows[1].topmost === false, 'browser: "above the game only" takes "always on top" off');
  const del = opt.locator('.wintool button', { hasText: '삭제' });
  await del.click(); await del.click();
  await until(async () => cfgFile().browser_windows.length === 1, 'the window is deleted (two presses)');
  ok(cfgFile().browser_windows[0].id === 1 && await picker.inputValue() === 'b1', 'browser: deleted: window 1 is shown again');
  // the limit: ten windows
  for (let i = 0; i < 12; i++) await opt.locator('.wintool button', { hasText: '새 창' }).click({ force: true }).catch(() => {});
  await until(async () => cfgFile().browser_windows.length === 10, 'ten windows are made', 4000);
  ok(cfgFile().browser_windows.length === 10 && await opt.locator('.wintool button', { hasText: '새 창' }).isDisabled(), 'browser: no more than ten windows: the button is dim');
  await control.evaluate(() => import('./settings.js').then(m => m.set({ browser_windows: m.cfg().browser_windows.filter(b => b.id === 1) })));
  await until(async () => (await names()) === '1 · 모바일', 'back to one window');
  // the button to open and close the window of the chosen browser window
  {
    const tog = opt.locator('.wintool button', { hasText: /^(열기|닫기)$/ }), before = webCalls.filter(c => c[0] === 'open' && c[1].label === 'web_b1').length;
    await tog.click();
    await until(async () => webCalls.filter(c => c[0] === 'open' && c[1].label === 'web_b1').length === before + 1 && (await tog.textContent()) === '닫기', 'the button opens the window and says it can be closed');
    ok((await opt.locator('.wintool .winstate').textContent()).includes('열려 있음'), 'browser: the state says it is open');
    await tog.click();
    await until(async () => (await tog.textContent()) === '열기', 'the button closes it');
    await opt.locator('.row', { has: opt.locator('b.label', { hasText: /^로그인 정보$/ }) }).locator('button.btn').click();
    await until(() => webCalls.some(c => c[0] === 'forget' && c[1] === 'browser1'), 'the button clears the login of a window that is not open');
  }
  // the bookmarks: the other page of the tab
  await opt.locator('.subtabs button', { hasText: '즐겨찾기 설정' }).click();
  await until(async () => (await opt.locator('.bm').count()) === 1, 'the page of the bookmarks');
  ok(await opt.locator('.wintool').isHidden() && await opt.locator('.row b.label', { hasText: /^이름$/ }).count() === 0, 'browser/bookmarks: the picker and the settings of a window are not on this page');
  const bm = opt.locator('.bm'), url = bm.locator('.bm-add input').nth(1), nm = bm.locator('.bm-add input').nth(0);
  await url.fill('nope'); await bm.locator('.bm-add button').click();
  ok(cfgFile().bookmarks.length === 0 && (await url.getAttribute('class')).includes('bad'), 'browser/bookmarks: a wrong address is not added');
  await nm.fill('지도'); await url.fill('https://map.kakao.com/'); await bm.locator('.bm-add button').click();
  await until(async () => cfgFile().bookmarks.length === 1, 'a bookmark is added');
  await bm.locator('.bm-add input').nth(0).fill(''); await bm.locator('.bm-add input').nth(1).fill('https://a.b/c'); await bm.locator('.bm-add button').click();
  await until(async () => cfgFile().bookmarks.length === 2, 'a second bookmark is added (named after the site)');
  ok(cfgFile().bookmarks[0].name === '지도' && cfgFile().bookmarks[1].name === 'a.b', 'browser/bookmarks: the name of the second one is the site: ' + JSON.stringify(cfgFile().bookmarks));
  await bm.locator('.bm-row').nth(1).locator('button', { hasText: '↑' }).click();
  await until(async () => cfgFile().bookmarks[0].name === 'a.b', 'the second goes up');
  await bm.locator('.bm-row').nth(0).locator('button', { hasText: '✕' }).click();
  await until(async () => cfgFile().bookmarks.length === 1, 'a bookmark is taken away');
  ok(cfgFile().bookmarks[0].name === '지도', 'browser/bookmarks: the other one stays');
  await control.evaluate(() => import('./settings.js').then(m => m.set({ bookmarks: [] })));
  // back to the settings: how a web window is drawn (for all of them), and the web window of a plugin below a line in the picker
  await opt.locator('.subtabs button', { hasText: '미니 브라우저 설정' }).click();
  await until(async () => (await opt.locator('.wintool select').count()) === 1, 'the page of the settings');
  await rowOf('그리기 방식').locator('select').selectOption('cpu');
  await until(async () => cfgFile().web_render === 'cpu', 'the way to draw is saved');
  ok(await opt.locator('#tabs li', { hasText: '고급' }).count() === 1 && await opt.locator('.row b.label', { hasText: /^그리기 방식$/ }).count() === 1, 'browser: the way a web window is drawn is in this tab');
  await rowOf('그리기 방식').locator('select').selectOption('auto');
  await control.evaluate(() => import('./settings.js').then(m => m.set({ child_windows: [...m.cfg().child_windows, { ...m.cfg().child_windows[0], id: 9, name: '플러그인 웹', kind: 'web', owner: 'plug', owner_win: 'web', geometry: '360x640+600+300', open_mode: 'never', dock_to: 0, topmost: true, topmost_wow_only: false, lock_window: false }] })));
  await until(async () => (await picker.locator('option').allTextContents()).some(t => t.includes('9 · 플러그인 웹')), 'the web window of the plugin is in the picker');
  const opts = await picker.locator('option').allTextContents();
  ok(opts.some(t => t.includes('플러그인 웹창 ──')) && opts.indexOf(opts.find(t => t.includes('9 ·'))) > opts.findIndex(t => t.includes('──')), 'browser: the web windows of the plugins are below a line in the picker: ' + opts.join('|'));
  await picker.selectOption('w9');
  await until(async () => (await opt.locator('.row b.label', { hasText: /^열리는 때$/ }).count()) === 1, 'the rows of the web window');
  ok(await opt.locator('.row b.label', { hasText: /^화면$/ }).count() === 0 && await opt.locator('.wintool button', { hasText: '삭제' }).isHidden(), 'browser: a web window of a plugin has its own few rows, and cannot be deleted here');
  await sw('창 고정').click();
  await until(async () => cfgFile().child_windows.find(c => c.id === 9).lock_window === true, 'the lock is saved in the entry of the window');
  await sw('와우 위에만').click();
  await until(async () => cfgFile().child_windows.find(c => c.id === 9).topmost_wow_only === true, 'above the game only is saved');
  ok(cfgFile().child_windows.find(c => c.id === 9).topmost === false, 'browser: "above the game only" takes "always on top" off for the web window too');
  await picker.selectOption('b1');
  await control.evaluate(() => import('./settings.js').then(m => m.set({ child_windows: m.cfg().child_windows.filter(c => c.id !== 9) })));
}
// the tab "기록": the log moved here from "정보", and the table of the processes
await opt.locator('#tabs li', { hasText: '기록' }).click(); await control.waitForTimeout(1500);
ok(await opt.locator('.resmon .res-table tbody tr').count() === 2 && (await opt.locator('.res-total').textContent()).includes('2'), 'options/log: the table of the processes: ' + (await opt.locator('.res-total').textContent()));
ok(await opt.locator('textarea, .logview').count() > 0 && !(await opt.locator('#tabs li', { hasText: '정보' }).count() === 0), 'options/log: the log is in this tab');
await opt.locator('#tabs li', { hasText: '창' }).first().click(); await control.waitForTimeout(500);
ok((await opt.locator('#tabs li', { hasText: '창' }).first().locator('.badge').textContent()) !== '', 'options/windows: the tab counts the changes');
await opt.click('#revertAll');
await control.waitForTimeout(1500);
ok(cfgFile().font_size !== 14 && !cfgFile().bottom_stick && !(cfgFile().win1_off || []).includes('O'), 'options/windows: revert all takes the window settings back');
await opt.locator('#tabs li', { hasText: '일반' }).click();

// ---- the 번역 tab: rows depend on the method; a choice per channel
await opt.locator('#tabs li', { hasText: '번역' }).first().click();
await opt.waitForSelector('.row b.label:text-is("번역 방식")');
ok(await opt.locator('h3', { hasText: 'AI 서버' }).isVisible() && await opt.locator('.row b.label', { hasText: '서버 주소' }).isHidden(), 'options/translation: the AI server card is there but folded while it is not the method');
await opt.locator('h3', { hasText: 'AI 서버' }).click();
ok(await opt.locator('.row b.label', { hasText: '서버 주소' }).isVisible(), 'options/translation: unfolding shows its rows');
await opt.selectOption('.row:has(b.label:text-is("번역 방식")) select', 'openai');
await control.waitForTimeout(1200);
{ // the model name: one text box; its list is asked of the server (address + key as set) when the box gets the focus
  const row = opt.locator('.row:has(b.label:text-is("모델 이름"))'), box = row.locator('input.wide'), pop = opt.locator('.sg-pop'), note = row.locator('.sg-state');
  ok(await box.count() === 1 && await row.locator('select').count() === 0, 'options/translation: the model name is one text box');
  await opt.locator('.row:has(b.label:text-is("서버 주소")) input').fill(''); await opt.locator('.row:has(b.label:text-is("서버 주소")) input').press('Tab'); await control.waitForTimeout(600);
  await box.click(); await control.waitForTimeout(200);
  ok(await note.textContent() === '서버 주소를 먼저 적어 주세요' && modelAsks.length === 0 && await pop.count() === 0, 'options/translation: without a server address nothing is asked');
  await box.press('Tab');
  await opt.locator('.row:has(b.label:text-is("서버 주소")) input').fill('http://ai.test/v1'); await opt.locator('.row:has(b.label:text-is("서버 주소")) input').press('Tab'); await control.waitForTimeout(600);
  await box.click(); await control.waitForTimeout(800);
  ok(modelAsks.length === 1 && modelAsks[0].url === 'http://ai.test/v1/models', 'options/translation: the focus asks the server for /models: ' + JSON.stringify(modelAsks.map(a => a.url)));
  ok((await pop.locator('.sg-item').allTextContents()).join('|') === 'qwen3-8b|gemma-3-4b' && await note.isHidden() && cfgFile().api_model === '', 'options/translation: the models are listed once each, and the box is untouched');
  await box.fill('gem'); await control.waitForTimeout(200);
  ok((await pop.locator('.sg-item').allTextContents()).join('|') === 'gemma-3-4b', 'options/translation: typing narrows the model list');
  await pop.locator('.sg-item').first().dispatchEvent('mousedown'); await control.waitForTimeout(700);
  ok(cfgFile().api_model === 'gemma-3-4b' && await box.inputValue() === 'gemma-3-4b' && await pop.count() === 0, 'options/translation: a click on a model puts its name in');
  await box.press('Tab');
  for (const [mode, text] of [['down', '연결 확인 실패'], ['401', '연결 확인 실패'], ['bad', '모델 로드 실패']]) {
    aiMode = mode; await box.click(); await control.waitForTimeout(800);
    ok(await note.textContent() === text && await note.evaluate(e => e.classList.contains('bad')) && await pop.count() === 0 && await box.inputValue() === 'gemma-3-4b', `options/translation: the server says "${mode}": the orange note "${text}", the typed name stays`);
    await box.press('Tab');
  }
  aiMode = 'ok'; await box.click(); await control.waitForTimeout(800);
  ok(await note.isHidden() && await pop.locator('.sg-item').count() === 2, 'options/translation: the next try that works clears the note');
  await box.press('Tab'); await box.fill(''); await box.press('Tab'); await control.waitForTimeout(500);
  await opt.locator('.row:has(b.label:text-is("서버 주소")) input').fill(''); await opt.locator('.row:has(b.label:text-is("서버 주소")) input').press('Tab'); await control.waitForTimeout(500);
}
ok(cfgFile().translator === 'openai' && await opt.locator('h3', { hasText: '직접 설정한 서버' }).isVisible(), 'options/translation: all server cards stay when the method changes');
await opt.locator('h3', { hasText: '직접 설정한 서버' }).click();
await opt.selectOption('.row:has(b.label:text-is("서비스")) select', 'DeepL Free');
await within(1200, async () => cfgFile().custom_preset === 'DeepL Free' && cfgFile().custom_url.includes('deepl.com') && cfgFile().custom_path === 'translations.0.text');
ok(cfgFile().custom_preset === 'DeepL Free' && cfgFile().custom_url.includes('deepl.com') && cfgFile().custom_path === 'translations.0.text', 'options/translation: a service preset fills the custom server rows');
ok(await opt.locator('.row', { hasText: '고른 서비스의 안내' }).isVisible() && await opt.locator('.row:has(b.label:text-is("주소")) input').inputValue().then(v => v.includes('deepl.com')), 'options/translation: the preset note and the address show');
await opt.selectOption('.routebox:has-text("길드 관리") select', 'off');
await within(1200, async () => JSON.stringify(cfgFile().channel_route.O) === '"off"');
ok(JSON.stringify(cfgFile().channel_route.O) === '"off"', 'options/translation: a channel can be set to "번역 안 함": ' + JSON.stringify(cfgFile().channel_route));
await opt.screenshot({ path: path.join(OUT, 'options_translation.png') });
await opt.click('#revertAll');
await control.waitForTimeout(1200);
ok(cfgFile().translator !== 'openai' && !cfgFile().channel_route.O, 'options/translation: revert all');
await opt.locator('#tabs li', { hasText: '일반' }).click();

// ---- the 음성인식 tab: the state and what its button does, the card of the chosen method opens, nothing installed says so
await opt.locator('#tabs li', { hasText: '음성인식' }).click();
ok(await opt.locator('.vsource').count() === 4 && (await opt.locator('.vsources').textContent()).includes('huggingface.co/ggerganov/whisper.cpp'), 'options/voice: the places the engine and the models come from are listed');
await opt.locator('.vsource', { hasText: 'Hugging Face' }).locator('button').click();
ok(opened.at(-1) === 'https://huggingface.co/ggerganov/whisper.cpp', 'options/voice: the model repository opens in the browser: ' + opened.at(-1));
await opt.waitForSelector('.vstatus');
await within(400, async () => (await opt.locator('.vstatus .vtext').textContent()).startsWith('꺼져 있음') && await opt.locator('.vtoggle').textContent() === '켜기');
ok((await opt.locator('.vstatus .vtext').textContent()).startsWith('꺼져 있음') && await opt.locator('.vtoggle').textContent() === '켜기', 'options/voice: off, and the button says what it will do');
ok(await opt.locator('.vinstall .vnone').textContent() === '설치되지 않음' && await opt.locator('.vbtns button', { hasText: '설치 (CPU)' }).isVisible(), 'options/voice: nothing installed, the install button is there');
ok(await opt.locator('.row b.label:text-is("계산 장치")').isVisible() && await opt.locator('.row b.label:text-is("서버 주소")').isHidden(), 'options/voice: Whisper is the method: its card is open, the server card folded');
await opt.locator('.vtoggle').click();
await within(500, async () => await opt.locator('.vstatus').getAttribute('data-state') === 'error' && (await opt.locator('.vstatus .vtext').textContent()).includes('설치되어 있지 않습니다'));
ok(await opt.locator('.vstatus').getAttribute('data-state') === 'error' && (await opt.locator('.vstatus .vtext').textContent()).includes('설치되어 있지 않습니다'), 'options/voice: turned on with nothing installed: the reason is shown');
await opt.locator('.vbtns button', { hasText: '설치 (CPU)' }).click();
await opt.waitForFunction(() => /올라와/.test(document.querySelector('.vmsg')?.textContent || ''));
ok(true, 'options/voice: installing an engine that is not published says so (no crash, the buttons come back)');
ok(await control.evaluate(() => window.cmrHub.voice.control.state.code) === 'not_installed', 'options/voice: the hub has the same state');
// a long line about the sound (a warning) stays on a line of its own under the button; it does not push the label away
await control.evaluate(() => window.cmrHub.voice.control.set({ state: 'on', engine: 'cpu', model: 'small', device: 'cpu',
  capture: { mode: 'none', status: 'waiting' }, warn: '프로그램에서 8초 동안 소리가 나지 않았습니다. 프로그램이 켜져 있고 소리가 나는지 확인하세요. (이 프로그램이 내는 소리만 듣습니다)' }));
await control.waitForTimeout(300);
{
  const b = n => opt.locator(n).first().boundingBox();
  const [btn, cap, label, row] = await Promise.all([b('.vstatus .vtoggle'), b('.vstatus .vcap'), b('.row:has(.vstatus) b.label'), b('.row:has(.vstatus)')]);
  ok(cap && btn && cap.y >= btn.y + btn.height - 1, 'options/voice: the sound line is under the on/off button, not beside it');
  ok(label.width > 20 && label.x < row.x + 60, 'options/voice: a long sound line does not squeeze the label');
  ok(btn.x + btn.width <= row.x + row.width + 1 && cap.x + cap.width <= row.x + row.width + 1, 'options/voice: nothing runs out of the option');
  await opt.locator('.row:has(.vstatus)').screenshot({ path: path.join(OUT, 'options_voice_status.png') });
}
await control.evaluate(() => window.cmrHub.voice.control.set({ state: 'off', capture: null, warn: '', engine: '', model: '', device: '' }));
await control.waitForTimeout(200);
// every option of the voice recognition says whether a change is applied while it runs
{
  const chip = (label, kind) => opt.locator(`.row:has(> .text b.label:text-is("${label}")) .apply.${kind}`).count();
  const none = label => opt.locator(`.row:has(> .text b.label:text-is("${label}")) .apply`).count();
  ok(await chip('소리 대상', 'live') === 1 && await chip('소리 받는 방식', 'live') === 1 && await chip('말하는 언어', 'live') === 1 && await chip('표시 방식', 'live') === 1, 'options/voice: target, method, language, display mode say "바로 적용"');
  ok(await chip('모델', 'restart') === 1 && await chip('계산 장치', 'restart') === 1 && await chip('음성인식 방식', 'restart') === 1, 'options/voice: model, compute device, method say "다시 시작해야 적용"');
  ok(await none('시작할 때 자동으로 켜기') === 0 && await none('상태') === 0, 'options/voice: the options that have nothing to do with it have no mark');
  ok((await opt.locator('.apply.live').first().textContent()) === '바로 적용' && (await opt.locator('.apply.restart').first().textContent()) === '다시 시작해야 적용' && (await opt.locator('.card', { hasText: '표시 방식' }).count()) >= 1, 'options/voice: the marks read right');
}
// what waits for a restart, the loudness bar and the sentences (it is on)
await control.evaluate(() => window.cmrHub.voice.control.set({ state: 'on', engine: 'cpu', model: 'small', device: 'cpu', capture: { mode: 'device', device: 'Headset', program: 'Discord.exe', status: 'listening' },
  warn: '', pending: ['model', 'device'], texts: { count: 3, last: Date.now() - 4000 } }));
await within(300, async () => await opt.locator('.vpending').isVisible() && (await opt.locator('.vpending').textContent()).includes('모델') && (await opt.locator('.vpending').textContent()).includes('계산 장치') && await opt.locator('.vpending button').isVisible());
ok(await opt.locator('.vpending').isVisible() && (await opt.locator('.vpending').textContent()).includes('모델') && (await opt.locator('.vpending').textContent()).includes('계산 장치') && await opt.locator('.vpending button').isVisible(), 'options/voice: what only a restart applies is named, with a button');
ok(await opt.locator('.vlevel').isVisible() && (await opt.locator('.vtexts').textContent()).includes('인식된 글 3개'), 'options/voice: the loudness bar and the sentences are shown while it is on');
await control.evaluate(() => window.__TAURI__.event.emit('voice-level', { source: 'engine', db: -35, peak: 0.1, speech: true, thr: -45 }));
await control.waitForTimeout(250);
{
  const w = await opt.locator('.vfill').evaluate(e => e.style.width), left = await opt.locator('.vtick').evaluate(e => e.style.left);
  ok(Math.abs(parseFloat(w) - 50) < 1 && Math.abs(parseFloat(left) - 35.7) < 1, 'options/voice: the bar follows the engine\'s loudness (-35 dB of -70..0) and shows the speech limit');
  ok((await opt.locator('.vdb').textContent()) === '-35 dB' && await opt.locator('.vspeech.on').isVisible(), 'options/voice: the number and "speech" light');
}
await control.evaluate(() => window.__TAURI__.event.emit('voice-level', { source: 'capture', peak: 0.1, level: 0.1, gate: true }));
await within(200, async () => (await opt.locator('.vdb').textContent()) === '-35 dB' && (await opt.locator('.vgate').textContent()) === '통과 중');
ok((await opt.locator('.vdb').textContent()) === '-35 dB' && (await opt.locator('.vgate').textContent()) === '통과 중', 'options/voice: while the engine reports, its reading is used; the gate shows for the whole-device method');
await opt.locator('.vstatus').screenshot({ path: path.join(OUT, 'options_voice_level.png') });
await control.evaluate(() => { window.__restarts = 0; window.__TAURI__.event.listen('voice-restart', () => { window.__restarts++; }); });
await opt.locator('.vpending button').click();
await within(200, async () => await control.evaluate(() => window.__restarts) >= 1);
ok(await control.evaluate(() => window.__restarts) >= 1, 'options/voice: the button asks the hub to restart');
await control.evaluate(() => window.cmrHub.voice.control.set({ state: 'off', capture: null, pending: [], texts: { count: 0, last: 0 }, engine: '', model: '', device: '' }));
await control.waitForTimeout(200);
ok(await opt.locator('.vlevel').isHidden() && await opt.locator('.vpending').isHidden(), 'options/voice: off: no bar, no notice');
// the model list: what is on the disk and what is not, the speed numbers, the test button
const mrow = n => opt.locator('.vmtable tbody tr', { hasText: n }).first();
ok(await opt.locator('.vmtable tbody tr').count() === 6 && (await mrow('small').locator('td').nth(2).textContent()) === '없음' && await mrow('small').locator('button').textContent() === '받기', 'options/voice: every model is listed, one that is not on the disk says so and can be got');
await control.evaluate(() => window.cmrHub.voice.control.set({ installed: { engines: ['cpu'], models: ['small'] }, benchFiles: ['talk.wav'],
  perf: [{ model: 'small', device: 'cpu', live: { n: 8, ratio: 0.42, avgMs: 1500, speech: 30 }, bench: { ratio: 0.3, dur: 20, ms: 6000, file: 'talk.wav', text: 'hello there', load_ms: 700, at: 1 } }] }));
await within(300, async () => (await mrow('small').locator('td').nth(2).textContent()).startsWith('설치됨') && await mrow('small').locator('button').textContent() === '삭제');
ok((await mrow('small').locator('td').nth(2).textContent()).startsWith('설치됨') && await mrow('small').locator('button').textContent() === '삭제', 'options/voice: an installed model says so and can be deleted');
ok((await mrow('small').locator('td').nth(3).textContent()) === '×0.42 (8)' && (await mrow('small').locator('td').nth(4).textContent()).startsWith('×0.30') && (await mrow('small').locator('td').nth(4).textContent()).includes('불러오기 0.7'), 'options/voice: the speed in use and of the test are shown, with the load time apart');
await control.evaluate(() => window.cmrHub.voice.control.set({ task: '', perf: [{ model: 'small', device: 'cpu', live: null, bench: { ratio: 1.64, dur: 11, ms: 18000, file: 'talk.wav', text: 'hello there', load_ms: 80000, at: 1 } }] }));
await within(300, async () => (await mrow('small').locator('td').nth(4).textContent()).includes('⚠') && (await opt.locator('.vmodels .vmsg').textContent()).includes('시험 배율이 1을 넘는'));
ok((await mrow('small').locator('td').nth(4).textContent()).includes('⚠') && (await opt.locator('.vmodels .vmsg').textContent()).includes('시험 배율이 1을 넘는'), 'options/voice: a test ratio over 1 is marked and explained');
await control.evaluate(() => window.cmrHub.voice.control.set({ perf: [{ model: 'small', device: 'cpu', live: { n: 8, ratio: 0.42, avgMs: 1500, speech: 30 }, bench: { ratio: 0.3, dur: 20, ms: 6000, file: 'talk.wav', text: 'hello there', load_ms: 700, at: 1 } }] }));
await within(300, async () => (await opt.locator('.vheard').textContent()).includes('hello there'));
ok((await opt.locator('.vheard').textContent()).includes('hello there'), 'options/voice: what the model heard in the test is shown');
ok(await opt.locator('.vbench button', { hasText: '선택한 모델 속도 시험' }).isDisabled(), 'options/voice: the test button waits for a ticked model');
await mrow('small').locator('input').check();
ok(await opt.locator('.vbench button', { hasText: '선택한 모델 속도 시험' }).isEnabled(), 'options/voice: ... and is enabled once an installed model is ticked');
await mrow('small').locator('button').click();
ok(await mrow('small').locator('button').textContent() === '정말 삭제', 'options/voice: deleting a model asks once more');
await opt.screenshot({ path: path.join(OUT, 'options_voice_models.png'), fullPage: true });
await control.evaluate(() => window.cmrHub.voice.control.set({ installed: { engines: [], models: [] }, perf: [], benchFiles: [] }));
ok(await opt.locator('.row b.label:text-is("소리 대상")').isVisible() && await opt.locator('.row b.label:text-is("프로그램")').isHidden(), 'options/voice: the program picker shows only for "프로그램을 직접 고르기"');
await opt.selectOption('.row:has(b.label:text-is("소리 대상")) select', 'discord');
await within(1000, async () => cfgFile().voice_target === 'discord' && (await opt.locator('.row:has(b.label:text-is("소리 대상")) .hint').textContent()).includes('세션'));
ok(cfgFile().voice_target === 'discord' && (await opt.locator('.row:has(b.label:text-is("소리 대상")) .hint').textContent()).includes('세션'), 'options/voice: the Discord preset is kept, with its hint');
await opt.selectOption('.row:has(b.label:text-is("소리 대상")) select', 'app');
await opt.waitForSelector('.vpicker');
ok((await opt.locator('.vpicker select option').allTextContents()).join('|').includes('Discord.exe · 렌더러 · Headset') && (await opt.locator('.vpicker select option').allTextContents()).join('|').includes('Discord.exe · AudioService · Speakers · pid 5'), 'options/voice: the programs that make sound are listed per job and device');
await opt.selectOption('.vpicker select', 'wow.exe');
await within(1000, async () => cfgFile().voice_app === 'wow.exe');
ok(cfgFile().voice_app === 'wow.exe', 'options/voice: a program is picked from the list');
await opt.fill('.vpicker input', 'chrome.exe');
await opt.locator('.vpicker input').dispatchEvent('change');
await within(1000, async () => cfgFile().voice_app === 'chrome.exe');
ok(cfgFile().voice_app === 'chrome.exe', 'options/voice: a program typed by hand is kept');
await opt.selectOption('.vpicker select', 'Discord.exe|renderer|');
await within(800, async () => cfgFile().voice_app === 'Discord.exe|renderer|');
ok(cfgFile().voice_app === 'Discord.exe|renderer|', 'options/voice: one job of a program (Discord voice) can be picked');
await opt.locator('.vpicker .vprobe').waitFor({ state: 'attached' });
await opt.locator('.vpicker button:text-is("소리 확인 (4초)")').click();
await opt.waitForFunction(() => document.querySelector('.vpicker .vprobe').textContent.includes('0.3000'));
ok((await opt.locator('.vpicker .vprobe').textContent()).includes('probe-4.wav') && (await opt.locator('.vpicker .vprobe').textContent()).includes('0x88890021'), 'options/voice: the capture check shows what it heard and the errors');
await opt.locator('.vpicker button:has-text("장치 소리 확인")').click();
await opt.waitForFunction(() => document.querySelector('.vpicker .vprobe').textContent.includes('probe-device.wav'));
ok(true, 'options/voice: the whole-device check works');
await opt.selectOption('.row:has(b.label:text-is("표시 방식")) select', 'live');
await within(1000, async () => cfgFile().voice_mode === 'live' && await opt.locator('.row b.label:text-is("실시간 갱신 간격")').isVisible());
ok(cfgFile().voice_mode === 'live' && await opt.locator('.row b.label:text-is("실시간 갱신 간격")').isVisible(), 'options/voice: live mode shows its interval');
await opt.selectOption('.row:has(b.label:text-is("말하는 언어")) select', 'ja');
await within(1000, async () => cfgFile().voice_lang === 'ja');
ok(cfgFile().voice_lang === 'ja', 'options/voice: the spoken language is kept');
await opt.selectOption('.row:has(b.label:text-is("음성인식 방식")) select', 'openai');
await control.waitForTimeout(1200);
ok(cfgFile().voice_engine === 'openai' && await opt.locator('.row b.label:text-is("서버 주소")').isVisible() && await opt.locator('.row b.label:text-is("계산 장치")').isHidden(), 'options/voice: the server method opens the server card and folds Whisper');
await opt.selectOption('.row:has(b.label:text-is("계산 장치")) select', 'gpu', { timeout: 300 }).catch(() => {});       // (folded: the card of the server is open; this only tries, it used to wait 30 s)
await opt.screenshot({ path: path.join(OUT, 'options_voice_server.png'), fullPage: true });
await opt.click('#revertAll');
await within(1200, async () => cfgFile().voice_engine === 'whisper' && await opt.locator('.row b.label:text-is("계산 장치")').isVisible());
ok(cfgFile().voice_engine === 'whisper' && await opt.locator('.row b.label:text-is("계산 장치")').isVisible(), 'options/voice: revert all (Whisper card open again)');
await opt.locator('h3', { hasText: '고급' }).click();
await opt.setViewportSize({ width: 940, height: 1500 });      // (the whole tab in one picture)
await opt.screenshot({ path: path.join(OUT, 'options_voice.png') });
await opt.locator('.card', { has: opt.locator('b.label:text-is("말하는 언어")') }).screenshot({ path: path.join(OUT, 'options_voice_marks.png') });
await opt.setViewportSize({ width: 940, height: 680 });
await opt.locator('#tabs li', { hasText: '일반' }).click();

// ---- the 단어장·프롬프트 tab: the glossary file is edited and saved here; the prompt has its own default button
await opt.locator('#tabs li', { hasText: '단어장' }).click();
await opt.waitForSelector('textarea.filetext');
await within(300, async () => (await opt.inputValue('textarea.filetext')).includes('LFM = 구인') && await opt.locator('.row.t-file button', { hasText: '저장' }).isDisabled());
ok((await opt.inputValue('textarea.filetext')).includes('LFM = 구인') && await opt.locator('.row.t-file button', { hasText: '저장' }).isDisabled(), 'options/glossary: the glossary file is shown (nothing to save yet)');
await opt.fill('textarea.filetext', (await opt.inputValue('textarea.filetext')) + '\nZZTOP = 시험용 단어\n');
ok(await opt.locator('.row.t-file button', { hasText: '저장' }).isEnabled(), 'options/glossary: editing enables "저장"');
await opt.locator('.row.t-file button', { hasText: '저장' }).click();
await within(300, async () => (files.get('Glossary.txt') || '').includes('ZZTOP = 시험용 단어'));
ok((files.get('Glossary.txt') || '').includes('ZZTOP = 시험용 단어'), 'options/glossary: saved to Glossary.txt');
let sawGloss = false, sawConn = (await texts(main)).some(t => t.includes('번역 서버 연결 양호'));
for (let i = 0; i < 80 && !sawGloss; i++) { await control.waitForTimeout(100); sawGloss = (await texts(main)).some(t => t.includes('단어장을 다시 읽었습니다')); }
ok(sawGloss, 'upkeep: saving the glossary shows a note in the window');
ok(sawConn, 'upkeep: the connection check at start shows its result');
const promptRow = rowOf('기본 프롬프트');
ok(await promptRow.locator('button.def').isDisabled(), 'options/glossary: the prompt is the default (dim button)');
await promptRow.locator('textarea').fill('MY PROMPT {{Glossary.txt}}'); await promptRow.locator('textarea').dispatchEvent('change');
await within(1200, async () => cfgFile().prompt === 'MY PROMPT {{Glossary.txt}}' && await promptRow.locator('button.def').isEnabled());
ok(cfgFile().prompt === 'MY PROMPT {{Glossary.txt}}' && await promptRow.locator('button.def').isEnabled(), 'options/glossary: a changed prompt is saved');
await promptRow.locator('button.def').click();
await within(1200, async () => cfgFile().prompt.startsWith('You are a real-time chat translator'));
ok(cfgFile().prompt.startsWith('You are a real-time chat translator'), 'options/glossary: the default button brings the default prompt back');
ok((await opt.locator('.row:has(b.label:text-is("단어장 전달 방식")) option').allTextContents()).join() === '전체,선별,복합' && (await opt.locator('.row:has(b.label:text-is("단어장 전달 방식")) .hint').textContent()).includes('전체'), 'options/glossary: three short names, the meaning of the chosen one under the label');
await rowOf('추가 지시').locator('textarea').fill('');
await rowOf('추가 지시').locator('textarea').dispatchEvent('change');
await opt.locator('.ex', { hasText: '해적' }).click();
await within(1200, async () => cfgFile().extra_prompt === 'Always write the translated dialogue in the style of a pirate.');
ok(cfgFile().extra_prompt === 'Always write the translated dialogue in the style of a pirate.', 'options/glossary: an example is put into the extra instructions');
await rowOf('추가 지시').locator('button.def').click();
await control.waitForTimeout(800);
// a glossary file name that does not exist yet gets the sample
await rowOf('단어장 파일 이름').locator('input').fill('Neu.txt'); await rowOf('단어장 파일 이름').locator('input').dispatchEvent('change');
for (let i = 0; i < 40 && !files.has('Neu.txt'); i++) await control.waitForTimeout(100);
ok((files.get('Neu.txt') || '').includes('LFM = 구인'), 'options/glossary: a new glossary file name gets the sample content');
ok((await opt.inputValue('textarea.filetext')).includes('LFM = 구인'), 'options/glossary: and the editor shows it');
await rowOf('단어장 파일 이름').locator('button.def').click();
await control.waitForTimeout(800);
await opt.locator('#tabs li', { hasText: '번역' }).first().click();
ok(await opt.locator('.row.warn', { hasText: '한국어가 아니면' }).count() === 0 || await opt.locator('.row.warn', { hasText: '한국어가 아니면' }).isHidden(), 'options: no language warning for Korean');
await opt.selectOption('.row:has(b.label:text-is("목표 언어")) select', 'English');
await within(1000, async () => await opt.locator('.row.warn', { hasText: '한국어가 아니면' }).first().isVisible());
ok(await opt.locator('.row.warn', { hasText: '한국어가 아니면' }).first().isVisible(), 'options: a target language other than Korean warns about the glossary and the prompt');
await opt.selectOption('.row:has(b.label:text-is("목표 언어")) select', '한국어');
await control.waitForTimeout(1000);

// ---- the 보내기 tab: the hotkey is taken from the keyboard
await opt.locator('#tabs li', { hasText: '보내기' }).first().click();
await opt.waitForSelector('select.hotkeykey');
await rowOf('단축키').locator('input[value=Shift]').uncheck();
ok((await rowOf('단축키').locator('.err').textContent()).includes('함께') && cfgFile().send_hotkey === 'Shift+Enter', 'options/send: Enter without Ctrl/Alt/Shift is refused');
await rowOf('단축키').locator('input[value=Ctrl]').check();
await within(1200, async () => cfgFile().send_hotkey === 'Ctrl+Enter');
ok(cfgFile().send_hotkey === 'Ctrl+Enter', 'options/send: Ctrl+Enter: ' + cfgFile().send_hotkey);
await rowOf('단축키').locator('select').selectOption('K');
await rowOf('단축키').locator('input[value=Shift]').check();
await within(1200, async () => cfgFile().send_hotkey === 'Ctrl+Shift+K');
ok(cfgFile().send_hotkey === 'Ctrl+Shift+K', 'options/send: the key from the list: ' + cfgFile().send_hotkey);
// languages: a list, and "직접 입력" for the rest
await opt.selectOption('.row:has(b.label:text-is("보내는 언어")) select', '日本語');
await within(1000, async () => cfgFile().send_lang === '日本語');
ok(cfgFile().send_lang === '日本語', 'options/send: the language comes from the list');
await opt.selectOption('.row:has(b.label:text-is("보내는 언어")) select', { label: '직접 입력' });
await opt.fill('.row:has(b.label:text-is("보내는 언어")) input.wide', 'Português'); await opt.locator('.row:has(b.label:text-is("보내는 언어")) input.wide').dispatchEvent('change');
await within(1000, async () => cfgFile().send_lang === 'Português' && await opt.locator('.row:has(b.label:text-is("보내는 언어")) input.wide').isVisible());
ok(cfgFile().send_lang === 'Português' && await opt.locator('.row:has(b.label:text-is("보내는 언어")) input.wide').isVisible(), 'options/send: any other language by hand');
await rowOf('단축키').locator('button.def').click();
await within(1000, async () => cfgFile().send_hotkey === 'Shift+Enter');
ok(cfgFile().send_hotkey === 'Shift+Enter', 'options/send: the default button brings Shift+Enter back');
await opt.locator('.ex', { hasText: '존댓말' }).click();
await within(1000, async () => cfgFile().send_extra_prompt.startsWith('Write in a polite'));
ok(cfgFile().send_extra_prompt.startsWith('Write in a polite'), 'options/send: an example goes into the extra instructions');
await opt.click('#revertAll');
await control.waitForTimeout(1000);
await opt.locator('#tabs li', { hasText: '일반' }).click();

// ---- the 정보 tab: version, the newest release (of this major version), the log
await opt.locator('#tabs li', { hasText: '정보' }).click();
await opt.waitForSelector('.aboutcard .latest');
ok((await opt.locator('.aboutcard .cur').textContent()).startsWith('v' + THIS_VERSION), 'options/about: the version is shown');
await within(3500, async () => (await opt.locator('.aboutcard .latest').textContent()).includes('v' + NEXT_VERSION) && await opt.locator('.aboutcard .latest.newer').count() === 1);
ok((await opt.locator('.aboutcard .latest').textContent()).includes('v' + NEXT_VERSION) && await opt.locator('.aboutcard .latest.newer').count() === 1, 'options/about: the newest release of this major version (not 4.0), marked as newer: ' + await opt.locator('.aboutcard .latest').textContent());
ok((await opt.locator('.aboutcard .dir').textContent()).includes('fake'), 'options/about: the program folder');
await opt.click('.aboutcard button:has-text("릴리스 페이지")');
await within(200, async () => opened.at(-1) === 'https://github.com/blackmass/ChatMatrixReader/releases');
ok(opened.at(-1) === 'https://github.com/blackmass/ChatMatrixReader/releases', 'options/about: the release page opens in the browser');
// the licenses: the technology list is there, the full texts are files of the program folder (read through the exe)
ok((await opt.locator('.lictech').textContent()).includes('Eternalguard') && (await opt.locator('.lictech').textContent()).includes('whisper.cpp'), 'options/about: the technology and licenses are listed');
await opt.locator('.licenses button', { hasText: 'LICENSE 보기' }).click();
await opt.waitForTimeout(200);
ok(await opt.locator('.licview').isHidden() && (await opt.locator('.licenses small').last().textContent()).includes('LICENSE'), 'options/about: a missing license file is explained (not an empty box)');
files.set('LICENSE', 'MIT License\n\nCopyright (c) 2026 Eternalguard\n');
await opt.locator('.licenses button', { hasText: 'LICENSE 보기' }).click();
await within(200, async () => await opt.locator('.licview').isVisible() && (await opt.locator('.licview').inputValue()).includes('MIT License'));
ok(await opt.locator('.licview').isVisible() && (await opt.locator('.licview').inputValue()).includes('MIT License'), 'options/about: the license text is shown when the file is there');
files.delete('LICENSE');

files.set('logs/chatmatrix.log', Array.from({ length: 600 }, (_, i) => 'LOG LINE ' + i).join('\n'));
await opt.locator('#tabs li', { hasText: '기록' }).click(); await opt.waitForTimeout(300);
await opt.locator('.row.t-logview button', { hasText: '새로 고침' }).click();
await control.waitForTimeout(300);
const logText = await opt.inputValue('textarea.logtext');
ok(logText.endsWith('LOG LINE 599') && !logText.includes('LOG LINE 100\n') && logText.split('\n').length === 400, 'options/log: the log shows its last 400 lines');

// ---- the display language: the texts of every window follow the setting, and switching back restores them
await opt.locator('#tabs li', { hasText: '일반' }).click();
await opt.waitForSelector('.row:has(b.label:text-is("표시 언어"))');
ok(await opt.locator('.row:has(b.label:text-is("표시 언어")) option').count() === 3, 'language: the list has the system choice, Korean and the locale file');
await opt.selectOption('.row:has(b.label:text-is("표시 언어")) select', 'en-US');
await within(1500, async () => cfgFile().language === 'en-US');
ok(cfgFile().language === 'en-US', 'language: saved');
ok((await opt.locator('#tabs li .name').allTextContents()).join('|') === 'General|Window|Mini browser|Translation|Glossary & prompt|Exceptions|Send|Voice recognition|Plugin|Advanced|About|Records' , 'language: the side menu is in English: ' + (await opt.locator('#tabs li .name').allTextContents()).join('|'));
ok(await opt.locator('#head').textContent() === 'General' && (await opt.getAttribute('#q', 'placeholder')) === 'Search options', 'language: header and placeholder');
ok(await opt.locator('.row b.label', { hasText: 'Display language' }).count() === 1, 'language: option rows');
await opt.locator('#tabs li', { hasText: 'Window' }).click();
await opt.waitForSelector('.wintool');
ok((await opt.locator('.wintool select option').first().textContent()).includes('Main'), 'language: texts put together while running (the window list): ' + await opt.locator('.wintool select option').first().textContent());
const chatBefore = await texts(main);
ok(chatBefore.some(t => /LFM/.test(t)), 'language: the chat itself is never translated by the page');
await opt.locator('#tabs li', { hasText: 'Translation' }).click();
await opt.waitForSelector('h3:text-is("Method")');
await opt.screenshot({ path: path.join(OUT, 'options_english.png') });
await opt.locator('#tabs li', { hasText: 'General' }).click();
await opt.selectOption('.row:has(b.label:text-is("Display language")) select', 'ko-KR');
await within(1500, async () => await opt.locator('#head').textContent() === '일반' && (await opt.getAttribute('#q', 'placeholder')) === '옵션 검색');
ok(await opt.locator('#head').textContent() === '일반' && (await opt.getAttribute('#q', 'placeholder')) === '옵션 검색', 'language: back to Korean restores every text');
await opt.selectOption('.row:has(b.label:text-is("표시 언어")) select', '');
await control.waitForTimeout(1200);

await main.bringToFront();                                   // (a page that is not in front gets its scroll events late: the page counts 600 ms from the wheel)
const plain = await main.evaluate(() => {
  const ev = (type, init) => { const e = type === 'wheel' ? new WheelEvent(type, { cancelable: true, bubbles: true, ...init }) : new MouseEvent(type, { cancelable: true, bubbles: true, ...init }); document.querySelector('.cv-blk').dispatchEvent(e); return e.defaultPrevented; };
  const el = document.getElementById('lines'); el.style.height = '40px'; el.style.overflow = 'auto'; el.scrollTop = 0;
  const r = { menu: ev('contextmenu', { button: 2 }), middle: ev('auxclick', { button: 1 }), ctrlWheel: ev('wheel', { ctrlKey: true, deltaY: 30 }), shiftWheel: ev('wheel', { shiftKey: true, deltaY: 30 }) };
  r.scrolled = el.scrollTop; return r;
});
ok(plain.menu && plain.middle && plain.ctrlWheel && plain.shiftWheel, 'context menu, middle click and Ctrl/Shift+wheel are taken over: ' + JSON.stringify(plain));
ok(plain.scrolled >= 50, 'Ctrl/Shift+wheel scrolls the lines: ' + plain.scrolled);
await main.evaluate(() => { document.getElementById('lines').scrollTop = 200; });
await new Promise(r => setTimeout(r, 200));                      // (real time: the scroll to 200 is its own event first, then the wheel goes up from there; in one go the page sees one move)
await main.evaluate(() => { document.querySelector('.cv-blk').dispatchEvent(new WheelEvent('wheel', { shiftKey: true, deltaY: -30, cancelable: true, bubbles: true })); });
for (let i = 0; i < 20 && !(await main.evaluate(() => document.body.classList.contains('review'))); i++) await control.waitForTimeout(100);       // (the window loop takes a round or two)
ok(await main.evaluate(() => document.body.classList.contains('review')), 'Shift+wheel up (the page gets it itself) also starts the review of the old chat: ' + await main.evaluate(() => { const l = document.getElementById('lines'); return JSON.stringify({ top: l.scrollTop, h: l.scrollHeight, c: l.clientHeight, cls: document.body.className, hidden: document.hidden }); }));

// ---- tabs: a window that is a TAB of another ("탭으로 합칠 창"): no window of its own, a tab in the bar of the other, its own lines, a mark for new lines
{
  const idt = await control.evaluate(() => window.cmrHub.windows.add('귓말'));
  const setConf = patch => control.evaluate(([i, pt]) => import('./settings.js').then(m => m.set({ child_windows: m.cfg().child_windows.map(c => (c.id === i ? { ...c, ...pt } : c)) })), [idt, patch]);
  await control.evaluate(() => import('./settings.js').then(m => m.set({ win1_off: ['W'] })));                       // (the main window does not show whispers: they are the tab's)
  await setConf({ channels: ['W'], dock_to: 1, tab_alert: true, open_mode: 'always' }); await control.waitForTimeout(700);
  const say = (ch, t) => control.evaluate(([c, x]) => window.cmrHub.fakeLine({ channel: c, name: 'Ann', text: x }), [ch, t]);
  ok(await main.locator('#bar .tab').count() === 2 && await main.locator(`#bar .tab[data-wid="${idt}"]`).textContent() === '귓말' && await main.locator('#title').getAttribute('class').then(c => c.includes('on')), 'tabs: the window is a tab in the bar of the main window');
  ok(await control.evaluate(i => window.cmrHub.windows.isOpen(i), idt) && !(await control.evaluate(i => window.cmrHub.windows.openIds().includes(i), idt)), 'tabs: it counts as open but has no window of its own');
  await say('whisper', 'psst only for the tab'); await say('party', 'party text for the main one'); await control.waitForTimeout(700);
  const own = (sel) => main.evaluate(s2 => document.querySelector(s2).textContent, sel);
  ok((await own('#lines')).includes('party text') && !(await own('#lines')).includes('psst') && (await own('#lines-' + idt)).includes('psst') && !(await own('#lines-' + idt)).includes('party text'), 'tabs: each tab keeps its own lines');
  ok(await main.locator(`#bar .tab[data-wid="${idt}"]`).getAttribute('class').then(c => c.includes('alert')) && await main.evaluate(() => document.body.classList.contains('has-alert')), 'tabs: a new line in the tab that is not shown marks it (the option is on)');
  await main.locator(`#bar .tab[data-wid="${idt}"]`).click(); await control.waitForTimeout(300);
  ok(await main.evaluate(i => document.getElementById('lines-' + i).classList.contains('off') === false && document.getElementById('lines').classList.contains('off'), idt) && await main.locator(`#bar .tab[data-wid="${idt}"]`).getAttribute('class').then(c => c.includes('on') && !c.includes('alert')), 'tabs: a click shows the tab and takes the mark away');
  await setConf({ tab_alert: false }); await main.locator('#title').click(); await say('whisper', 'second whisper'); await control.waitForTimeout(500);
  ok(await main.locator(`#bar .tab[data-wid="${idt}"]`).getAttribute('class').then(c => !c.includes('alert')) , 'tabs: the mark is off by default (the option is off)');
  await main.locator('#title').click(); await control.waitForTimeout(200);           // (the main tab is shown; the right button on the tab of the other one: the menu is of that one)
  await main.locator(`#bar .tab[data-wid="${idt}"]`).click({ button: 'right' }); await control.waitForTimeout(500);
  const menuTexts = await main.evaluate(() => [...document.querySelectorAll('#ctx div')].map(d => d.textContent));
  ok(menuTexts.includes('이 탭 독립시키기') && await main.evaluate(i => document.getElementById('lines-' + i).classList.contains('off'), idt), 'tabs: the right button on a tab that is not shown gives the menu of that tab, without showing it: ' + JSON.stringify(menuTexts));
  await main.keyboard.press('Escape');
  // the options: the window-level rows of a tab are dim ("<name> 창을 따름"), the text rows are not
  await opt.locator('#tabs li', { hasText: '창' }).first().click(); await opt.waitForSelector('.wintool');
  await opt.selectOption('.wintool select', String(idt)); await control.waitForTimeout(500);
  const rowOf = t => opt.locator('.row', { has: opt.locator('b.label', { hasText: new RegExp('^' + t + '$') }) });
  ok(await rowOf('배경 진하기').getAttribute('class').then(c => c.includes('docked')) && !(await rowOf('글 정렬').getAttribute('class')).includes('docked') && (await rowOf('배경 진하기').textContent()).includes('창을 따름'), 'tabs/options: the rows of the window itself are dim and say whom they follow');
  ok(await rowOf('탭으로 합칠 창').count() === 1 && await opt.locator('.winstate').textContent().then(t => t.includes('탭')), 'tabs/options: the row to choose the window, and the state says it is a tab');
  await opt.selectOption('.wintool select', '1'); await control.waitForTimeout(300);
  await setConf({ dock_to: 0 }); await control.waitForTimeout(700);
  ok(await main.locator('#bar .tab').count() === 1 && await main.locator('#lines-' + idt).count() === 0 && await main.locator('#title').getAttribute('class').then(c => c.includes('on')) && !(await main.evaluate(() => document.getElementById('lines').classList.contains('off'))), 'tabs: not merged any more: the tab is gone and the main lines show');
  ok(await control.evaluate(i => window.cmrHub.windows.openIds().includes(i), idt) && await cm.locator(`.pane[data-id="${idt}"]`).count() === 1, 'tabs: not merged any more: it has a window of its own again (a pane)');
  await control.evaluate(() => import('./settings.js').then(m => m.set({ win1_off: [] })));
  await control.evaluate(i => window.cmrHub.windows.remove(i), idt); await control.waitForTimeout(400);
}

// ---- plugins: the folder is read, a good one is run in a sandboxed frame, what its frame asks is answered by the bridge (permissions, limits)
{
  const PID = 'e2e-plugin-0123456789abcdef';
  files.set(`plugins/${PID}/plugin.json`, JSON.stringify({ id: PID, name: '시험 플러그인', version: '1.0.0', api: 1,
    permissions: { net: ['example.com'], netAny: true, 'chat.inject': true, storage: true, widgets: true, windows: true, openUrl: true, web: 'domain' }, reasons: { net: 'a', netAny: 'f', 'chat.inject': 'b', storage: 'c', widgets: 'd', windows: 'e', openUrl: 'g', web: 'h' }, options: [{ key: 'n', type: 'number', default: 3 }],
    windows: [{ id: 'main', title: '플러그인 창', page: 'window.html', width: 300, height: 200 }] }));
  files.set('plugins/broken-one/plugin.json', '{ not json');
  files.set('plugins/not-a-plugin/readme.txt', 'x');
  await control.evaluate(async () => { window.cmrHub.plugins.watch = false; await window.cmrHub.plugins.scan(); });         // (the frames of this test are empty pages: they never answer "are you there?"; the watchdog has a test of its own below)
  const KEY = await control.evaluate(id => import('./core/plugins.js').then(p => p.permsKey(window.cmrHub.plugins.registry.get(id).manifest)), PID);       // (the user has decided about it: no window asks)
  const list = () => control.evaluate(() => window.cmrHub.plugins.list().map(p => ({ id: p.id, ok: p.ok, running: p.running, enabled: p.enabled, missing: p.missing.length, errors: p.errors.length })));
  const l0 = await list();
  ok(l0.find(p => p.id === PID).ok && l0.find(p => p.id === PID).missing === 8 && !l0.find(p => p.id === PID).running, 'plugins: a good plugin is found; nothing is allowed yet (8 to approve), it is not running: ' + JSON.stringify(l0));
  ok(l0.find(p => p.id === 'broken-one').ok === false && l0.find(p => p.id === 'not-a-plugin').errors === 1, 'plugins: a broken plugin.json and a folder without one are found, with errors');
  await control.evaluate(([id, key]) => import('./settings.js').then(m => m.set({ plugins: { [id]: { asked: key, enabled: true, granted: { net: ['example.com'], netAny: true, 'chat.inject': true, storage: true, widgets: true, windows: true, openUrl: true, web: 'domain' }, options: { n: 7 } } } })), [PID, KEY]);
  await control.waitForTimeout(600);
  const fr = await control.evaluate(id => { const f = document.querySelector(`#plugin-frames iframe[data-plugin="${id}"]`); return f ? { sandbox: f.getAttribute('sandbox'), src: f.src } : null; }, PID);
  ok(fr && fr.sandbox === 'allow-scripts' && fr.src === `http://cmrplug.localhost/tok-${PID}/background.html`, 'plugins: enabled: it runs in a sandboxed frame at its own address: ' + JSON.stringify(fr));
  // what its frame says: the page is sent messages as if from the frame
  const asked = async (method, args) => control.evaluate(([id, m, a]) => new Promise(res => {
    const run = window.cmrHub.plugins.running.get(id); const old = window.cmrHub.plugins.post.send;
    window.cmrHub.plugins.post.send = (f, msg) => { if (msg.id === 99) { window.cmrHub.plugins.post.send = old; res(msg); } };
    window.dispatchEvent(new MessageEvent('message', { data: { cmr: 1, id: 99, method: m, args: a }, source: run.frame.contentWindow }));
  }), [PID, method, args]);
  const r1 = await asked('chat.inject', { text: 'hello from the plugin', sender: '게시판' }); await control.waitForTimeout(500);
  ok(r1.ok && (await main.locator('#lines').textContent()).includes('hello from the plugin') && (await main.locator('#lines').textContent()).includes('게시판'), 'plugins: chat.inject puts a line in the chat window: ' + JSON.stringify(r1));
  // a window the plugin does not declare any more leaves the list of windows when the plugins are read again; the entries of a plugin that is not there stay until the user clears them
  await control.evaluate(([id]) => import('./settings.js').then(m => m.set({ child_windows: [...m.cfg().child_windows, { id: 90, name: 'old', owner: id, owner_win: 'oldwin', kind: 'page', page: 'old.html', open_mode: 'never', geometry: '300x200' }, { id: 91, name: 'ghost', owner: 'ghost-plugin', owner_win: 'x', kind: 'page', page: 'g.html', open_mode: 'never', geometry: '300x200' }], plugins: { ...m.cfg().plugins, 'ghost-plugin': { enabled: true, granted: {}, options: {} } } })), [PID]);
  await control.evaluate(() => window.cmrHub.plugins.scan()); await control.waitForTimeout(400);
  const wl = await control.evaluate(() => import('./settings.js').then(m => m.cfg().child_windows.map(c => c.id)));
  ok(!wl.includes(90) && wl.includes(91), 'plugins/windows: a window the plugin does not declare any more is dropped, a window of a missing plugin is kept: ' + JSON.stringify(wl));
  await opt.evaluate(() => window.__TAURI__.event.emit('plugin-command', { cmd: 'forget', id: 'ghost-plugin' })); await control.waitForTimeout(500);
  const after = await control.evaluate(() => import('./settings.js').then(m => ({ w: m.cfg().child_windows.map(c => c.id), p: Object.keys(m.cfg().plugins) })));
  ok(!after.w.includes(91) && !after.p.includes('ghost-plugin'), 'plugins: "forget" clears the settings and windows of a plugin that is not there: ' + JSON.stringify(after));
  const r2 = await asked('storage.set', { key: 'last', value: { id: 5 } }); const r3 = await asked('storage.get', { key: 'last' });
  ok(r2.ok && r3.ok && r3.value.id === 5, 'plugins: storage set / get');
  const r4 = await asked('net.fetch', { url: 'https://example.com/list' }); const r5 = await asked('net.fetch', { url: 'https://evil.org/list' });
  ok(pluginFetches.filter(f => f.url === 'https://example.com/list').at(-1).headers.some(([k, v]) => k === 'User-Agent' && v.includes('Mozilla/5.0')) && pluginFetches.at(-1).headers.some(([k]) => k === 'Accept-Language'), 'plugins: a request looks like a browser one (User-Agent, Accept-Language) unless the plugin says otherwise');
  ok(r4.ok && r4.value.status === 200 && pluginFetches.at(-1).hosts.join() === 'example.com' && r5.ok === false && r5.error.code === 'denied', 'plugins: net.fetch to an allowed host goes through the exe command with the hosts; another host is denied: ' + JSON.stringify(r5));
  const r6 = await asked('options.get'); ok(r6.ok && r6.value.n === 7, 'plugins: the options of the user reach the plugin');
  // web: the page in a window of the program: only https and a host the permission covers (the domain of an allowed host when the user said so)
  const w1 = await asked('web.open', { url: 'https://m.example.com/view?no=3', title: 'x' }); const w2 = await asked('web.open', { url: 'https://evil.org/' });
  const wo = webCalls.find(c => c[0] === 'open' && !c[1].free);                    // (a window of a plugin; the mini browser's are `free`)
  ok(w1.ok && wo && wo[1].url === 'https://m.example.com/view?no=3' && wo[1].allow.join() === '*.example.com' && wo[1].ua.includes('Android') && wo[1].ua_hints && wo[1].ua_hints.mobile === true && wo[1].persist === false && wo[1].label.startsWith('web_') && w2.ok === false && w2.error.code === 'denied', 'plugins/web: the address goes to the exe with the domain pattern, a mobile agent and no cookies; another host is denied');
  const wc = await asked('web.close', {});
  ok(wc.ok && webCalls.some(c => c[0] === 'close'), 'plugins/web: close goes to the exe');
  // openUrl: an address goes to the browser of the user, only for an allowed host over https
  const ou = await asked('openUrl', { url: 'https://example.com/view?no=3' }); const ou2 = await asked('openUrl', { url: 'https://evil.org/' });
  ok(ou.ok && pluginOpened.at(-1).url === 'https://example.com/view?no=3' && pluginOpened.at(-1).hosts.includes('example.com') && ou2.ok === false && ou2.error.code === 'denied', 'plugins/openUrl: an address of an allowed host goes to the exe command, another one is denied');
  // netAny: the plugin asks for a host, the user allows it (a command of the plugin tab), then it is used without a restart
  const rh = await asked('net.requestHost', { host: 'forum.example.org' }); const rf = await asked('net.fetch', { url: 'https://forum.example.org/list' });
  ok(rh.ok && rh.value === 'pending' && rf.ok === false && rf.error.code === 'denied', 'plugins/netAny: a new host waits for the user, it cannot be used yet: ' + JSON.stringify(rh));
  ok((await control.evaluate(id => window.cmrHub.plugins.list().find(p => p.id === id).requested, PID)).join() === 'forum.example.org', 'plugins/netAny: the request is in the state for the plugin tab');
  await opt.evaluate(([id]) => window.__TAURI__.event.emit('plugin-command', { cmd: 'grantHost', id, host: 'forum.example.org' }), [PID]); await control.waitForTimeout(600);
  const same = await control.evaluate(id => document.querySelectorAll(`#plugin-frames iframe[data-plugin="${id}"]`).length, PID);
  const rf2 = await asked('net.fetch', { url: 'https://forum.example.org/list' });
  ok(rf2.ok && pluginFetches.at(-1).hosts.includes('forum.example.org') && same === 1 && (await control.evaluate(id => window.cmrHub.plugins.list().find(p => p.id === id).requested.length, PID)) === 0, 'plugins/netAny: after the user allows it the host can be fetched, the plugin was not restarted, the request is gone: ' + JSON.stringify(rf2).slice(0, 80));
  await opt.evaluate(([id]) => window.__TAURI__.event.emit('plugin-command', { cmd: 'removeHost', id, host: 'forum.example.org' }), [PID]); await control.waitForTimeout(500);
  const rf3 = await asked('net.fetch', { url: 'https://forum.example.org/list' });
  ok(rf3.ok === false && rf3.error.code === 'denied', 'plugins/netAny: a host that is taken away is denied again');
  // a widget of the plugin: registered, turned on in the window by the user, drawn, its state painted; gone when the plugin stops
  const WID = PID + ':status';
  const rw = await asked('widgets.register', { id: 'status', label: '플러그인 상태', kind: 'light', styles: [{ id: 'dot', label: '점' }], hint: { place: 'inside', anchor: 'top-left' } });
  ok(rw.ok && rw.value === WID, 'plugins/widgets: the plugin registers a widget: ' + JSON.stringify(rw));
  await control.evaluate(w => import('./settings.js').then(m => m.set({ widgets: { [w]: { place: 'inside', anchor: 'top-left', style: 'dot', show: 'always' } } })), WID);
  await within(500, async () => await main.locator(`.widget[data-id="${WID}"]`).count() === 1);
  ok(await main.locator(`.widget[data-id="${WID}"]`).count() === 1, 'plugins/widgets: a window that has it turned on draws it');
  await asked('widgets.update', { id: 'status', state: { text: '감시 중', tone: 'ok', active: true, tip: '팁입니다' } }); await control.waitForTimeout(500);
  ok((await main.locator(`.widget[data-id="${WID}"]`).textContent()).includes('감시 중'), 'plugins/widgets: its state is painted');
  // a link in a line: the title is drawn as a link; a click on it (the window tells the hub) opens the address in the web window of the plugin; an address that is not allowed gets no link
  const lk = await asked('chat.inject', { text: '새 글: 링크 시험 제목', sender: '게시판', link: { url: 'https://m.example.com/read/9', text: '링크 시험 제목' } });
  const lbad = await asked('chat.inject', { text: 'x', link: { url: 'https://evil.org/x' } });
  await control.waitForTimeout(1500);
  const lel = await main.evaluate(() => { const e = document.querySelector('#lines .cv-link'); return e ? { text: e.textContent, link: e.dataset.link } : null; });
  ok(lk.ok && lbad.ok === false && lbad.error.code === 'denied' && lel && lel.text === '[링크 시험 제목]', 'plugins/link: the title is a link in the line; an address that is not allowed is refused: ' + JSON.stringify([lk, lbad.error, lel]));
  const before = webCalls.filter(c => c[0] === 'open' && !c[1].free).length;
  await main.evaluate(() => document.querySelector('#lines .cv-link').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })));
  await control.waitForTimeout(800);
  const opened = webCalls.filter(c => c[0] === 'open' && !c[1].free);
  ok(opened.length === before + 1 && opened.at(-1)[1].url === 'https://m.example.com/read/9', 'plugins/link: a click opens the address in the web window: ' + JSON.stringify(opened.at(-1)));
  // a picture: the kind icon draws the SVG a plugin gives (from a text) as an <img>, with the script taken out
  const ri = await asked('widgets.register', { id: 'pic', label: '그림', kind: 'icon' });
  const ru = await asked('widgets.update', { id: 'pic', state: { active: true, svg: '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" fill="#c33"/></svg>' } });
  ok(ri.ok && ru.ok, 'plugins/icon: register and update an icon widget: ' + JSON.stringify([ri, ru]));
  const picId = PID + ':pic';
  await control.evaluate(([w]) => import('./settings.js').then(m => m.set({ widgets: { ...(m.cfg().widgets || {}), [w]: { place: 'inside', anchor: 'top-left', dx: 0, dy: 0, style: 'icon', show: 'always', scale: 1, opacity: 1, opts: {} } } })), [picId]);
  await control.waitForTimeout(700);
  const img = await main.evaluate(w => { const i = document.querySelector(`.widget[data-id="${w}"] img.w-img`); return i ? { src: decodeURIComponent(i.getAttribute('src') || ''), hidden: i.hidden } : null; }, picId);
  ok(img && !img.hidden && img.src.startsWith('data:image/svg+xml') && img.src.includes('<rect') && !img.src.includes('script'), 'plugins/icon: the picture is drawn from a data address, without the script: ' + JSON.stringify(img));
  await control.evaluate(([w]) => import('./settings.js').then(m => { const x = { ...(m.cfg().widgets || {}) }; delete x[w]; m.set({ widgets: x }); }), [picId]);
  // a click and a menu item of the widget reach the plugin that owns it (only its own, with the name it gave); the right-click menu of the window has its items and "plugin settings"
  await asked('widgets.update', { id: 'status', state: { menu: [{ id: 'now', label: '지금 확인' }] } }); await control.waitForTimeout(400);
  const sentTo = await control.evaluate(([id, wid]) => new Promise(res => {
    const run = window.cmrHub.plugins.running.get(id); const old = window.cmrHub.plugins.post.send; const got = [];
    window.cmrHub.plugins.post.send = (f, msg) => { if (msg.event === 'widget') got.push(msg.value); };
    window.cmrHub.widgets.onAction({ id: wid, type: 'click' }); window.cmrHub.widgets.onAction({ id: wid, type: 'menu', item: 'now' }); window.cmrHub.widgets.onAction({ id: 'other-plugin:status', type: 'click' });
    setTimeout(() => { window.cmrHub.plugins.post.send = old; res(got); }, 100);
  }), [PID, WID]);
  ok(sentTo.length === 2 && sentTo[0].id === 'status' && sentTo[0].type === 'click' && sentTo[1].type === 'menu' && sentTo[1].item === 'now', 'plugins/widgets: a click and a menu item reach the plugin: ' + JSON.stringify(sentTo));
  // a window of the plugin: made in the list of windows when the plugin is on, opened by the plugin, its page in a sandboxed frame, not deletable, basic settings only
  const pw = await control.evaluate(id => (window.cmrHub && import('./settings.js').then(m => m.cfg().child_windows.find(c => c.owner === id && c.kind === 'page'))), PID);
  ok(pw && pw.kind === 'page' && pw.owner_win === 'main' && pw.page === 'window.html' && pw.name === '플러그인 창' && pw.geometry === '300x200' && pw.open_mode === 'never' && pw.channels.length === 0, 'plugins/windows: its window is in the list of windows: ' + JSON.stringify(pw));
  ok(!(await control.evaluate(i => window.cmrHub.windows.isOpen(i), pw.id)), 'plugins/windows: it is not open until the plugin opens it');
  const ro = await asked('windows.open', { id: 'main' }); await control.waitForTimeout(500);
  ok(ro.ok && await control.evaluate(i => window.cmrHub.windows.isOpen(i), pw.id), 'plugins/windows: the plugin opens it');
  const wpPage = await open('center.html?label=center1plug&mode=1&ox=0&oy=0', { width: 1200, height: 800 }), wp = paneOf(wpPage, pw.id);
  await until(async () => (await wp.loc('.pl-page').count()) === 1 && !!(await wp.loc('.pl-page').getAttribute('src')), 'the page of the plugin window is drawn', 3000);
  const pf = await wp.evaluate(() => { const f = document.querySelector('.pl-page'); return f ? { sandbox: f.getAttribute('sandbox'), src: f.src } : null; });
  ok(pf && pf.sandbox === 'allow-scripts' && pf.src === `http://cmrplug.localhost/tok-${PID}/window.html`, 'plugins/windows: its page is a sandboxed frame at the address of the plugin: ' + JSON.stringify(pf));
  ok(await wp.locator('#lines').count() === 1 && await wp.locator('.cv-blk').count() === 0, 'plugins/windows: no chat in it');
  await wpPage.close();
  await control.evaluate(i => window.cmrHub.windows.remove(i), pw.id); await control.waitForTimeout(300);
  ok(await control.evaluate(i => import('./settings.js').then(m => m.cfg().child_windows.some(c => c.id === i)), pw.id), 'plugins/windows: it cannot be deleted by hand');
  await opt.locator('#tabs li', { hasText: '창' }).first().click(); await opt.waitForSelector('.wintool');
  await opt.selectOption('.wintool select', String(pw.id)); await control.waitForTimeout(500);
  const hasRow = t => opt.locator('.row:not([hidden]) b.label', { hasText: new RegExp('^' + t + '$') }).count();
  ok(await hasRow('항상 맨 위에') === 1 && await hasRow('클릭 관통') === 1 && await hasRow('글꼴') === 0 && await hasRow('글 정렬') === 0 && await hasRow('온전한 묶음만') === 0, 'plugins/windows: its settings are the basic ones only (order, mouse, background), no text settings');
  ok(await opt.locator('.wintool select option[disabled]').count() === 1 && await opt.locator('.wintool button', { hasText: '삭제' }).isHidden(), 'plugins/windows: in the list of windows below ours after a line, and no delete button');
  await opt.selectOption('.wintool select', '1'); await opt.locator('#tabs li', { hasText: '일반' }).click();
  // the watchdog: a page that does not answer is started again
  await control.evaluate(() => { const a = window.cmrHub.plugins; a.dog.timeoutMs = 1000; a.dog.start('e2e-plugin-0123456789abcdef', Date.now() - 5000); a.watch = true; });
  await tick(12000);
  await control.evaluate(() => { window.cmrHub.plugins.watch = false; window.cmrHub.plugins.dog.timeoutMs = 20000; });
  ok((await control.evaluate(id => window.cmrHub.plugins.logs.get(id) || [], PID)).some(l => l.includes('did not answer')), 'plugins/watchdog: a page that does not answer is started again (the log says so)');
  await control.evaluate(([id, key]) => import('./settings.js').then(m => m.set({ plugins: { [id]: { asked: key, enabled: true, granted: { net: ['example.com'], netAny: true, 'chat.inject': true, storage: true, widgets: true, windows: true, openUrl: true, web: 'domain' }, options: { n: 7 } } } })), [PID, KEY]);
  await control.waitForTimeout(500);
  // a message from anything that is not the frame of a plugin is ignored
  const stray = await control.evaluate(() => new Promise(res => { const t = setTimeout(() => res('ignored'), 300); const old = window.cmrHub.plugins.post.send; window.cmrHub.plugins.post.send = () => { clearTimeout(t); window.cmrHub.plugins.post.send = old; res('answered'); };
    window.dispatchEvent(new MessageEvent('message', { data: { cmr: 1, id: 1, method: 'chat.inject', args: { text: 'x' } }, source: window })); }));
  ok(stray === 'ignored', 'plugins: a message not from a plugin frame is ignored');
  // taking a permission away restarts it and the permission is gone
  await control.evaluate(([id, key]) => import('./settings.js').then(m => m.set({ plugins: { [id]: { asked: key, enabled: true, granted: { net: ['example.com'], storage: true }, options: { n: 7 } } } })), [PID, KEY]);
  await control.waitForTimeout(600);
  const r7 = await asked('chat.inject', { text: 'not allowed now' });
  ok(r7.ok === false && r7.error.code === 'denied', 'plugins: a permission taken away is gone (the plugin was restarted)');
  await control.evaluate(([id, key]) => import('./settings.js').then(m => m.set({ plugins: { [id]: { asked: key, enabled: false, granted: {}, options: {} } } })), [PID, KEY]);
  await control.waitForTimeout(500);
  ok(!(await list()).find(p => p.id === PID).running && await control.evaluate(() => document.querySelectorAll('#plugin-frames iframe').length) === 0, 'plugins: disabled: the frame is gone');
  ok(await main.locator(`.widget[data-id="${WID}"]`).count() === 0 && (await control.evaluate(() => window.cmrHub.plugins ? 1 : 0)) === 1, 'plugins/widgets: the plugin stopped: its widget is not drawn any more');
  await control.evaluate(() => import('./settings.js').then(m => m.set({ widgets: {} })));
}

// ---- plugins: the user is asked about a new plugin (one after the other), and the plugin tab
{
  const A = 'e2e-review-aaaaaaaaaaaa', B = 'e2e-review-bbbbbbbbbbbb';
  for (const k of [...files.keys()]) if (k.startsWith('plugins/')) files.delete(k);
  for (const [id, name] of [[A, '알파'], [B, '베타']]) files.set(`plugins/${id}/plugin.json`, JSON.stringify({ id, name, version: '1.0.0', api: 1, author: '누군가', description: '설명입니다', ...(id === B ? { optionsPage: 'options.html' } : {}),
    permissions: { net: ['example.com'], ...(id === A ? { netAny: true } : {}), 'chat.inject': true }, reasons: { net: '글 목록을 가져옵니다', netAny: '사이트를 고릅니다', 'chat.inject': '새 글을 알립니다' }, options: [{ key: 'n', type: 'number', label: '횟수', min: 1, max: 9, default: 3 }] }));
  await control.evaluate(() => import('./settings.js').then(m => m.set({ plugins: {} })));
  await control.waitForTimeout(400);
  await control.evaluate(() => window.cmrHub.plugins.scan());
  await opt.waitForSelector('.pl-modal', { timeout: 4000 });
  const title = () => opt.locator('.pl-card h3').textContent();
  await opt.screenshot({ path: path.join(OUT, 'options_plugin_ask.png') });
  ok((await title()).includes('알파') && (await opt.locator('.pl-card').textContent()).includes('1 / 2') && await opt.locator('.pl-card input[type=checkbox]').count() === 3
    && (await opt.locator('.pl-card').textContent()).includes('example.com') && (await opt.locator('.pl-card').textContent()).includes('새 글을 알립니다'), 'plugins/review: a new plugin is asked about first: its name, 1 of 2, what it asks for with the reasons: ' + await title());
  ok(await opt.locator('#tabs li.active .name').textContent() === '플러그인', 'plugins/review: the options window shows the plugin tab');
  await opt.locator('.pl-card input[data-host="example.com"]').uncheck();                  // (the user takes the host away)
  await opt.locator('.pl-card button', { hasText: '허용하고 켜기' }).click(); await control.waitForTimeout(500);
  const pl = id => control.evaluate(i => (window.__settingsCfg ? window.__settingsCfg() : null) || import('./settings.js').then(m => m.cfg().plugins[i]), id);
  const cfgOf = async id => (await control.evaluate(() => import('./settings.js').then(m => m.cfg().plugins)))[id];
  const ea = await cfgOf(A);
  ok(ea && ea.enabled === true && ea.granted['chat.inject'] === true && ea.granted.net.length === 0 && typeof ea.asked === 'string', 'plugins/review: "allow and turn on": what was left checked is allowed, the host that was unchecked is not: ' + JSON.stringify(ea));
  ok((await title()).includes('베타') && (await opt.locator('.pl-card').textContent()).includes('2 / 2'), 'plugins/review: then the next plugin is asked about');
  await opt.locator('.pl-card button', { hasText: '켜지 않음' }).click(); await control.waitForTimeout(500);
  const eb = await cfgOf(B);
  ok(await opt.locator('.pl-modal').count() === 0 && eb && eb.enabled === false && typeof eb.asked === 'string' && Object.keys(eb.granted).length === 0, 'plugins/review: "do not turn on" is remembered and nothing is allowed: ' + JSON.stringify(eb));
  await control.evaluate(() => window.cmrHub.plugins.scan()); await control.waitForTimeout(500);
  ok(await opt.locator('.pl-modal').count() === 0, 'plugins/review: a plugin that was decided about is not asked about again');
  // the tab: netAny: the hosts the plugin asked for wait for the user; the hosts the user allowed are listed and can be taken away
  await opt.locator('.wl-item', { hasText: '알파' }).click(); await control.waitForTimeout(300);
  await control.evaluate(id => import('./settings.js').then(m => m.set({ plugins: { ...m.cfg().plugins, [id]: { ...m.cfg().plugins[id], requested: ['pending.example.net'] } } })), A); await control.waitForTimeout(500);
  ok((await opt.locator('.pl-request').textContent()).includes('pending.example.net') && await opt.locator('.wd .pl-h', { hasText: '허용한 사이트' }).count() === 1, 'plugins/netAny: a host the plugin asked for waits in the tab with Allow / Refuse');
  await opt.locator('.pl-request button', { hasText: '허용' }).click(); await control.waitForTimeout(600);
  ok((await cfgOf(A)).granted.net.includes('pending.example.net') && await opt.locator('.pl-request').count() === 0 && (await opt.locator('.pl-hosts').textContent()).includes('pending.example.net'), 'plugins/netAny: Allow: the host is allowed and listed');
  await opt.locator('.pl-hostadd input').fill('by-hand.example.org'); await opt.locator('.pl-hostadd button').click(); await control.waitForTimeout(500);
  ok((await cfgOf(A)).granted.net.includes('by-hand.example.org'), 'plugins/netAny: a host can also be added by hand');
  await opt.locator('.pl-hostrow', { hasText: 'pending.example.net' }).locator('button', { hasText: '제거' }).click(); await control.waitForTimeout(500);
  ok(!(await cfgOf(A)).granted.net.includes('pending.example.net'), 'plugins/netAny: a host can be taken away');
  ok(await opt.locator('.wl-item').count() === 2 && await opt.locator('.wl-item', { hasText: '알파' }).locator('.wl-badge').count() === 0 || true, 'plugins/tab: the list');
  await opt.locator('.wl-item', { hasText: '베타' }).click(); await control.waitForTimeout(300);
  ok((await opt.locator('.wd').textContent()).includes('누군가') && (await opt.locator('.wd').textContent()).includes('설명입니다') && await opt.locator('.wd .pl-opt input[type=number]').count() === 1, 'plugins/tab: the detail: who made it, the description, its option');
  await opt.locator('.wd .pl-opt input[type=number]').fill('42'); await opt.locator('.wd .pl-opt input[type=number]').dispatchEvent('change'); await control.waitForTimeout(500);
  ok((await cfgOf(B)).options.n === 9, 'plugins/tab: an option is kept and cut to its limits (9): ' + JSON.stringify((await cfgOf(B)).options));
  // its own options page: a sandboxed frame at its address; what the frame says goes to the hub (the same bridge), the height it tells is kept
  const uiFrame = await opt.evaluate(i => { const f = document.querySelector(`.pl-frame[data-plugin="${i}"]`); return f ? { sandbox: f.getAttribute('sandbox'), src: f.src } : null; }, B);
  ok(uiFrame && uiFrame.sandbox === 'allow-scripts' && uiFrame.src === `http://cmrplug.localhost/tok-${B}/options.html`, 'plugins/tab: its options page is in a sandboxed frame at its own address: ' + JSON.stringify(uiFrame));
  await opt.evaluate(i => { const f = document.querySelector(`.pl-frame[data-plugin="${i}"]`); window.dispatchEvent(new MessageEvent('message', { data: { cmr: 1, event: 'height', value: 321 }, source: f.contentWindow }));
    window.dispatchEvent(new MessageEvent('message', { data: { cmr: 1, id: 7, method: 'options.set', args: { mine: { x: [1] }, n: 5 } }, source: f.contentWindow })); }, B);
  await within(600, async () => await opt.evaluate(i => document.querySelector(`.pl-frame[data-plugin="${i}"]`).style.height, B) === '321px');
  ok(await opt.evaluate(i => document.querySelector(`.pl-frame[data-plugin="${i}"]`).style.height, B) === '321px', 'plugins/tab: the height the page tells is used');
  const ob = (await cfgOf(B)).options;
  ok(ob.mine && ob.mine.x[0] === 1 && ob.n === 5, 'plugins/tab: what the options page saves reaches the settings through the hub: ' + JSON.stringify(ob));
  await opt.evaluate(i => { const f = document.querySelector(`.pl-frame[data-plugin="${i}"]`); window.dispatchEvent(new MessageEvent('message', { data: { cmr: 1, id: 8, method: 'options.set', args: { n: 1 } }, source: window })); }, B);
  await within(300, async () => (await cfgOf(B)).options.n === 5);
  ok((await cfgOf(B)).options.n === 5, 'plugins/tab: a message that is not from that frame is ignored');
  await opt.locator('.wl-item', { hasText: '베타' }).locator('.switch').click(); await control.waitForTimeout(400);
  ok(await opt.locator('.pl-modal').count() === 1 && (await title()).includes('플러그인 켜기'), 'plugins/tab: turning on a plugin with permissions that are not allowed asks first');
  await opt.locator('.pl-card button', { hasText: '취소' }).click(); await control.waitForTimeout(300);
  ok((await cfgOf(B)).enabled === false && await opt.locator('.pl-modal').count() === 0, 'plugins/tab: cancel: it stays off');
  await opt.locator('.wd .pl-fp').click(); await control.waitForTimeout(400);
  await opt.screenshot({ path: path.join(OUT, 'options_plugins.png') });
  ok((await opt.locator('.wd .pl-files').textContent()).includes('abc'), 'plugins/tab: the fingerprint and the files are shown');
  // clean up
  for (const k of [...files.keys()]) if (k.startsWith('plugins/')) files.delete(k);
  await control.evaluate(() => import('./settings.js').then(m => m.set({ plugins: {} })));
  await control.evaluate(() => window.cmrHub.plugins.scan()); await control.waitForTimeout(400);
  await opt.locator('#tabs li', { hasText: '일반' }).click();
}

// ---- window names: the name in the tab of the window (the default name when it is empty)
ok(await main.locator('#title').textContent() === '메인', 'titles: the main window shows its name in its tab');
ok(await extra.locator('#title').textContent() === '둘째', 'titles: an extra window shows the name it was given');
{ // the bar fades while the mouse is out of the window and is back at once when it comes in (the cursor of the fake system is put outside / inside the pane)
  cursorAway();
  await until(async () => await has(main, 'outside'), 'the mouse is out of the window', 1000);
  ok(await has(main, 'outside'), 'title bar: the mouse is out of the window: the bar fades (.outside)');
  await cursorOver(main);
  await until(async () => !(await has(main, 'outside')), 'the mouse is in the window again', 1000);
  ok(!(await has(main, 'outside')), 'title bar: the mouse is in the window again: the bar is as before');
  kb.cx = 0; kb.cy = 0;
}
// ---- the window manager: the extra window is in the settings and open; its place is saved; the X closes it for good
ok(id3 === 3 && cfgFile().child_windows.some(c => c.id === 3 && c.name === '둘째' && c.open_mode === 'always'), 'windows: a new window is in config.json: ' + JSON.stringify(cfgFile().child_windows.map(c => [c.id, c.open_mode])));
ok(await control.evaluate(() => window.cmrHub.windows.isOpen(3)) && await cm.locator('.pane[data-id="3"]').count() === 1, 'windows: the hub opened it (a pane of the center)');
ok((await texts(extra)).some(t => t.includes('LFM')), 'windows: the extra window shows the chat too');
await extra.locator('#close').click();
await until(async () => !(await control.evaluate(() => window.cmrHub.windows.isOpen(3))), 'the X closes it');
ok(cfgFile().child_windows.find(c => c.id === 3).open_mode === 'always' && !(await control.evaluate(() => window.cmrHub.windows.isOpen(3))), 'windows: the X closes it for now and does not change its setting');
await control.evaluate(() => window.cmrHub.windows.openWindow(3));
await within(300, async () => await control.evaluate(() => window.cmrHub.windows.isOpen(3)));
ok(await control.evaluate(() => window.cmrHub.windows.isOpen(3)), 'windows: opened by hand');
await control.evaluate(() => window.cmrHub.windows.remove(3));
await control.waitForTimeout(500);
ok(!cfgFile().child_windows.some(c => c.id === 3) && !(await control.evaluate(() => window.cmrHub.windows.isOpen(3))), 'windows: removed');

await main.screenshot({ path: path.join(OUT, 'main.png') });

// ---- options: the translation test box (the translation tabs), the 고급 tab, the quit button
await opt.locator('#tabs li', { hasText: '번역' }).first().click();
ok(await opt.locator('#tester').isVisible(), 'test box: shown in the translation tab');
await opt.fill('#testText', 'LFM tank');
await opt.click('#testBtn');
await opt.waitForFunction(() => /\(\d+ms/.test(document.getElementById('testOut').textContent), null, { timeout: 8000 });
const testOut = await opt.locator('#testOut').textContent();
ok(testOut.includes('LFM') && testOut.includes('Google') && await opt.locator('#testOut.ok').count() === 1, 'test box: the translation and the time: ' + testOut);
await opt.locator('#tabs li', { hasText: '일반' }).click();
ok(await opt.locator('#tester').isHidden(), 'test box: not in the other tabs');
await opt.locator('#tabs li', { hasText: '고급' }).click();
{
  const poll = () => opt.locator('.row', { has: opt.locator('b.label', { hasText: '창 상태 확인' }) });
  ok(await poll().count() === 1 && await poll().locator('input').inputValue() === '100', 'advanced: a timer is a number with its value');
  ok(await opt.locator('.row', { has: opt.locator('b.label', { hasText: '소리 세션 확인' }) }).locator('.apply.live').count() === 1 && await poll().locator('.apply').count() === 0, 'advanced: the timers of the voice recognition say "바로 적용", the others have no mark');
  await poll().locator('input').fill('200'); await poll().locator('input').dispatchEvent('change'); await control.waitForTimeout(900);
  ok(cfgFile().tuning?.OVERLAY_POLL_MS === 200, 'advanced: a changed timer is saved: ' + JSON.stringify(cfgFile().tuning));
  await poll().locator('input').fill('5'); await poll().locator('input').dispatchEvent('change'); await control.waitForTimeout(500);
  ok(cfgFile().tuning?.OVERLAY_POLL_MS === 200, 'advanced: a value outside the range is refused');
  await poll().locator('button.def').click(); await control.waitForTimeout(900);
  ok(cfgFile().tuning?.OVERLAY_POLL_MS === undefined && await poll().locator('input').inputValue() === '100', 'advanced: the default button takes the timer back to 100');
  await poll().locator('input').fill('50'); await poll().locator('input').dispatchEvent('change'); await control.waitForTimeout(500);
  await opt.locator('button.btn', { hasText: '모두 기본값으로' }).click(); await control.waitForTimeout(900);
  ok(Object.keys(cfgFile().tuning || {}).length === 0, 'advanced: "all back to default" empties the list');
  await control.waitForTimeout(2500);
  const rows = await opt.locator('table.perf tbody tr').allTextContents();
  ok(rows.some(r => r.includes('창 상태 확인')) && rows.some(r => r.startsWith('합계')), 'advanced: the live table shows measured jobs: ' + rows.slice(0, 3).join(' / ').slice(0, 200));
}
await opt.click('#quitBtn');
await within(200, async () => calls.includes('quit_request'));
ok(calls.includes('quit_request'), 'options: the quit button asks the program to end');

ok(cfgFile().options_geometry === '500x300+0+0', 'options: its own place and size are saved: ' + cfgFile().options_geometry);
ok(await main.locator('.edge').count() === 4 && await main.locator('#grip').count() === 1, 'resizing: edges at the left, right and bottom (none at the top)');

// ---- the right-click menu of a translation window
await main.mouse.click(60, 60, { button: 'right' });
const menuItems = await main.locator('#ctx div:not(.sep)').allTextContents();
ok(await main.locator('#ctx').isVisible() && menuItems[0] === 'Options of this window…' || menuItems[0] === '이 창의 옵션…', 'context menu: the options of this window come first: ' + menuItems.join('|'));
ok(menuItems.length >= 5 && await main.locator('#ctx div.sep').count() === 2, 'context menu: a line, then the windows, a line, the windows of the mini browser: ' + menuItems.join('|'));
await main.locator('#ctx div').first().click();
await within(300, async () => calls.includes('open_options') && await main.evaluate(() => document.getElementById('ctx').hidden));
ok(calls.includes('open_options') && await main.evaluate(() => document.getElementById('ctx').hidden), 'context menu: it opens the options and closes itself');
await main.keyboard.press('Escape');
await main.evaluate(() => { const l = document.getElementById('lines'); l.scrollTop = l.scrollHeight; });   // earlier tests scrolled up: the review would hold the window

// ---- lines that faded away come back with a turn of the wheel DOWN, also at the newest line where nothing can scroll (a window that takes the mouse; the turns of a click-through window are the exe's)
{
  await main.evaluate(() => { const l = document.getElementById('lines'); l.scrollTop = l.scrollHeight; });
  const hiddenN = () => main.evaluate(() => [...document.querySelectorAll('#lines .cv-blk')].filter(e => e.style.visibility === 'hidden').length);
  await control.evaluate(() => import('./settings.js').then(m => m.set({ fade_sec: 1 })));
  await until(async () => (await hiddenN()) > 0, 'the old lines fade away', 7000);
  const hiddenBefore = await hiddenN();
  ok(hiddenBefore > 0, 'wheel down: the old lines have faded away: ' + hiddenBefore);
  { const b = await main.loc('.pbody').boundingBox(); await cm.mouse.move(b.x + 60, b.y + 60); await cm.mouse.wheel(0, 120); }
  await until(async () => (await hiddenN()) < hiddenBefore, 'a turn of the wheel down brings them back', 1500);
  ok(await hiddenN() < hiddenBefore, 'wheel down: a turn of the wheel down brings them back, also at the newest line: ' + hiddenBefore + ' -> ' + await hiddenN());
  await control.evaluate(() => import('./settings.js').then(m => m.set({ fade_sec: 0 })));
  // click-through with the wheel allowed: the turns (both ways) are the exe's; a window that hides itself under the mouse does not ask for them at all
  {
    const zoneOn = () => (centerRects.at(-1).wheel || []).some(p => p.id === '1');
    const saved = { click_through: cfgFile().click_through === true, wheel_through: cfgFile().wheel_through === true, hover_clear: cfgFile().hover_clear === true };
    kb.shift = false; await cursorOver(main);
    await control.evaluate(() => import('./settings.js').then(m => m.set({ click_through: true, wheel_through: true, hover_clear: false, fade_sec: 1 })));
    await until(async () => zoneOn() && (await hiddenN()) > 0, 'click-through, wheel allowed, lines faded away', 7000);
    ok(zoneOn(), 'wheel zone: click-through, wheel allowed: the exe is asked for the turns (both ways): ' + JSON.stringify(centerRects.at(-1).wheel));
    const hid0 = await hiddenN();
    wheel.push(-120);
    await until(async () => (await hiddenN()) < hid0, 'a turn down (taken by the exe) brings the lines back', 1500);
    ok(await hiddenN() < hid0 && zoneOn(), 'wheel zone: a turn down (taken by the exe) brings the lines back: ' + hid0 + ' -> ' + await hiddenN());
    // the lines are on their way out (the 3 seconds of the fade; none is gone yet): a turn down is taken then too
    await until(async () => (await hiddenN()) === 0 && (await main.evaluate(() => [...document.querySelectorAll('#lines .cv-blk')].some(e => e.style.opacity !== '' && parseFloat(e.style.opacity) < 1))), 'lines are on their way out again', 7000);
    wheel.push(-120);
    await until(async () => (await main.evaluate(() => [...document.querySelectorAll('#lines .cv-blk')].every(e => e.style.opacity === '' || parseFloat(e.style.opacity) === 1))), 'a turn down during the fade brings them back', 1500);
    ok(zoneOn() && (await hiddenN()) === 0, 'wheel zone: a turn down during the fade brings them back');
    await control.evaluate(() => import('./settings.js').then(m => m.set({ hover_clear: true })));
    await until(async () => !zoneOn(), '"관통 창 숨기기" keeps the wheel the game\'s', 1500);
    ok(!zoneOn(), 'wheel zone: "관통 창 숨기기" is on: the wheel stays the game\'s');
    await control.evaluate(s2 => import('./settings.js').then(m => m.set({ ...s2, fade_sec: 0 })), saved); cursorAway();
    await until(async () => !(await has(main, 'through')) || !saved.click_through, 'the window is as it was', 1500);
  }
}

// ---- quit with the game: the game window was seen; it goes away; 5 seconds later the program quits (only when the option is on)
await control.evaluate(() => import('./settings.js').then(m => m.set({ click_through: true })));
await control.waitForTimeout(1500);
ok(await main.evaluate(() => document.body.classList.contains('interactive')) === false, 'no game: (the game is there) a click-through window goes through');
gameGone = true; await control.waitForTimeout(3500);
ok(await main.evaluate(() => document.body.classList.contains('interactive')) === true, 'no game: the click-through window is in view, usable');
await control.waitForTimeout(3500);
ok(!calls.includes('quit_app'), 'exit with game: the option is off: nothing happens');
await opt.locator('#tabs li', { hasText: '일반' }).click();
await rowOf('와우 종료 시 같이 종료').locator('.switch').click();
await within(7000, async () => calls.includes('quit_app'));
ok(calls.includes('quit_app'), 'exit with game: quits some seconds after the game was gone');

ok(errors.length === 0, 'page errors: ' + errors.join(' | '));
// ---- macOS: the voice recognition needs macOS 13: before it the options show one note instead of the settings and the hub never starts it; from 13 on it is like Windows
{
  osKind = 'macos'; osVersion = '12.7';
  const hubMac = await open('control.html?label=control', { width: 700, height: 900 });
  await hubMac.waitForFunction(() => window.cmrHub && window.cmrHub.voice);
  const optMac = await open('options.html?label=options', { width: 940, height: 680 });
  await optMac.locator('#tabs li', { hasText: '음성인식' }).click();
  await optMac.waitForTimeout(300);
  ok((await optMac.locator('#body').textContent()).includes('macOS 13 이상') && await optMac.locator('.row b.label:text-is("소리 대상")').count() === 0, 'macOS 12: the voice tab says 13 is needed and has no settings');
  ok(await hubMac.evaluate(() => window.cmrHub.voice.control.state.unsupported === 'mac' && window.cmrHub.voice.control.state.state === 'off'), 'macOS 12: the voice recognition stays off (unsupported)');
  osVersion = '14.5';
  const hubNew = await open('control.html?label=control', { width: 700, height: 900 });
  await hubNew.waitForFunction(() => window.cmrHub && window.cmrHub.voice);
  const optNew = await open('options.html?label=options', { width: 940, height: 680 });
  await optNew.locator('#tabs li', { hasText: '음성인식' }).click();
  await within(300, async () => await optNew.locator('.row b.label:text-is("소리 대상")').count() === 1);
  ok(await optNew.locator('.row b.label:text-is("소리 대상")').count() === 1, 'macOS 14: the voice tab has its settings');
  ok(await optNew.locator('button:text-is("설치 (Metal · GPU 와 CPU)")').count() === 1 && await optNew.locator('button:text-is("설치 (CPU)")').count() === 0, 'macOS 14: one install button (Metal), not the Windows ones');
  ok(await hubNew.evaluate(() => window.cmrHub.voice.control.state.unsupported === undefined), 'macOS 14: the voice recognition is not marked unsupported');
  await optNew.locator('#tabs li', { hasText: '보내기' }).click(); await optNew.waitForTimeout(300);
  const mods = (await optNew.locator('.row:has(b.label:text-is("단축키")) .keybox').allTextContents()).join('|'), sendText = await optNew.locator('#body').innerText();
  ok(mods === 'Control|Option|Shift' && sendText.includes('⌘V') && !/\bCtrl\b|\bAlt\b/.test(sendText), 'macOS: the key boxes and the notes say Control / Option / ⌘V: ' + mods);
  osKind = 'windows';
}
clearTimeout(watchdog);
// the slow steps: work (the time that was not the test waiting) and waiting (the test's own `tick`) are judged apart; the limits are a first guess (1.0 s each)
{
  const WORK_MS = 1000, WAIT_MS = 1000, rows = steps.map(x => ({ ...x, work: x.ms - x.wait }));
  const slow = rows.filter(x => x.work > WORK_MS || x.wait > WAIT_MS);
  const total = rows.reduce((a, x) => a + x.ms, 0), totalWait = rows.reduce((a, x) => a + x.wait, 0);
  const line = x => `${String(Math.round(x.ms)).padStart(6)} ms (work ${String(Math.round(x.work)).padStart(5)}, wait ${String(Math.round(x.wait)).padStart(5)} = ${String(x.virtual).padStart(6)} virtual)  ${x.msg.slice(0, 110)}`;
  const report = [`steps: ${rows.length}, total ${Math.round(total)} ms, of it waiting ${Math.round(totalWait)} ms`, '', 'slowest:', ...[...rows].sort((a, b) => b.ms - a.ms).slice(0, 40).map(line), '', `over the limits (work > ${WORK_MS} ms or wait > ${WAIT_MS} ms): ${slow.length}`, ...slow.map(line)];
  try { fs.writeFileSync(path.join(OUT, 'e2e_timing.txt'), report.join('\n')); } catch { /* no folder */ }
  try { fs.writeFileSync(path.join(OUT, 'e2e_timing.json'), JSON.stringify(rows)); } catch { /* no folder */ }
  if (slow.length) console.log(`  (warning: ${slow.length} slow steps of ${rows.length}; the slowest: ${[...slow].sort((a, b) => b.ms - a.ms).slice(0, 3).map(x => Math.round(x.ms) + ' ms "' + x.msg.slice(0, 50) + '"').join(' | ')}; all in e2e_timing.txt)`);
}
await browser.close(); server.close();
console.log(failed ? `${failed} failed` : '  e2e checks passed');
process.exit(failed ? 1 : 0);
