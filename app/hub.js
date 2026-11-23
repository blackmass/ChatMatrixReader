// The control window is the HUB of the program: it alone owns config.json, the translation queue (so Google's spacing and pauses
// exist once) and the pipeline. It turns what it reads into events and sends them to the translation windows ('feed'), which draw
// them (center.js). Today the lines are fake (the test window's button); later the capture loop feeds the same pipeline.
import { files } from './fs.js';
import { transport } from './transport.js';
import * as settings from './settings.js';
import { log } from './core/log.js';
import { Glossary } from './core/glossary.js';
import { startI18n } from './i18n_host.js';
import { tr } from './core/i18n.js';
import { startUpkeep } from './upkeep_host.js';
import * as version from './core/version.js';
import * as updatecheck from './core/updatecheck.js';
import { Usage } from './core/usage.js';
import { Translator, makeHttp, googleKey } from './core/translate.js';
import { TranslationService } from './core/translation_service.js';
import { Pipeline } from './core/pipeline.js';
import * as winconf from './core/winconf.js';
import { startWindows } from './winmanager.js';
import { startCapture } from './capture_host.js';
import { startSend } from './send_host.js';
import { startTray } from './tray_host.js';
import { startVoice } from './voice_host.js';
import { startWidgets } from './widgets/hub.js';
import { startPlugins } from './plugin_host.js';
import { startBrowsers } from './browser_host.js';
import { makeInstaller, makeBackend, makeBencher } from './voice_install.js';
import { ExitWatch } from './core/exitwatch.js';
import { every } from './core/timings.js';
import { report } from './core/perf.js';

const { emit, listen } = window.__TAURI__.event;
const invoke = window.__TAURI__.core.invoke;

// ---- the log file lives in the program folder (logs/), nothing goes anywhere else
const pad = n => String(n).padStart(2, '0');
log.sink = (level, msg) => {
  const d = new Date();
  files.append('logs/chatmatrix.log', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${level} ${msg}\n`).catch(() => {});
};

const cfg = await settings.load();
await startI18n(settings);
const glossary = new Glossary(files);
glossary.ensureDefault(cfg.glossary_file);                      // Glossary.txt from Glossary.sample.txt on the first start
const translator = new Translator({ http: makeHttp(transport), glossary, usage: new Usage(files) });

// ---- events for the windows (kept a while, so a window opened later can catch up)
let seq = 0;
const history = [];
function publish(events) {
  for (const event of events) {
    if (event.type === 'Status') { hubLog(event.text, true); continue; }
    const item = { seq: ++seq, event };
    history.push(item);
    if (history.length > 400) history.shift();
    emit('feed', item);
  }
}
const hubLog = (text, bad) => window.cmrLog?.(text, bad);

let pipeline, windows;
const service = new TranslationService({
  translator, glossary, getCfg: () => settings.cfg(),
  onResult: (id, result, err) => publish(pipeline.onTranslation(id, result, err)),
});
pipeline = new Pipeline({ getCfg: () => settings.cfg(), translations: service, getWindows: () => settings.cfg().child_windows.filter(c => windows && windows.isOpen(c.id)) });

listen('feed-hello', ev => emit('feed-replay', { label: ev.payload.label, events: history }));
listen('rpc-translate', async ev => {                           // other windows (the send box) ask for a translation
  const { id, text, to } = ev.payload;
  try { emit('rpc-result', { id, text: await translator.translate({ ...settings.cfg(), translator: 'google', google_free: true, target_lang: to, glossary_google: to === 'ko' }, text) }); }
  catch (e) { emit('rpc-result', { id, error: String(e?.message || e) }); }
});

// the translation test of the options window: the translation method as it is set now (glossary, prompt ...), and how long it took
listen('rpc-test', async ev => {
  const { id, text } = ev.payload;
  const cfg = { ...settings.cfg() }, t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const who = cfg.translator === 'google' ? 'Google' + (googleKey(cfg) ? ' (API Key)' : '')
    : cfg.translator === 'custom' ? (cfg.custom_preset || cfg.custom_url || 'HTTP') : (cfg.api_model || cfg.api_url || 'AI');
  try {
    if ((cfg.translator ?? 'none') === 'none') throw new Error(tr('번역 방식이 꺼져 있습니다'));
    emit('rpc-test-result', { id, text: await translator.translate(cfg, text), ms: ms(), who });
  } catch (e) { emit('rpc-test-result', { id, error: String(e?.message || e).slice(0, 160), ms: ms(), who }); }
});

// the model list of the AI server (the model name box of the options asks when it gets the focus): from the address and key as they are set now
listen('rpc-models', async ev => {
  const { id } = ev.payload;
  try { emit('rpc-models-result', { id, models: await translator.listModels(settings.cfg()) }); }
  catch (e) { emit('rpc-models-result', { id, error: String((e && e.message) || e).slice(0, 160), kind: (e && e.kind) || 'connect' }); }
});

// ---- fake chat (until the capture loop is connected)
const CODES = { party: 'P', guild: 'G', whisper: 'W', say: 'S', sys: '!SY' };
let lineId = 0;
export function fakeLine({ channel, name, text }) {
  publish(pipeline.onLine({ channel: CODES[channel] || channel, id: ++lineId, sender: channel === 'sys' ? '' : name, text, cls: '', base: -1 }));
}
export function note(text) { publish([{ type: 'Notice', kind: 'system', text, stamp: '', replace: false, tag: '' }]); }

// extra translation windows: config.child_windows, opened and closed by winmanager.js
windows = startWindows({ settings });

// ---- the test window's look controls <-> the settings (the real options window will replace them)
const $ = id => document.getElementById(id);
const bind = {
  bg: ['bg_opacity', v => v], text: ['text_opacity', v => v], size: ['font_size', v => v],
};
for (const [id, [key]] of Object.entries(bind)) {
  const el = $(id); el.value = cfg[key];
  el.oninput = () => settings.set({ [key]: Number(el.value) });
}
for (const [id, key] of [['shadow', 'shadow_on'], ['clickThrough', 'click_through'], ['autoPaste', 'send_autopaste']]) {
  const el = $(id); el.checked = !!cfg[key];
  el.onchange = () => settings.set({ [key]: el.checked });
}
const syncBlur = () => settings.set({ blur: $('blur').checked ? Number($('blurState').value) === 4 ? 2 : 1 : 0 });
$('blur').checked = cfg.blur > 0; $('blurState').value = cfg.blur === 2 ? '4' : '3';
$('blur').onchange = syncBlur; $('blurState').onchange = syncBlur;

let feedTimer = 0, feedIndex = 0;
const FAKE = [
  ['party', 'Thrallson', 'LF2M tank and healer for +12, link io'],
  ['guild', 'Moonpaw', 'anyone up for a quick heroic raid tonight?'],
  ['whisper', 'Jainafan', 'hey, can you craft the new ring for me? I have the mats'],
  ['say', 'Grommash', 'summon please, I am at the stone'],
  ['party', 'Sylvie', 'wait for cooldowns before the last boss'],
  ['sys', 'System', '[SERVER] Hearthstone x1 received'],
];
$('feed').onclick = () => {
  if (feedTimer) { clearInterval(feedTimer); feedTimer = 0; hubLog('가짜 채팅 정지'); return; }
  hubLog('가짜 채팅 시작 (1.5초마다 한 줄, 번역 포함)');
  feedTimer = setInterval(() => { const [channel, name, text] = FAKE[feedIndex++ % FAKE.length]; fakeLine({ channel, name, text }); }, 1500);
};
$('add').onclick = () => { const id = windows.add(); hubLog('번역창 추가: 창 ' + id); };
invoke('options_hotkey_ok').catch(() => false).then(ok => note(tr('제목줄은 마우스를 올리면 나타납니다 | 우클릭 또는 ⚙: 옵션 | {open}: 옵션 | 클릭 관통 중에는 {keys}를 누른 채로 조작', {
  open: ok ? 'Ctrl+Alt+O' : tr('트레이 아이콘'), keys: (settings.cfg().interact_keys || ['Shift']).join('+') })));

// ---- the real chat: the capture loop
const capture = startCapture({ settings, publish, pipeline });
$('research').onclick = () => capture.research();
setInterval(() => {
  const w = capture.worker;
  $('matrix').textContent = '매트릭스: ' + (!capture.reading ? '읽지 않음 (옵션에서 끔)' : w.pos ? `연결됨 @ ${w.pos[0]},${w.pos[1]} (${w.mode}${w.mode === 'v3' && w.v3Wait ? ', 새 대화 대기 중' : ''}) | 순번 ${w.lastSeq ?? '-'}` : '찾는 중...')
    + ' | 게임 창: ' + (capture.game.found ? (capture.game.rect ? `${capture.game.rect[2]}x${capture.game.rect[3]}` : '최소화됨') : '없음');
}, 500);
const send = startSend({ settings, translator, capture, system: text => note(text) });
const upkeep = startUpkeep({ settings, translator, glossary, system: text => note(text) });
const { invoke: tauriInvoke } = window.__TAURI__.core, { listen: tauriListen, emit: tauriEmit } = window.__TAURI__.event;
const widgets = startWidgets({ settings, emit: tauriEmit, listen: tauriListen });         // (the state of the widgets of the windows: docs/WIDGETS.md)
const voice = startVoice({ settings, files, publish, pipeline, widgets, onActive: on => windows.setVoice(on),
  installer: makeInstaller({ files, invoke: tauriInvoke, listen: tauriListen, getCfg: () => settings.cfg() }),
  bencher: makeBencher({ files, invoke: tauriInvoke, listen: tauriListen, getCfg: () => settings.cfg() }),
  backend: makeBackend({ invoke: tauriInvoke, listen: tauriListen, log }) });
listen('hub-log', ev => { const { level, msg } = ev.payload; (log[level] || log.info).call(log, msg); });     // (the windows have no log file of their own)
listen('options-geometry', ev => { if (settings.cfg().options_geometry !== ev.payload.geometry) settings.set({ options_geometry: ev.payload.geometry }); });
listen('cfg-patch', ev => settings.set(ev.payload.patch));        // the options window
listen('research', () => capture.research());
// ---- the newest release: at start (when the option is on) and when the options window asks; one answer is kept for windows that open later
const http = makeHttp(transport);
let latest = { tag: '', err: '', checking: false };
async function checkUpdate(quiet) {
  latest = { tag: latest.tag, err: '', checking: true }; emit('update-info', latest);
  try { latest = { tag: await updatecheck.fetchLatest(http), err: '', checking: false }; }
  catch (e) { latest = { tag: '', err: String(e?.message || e).slice(0, 80), checking: false }; }
  if (latest.tag) log.info(`최신 릴리스: ${latest.tag} (현재 v${version.VERSION})`);
  emit('update-info', latest);
  if (quiet && latest.tag && updatecheck.isNewer(latest.tag, version.VERSION)) note('⬆ ' + tr('새 버전 {latest}이 있습니다 (현재 v{cur})', { latest: latest.tag, cur: version.VERSION }) + ': ' + version.RELEASES_URL);
}
listen('update-check', () => checkUpdate(false));
listen('update-hello', () => emit('update-info', latest));
if (settings.cfg().check_updates ?? true) setTimeout(() => checkUpdate(true), 2500);

// ---- the tray icon, the end of the program ("quit" of the tray / the options / the X of the main window / the game was closed)
startTray();
let quitting = false;
async function quit(why, again = false) {
  if (quitting) return;
  quitting = true; log.info((again ? '프로그램을 다시 시작합니다: ' : '프로그램을 끝냅니다: ') + why);
  await new Promise(r => setTimeout(r, 300));
  await settings.flush();                                         // (the position of the window, ... : nothing is lost)
  invoke(again ? 'restart_app' : 'quit_app');                      // (restart_app: a new copy that waits a moment, and this one ends)
}
listen('restart-request', () => quit('restart request', true));
listen('quit-request', () => quit('quit request'));       // (the windows tell their places at the same moment: a short wait)
const exitWatch = new ExitWatch();
let gameFound = null;
const sendGame = () => emit('game-state', { found: !!capture.game.found });
listen('game-hello', sendGame);                                   // the translation windows: no game = they stay in view (not click-through)
every('HUB_TICK_MS', () => {
  if (quitting) return;
  if (gameFound !== capture.game.found) { gameFound = capture.game.found; sendGame(); }
  if (exitWatch.tick(Date.now() / 1000, !!settings.cfg().exit_with_game, capture.game.found) === 'quit') quit('the game was closed');
});
report('hub', emit);

const plugins = startPlugins({ settings, files, publish, pipeline, invoke: tauriInvoke, emit: tauriEmit, listen: tauriListen, widgets, windows });        // (the plugins folder: docs/PLUGINS.md)

const browsers = startBrowsers({ settings, invoke: tauriInvoke, emit: tauriEmit, listen: tauriListen, note: hubLog });          // (the windows of the mini browser: core/browsers.js)
windows.setPluginCheck((owner, name) => plugins.windowAllowed(owner, name));       // (a window of a plugin opens only while its plugin runs and may have it)


window.cmrHub = { fakeLine, note, windows, translator, service, pipeline, capture, send, upkeep, voice, plugins, widgets, browsers };
