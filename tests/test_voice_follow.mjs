// The options changed while the voice recognition runs: what is applied at once, what is only named until a restart, and the loudness.
import { check } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import { applyTuning } from '../app/core/timings.js';
import { VoiceControl } from '../app/core/voice.js';
import { liveOf, controlFrame, engineArgs } from '../app/core/voice_proto.js';
import { makeBackend } from '../app/voice_install.js';

applyTuning({});
const wait = ms => new Promise(r => setTimeout(r, ms));
const files = memoryFiles({ 'extensions/stt/engine-cpu/cmr-stt.exe': 'x', 'extensions/stt/engine-vulkan/cmr-stt.exe': 'x', 'extensions/stt/models/ggml-small.bin': 'x', 'extensions/stt/models/ggml-base.bin': 'x', 'extensions/stt/models/ggml-large-v3-turbo.bin': 'x' });

// a stand-in backend that remembers what it was asked
function fake() {
  const calls = [];
  return { calls, onMessage() {},
    async start(cfg, plan) { calls.push(['start', plan.engine, plan.model]); }, async stop() { calls.push(['stop']); },
    async restartCapture(cfg) { calls.push(['restartCapture', cfg.voice_target, cfg.voice_app]); }, async sendControl(p) { calls.push(['control', p]); } };
}
async function running(cfg0, extra = {}) {
  const cfg = { voice_target: 'discord', voice_model: 'small', voice_device: 'cpu', voice_lang: 'ko', voice_prompt: '', ...cfg0 };
  const be = fake(), levels = [], states = [];
  const vc = new VoiceControl({ files, backend: be, getCfg: () => cfg, debounceMs: 20, onLevel: l => levels.push(l), onChange: s => states.push(s.state), ...extra });
  await vc.start(); vc.message({ type: 'status', state: 'ready', device: 'cpu' }); be.calls.length = 0;
  return { vc, be, cfg, levels };
}

// ---- the language and the hint: sent to the engine, no restart
{ const { vc, be, cfg } = await running({});
  cfg.voice_lang = 'en'; vc.cfgChanged(); cfg.voice_prompt = 'Tank, Healer'; vc.cfgChanged(); cfg.voice_prompt = 'Tank, Healer, Mythic'; vc.cfgChanged();
  check(be.calls.length === 0, 'nothing is sent while the options are still being changed (typing)');
  await wait(60);
  check(be.calls.length === 1 && be.calls[0][0] === 'control' && be.calls[0][1].lang === 'en' && be.calls[0][1].prompt === 'Tank, Healer, Mythic', 'a pause after the last change: one control message with everything that can change');
  check(vc.state.pending.length === 0 && be.calls.every(c => c[0] !== 'stop' && c[0] !== 'start' && c[0] !== 'restartCapture'), 'no restart of the engine, no restart of the capture');
  cfg.voice_end_ms = 900; cfg.voice_max_s = 8; cfg.voice_mode = 'live'; vc.cfgChanged(); await wait(60);
  check(be.calls.length === 2 && be.calls[1][1].end_ms === 900 && be.calls[1][1].max_s === 8 && be.calls[1][1].mode === 'live', 'the quiet time, the longest piece and the display mode too');
  cfg.voice_min_db = -52; vc.cfgChanged(); await wait(60);
  check(be.calls.length === 3 && be.calls[2][1].min_db === -52, 'the quietest sound that counts as speech too (the limit of the loudness bar moves)');
  vc.cfgChanged(); await wait(60);
  check(be.calls.length === 3, 'a change event that changes nothing sends nothing'); }

// ---- the target: only the capture is restarted
{ const { vc, be, cfg } = await running({});
  cfg.voice_target = 'app'; cfg.voice_app = 'chrome.exe'; vc.cfgChanged(); cfg.voice_app = 'wow.exe'; vc.cfgChanged();
  check(vc.state.capture === null || vc.state.capture.status !== 'reconnecting', 'not at once: it waits for the last change');
  await wait(60);
  check(be.calls.length === 1 && be.calls[0][0] === 'restartCapture' && be.calls[0][2] === 'wow.exe', 'half a second after the last change the sound capture is restarted with the new program (the engine stays)');
  check(vc.state.capture && vc.state.capture.status === 'reconnecting' && vc.state.pending.length === 0, 'the status says it reconnects; nothing waits for a restart');
  vc.message({ type: 'capture', mode: 'process', program: 'Wow.exe', pid: 5, status: 'listening' });
  check(vc.state.capture.mode === 'process', 'and shows the new capture when it reports');
  cfg.voice_capture = 'device'; vc.cfgChanged(); await wait(60);
  check(be.calls.length === 2 && be.calls[1][0] === 'restartCapture', 'the method of receiving the sound: the same');
  applyTuning({ VOICE_GATE_PERMILLE: 9 }); vc.cfgChanged(); await wait(60);
  check(be.calls.length === 3 && be.calls[2][0] === 'restartCapture', 'and the timers of the options tab 고급 (the capture reads them when it starts)'); applyTuning({}); }

// ---- the model and the device: only named, applied by restart()
{ const { vc, be, cfg } = await running({});
  cfg.voice_model = 'base'; vc.cfgChanged();
  check(JSON.stringify(vc.state.pending) === '["model"]', 'another model is named as waiting for a restart');
  await wait(60);
  check(be.calls.length === 0 && vc.state.state === 'on', 'and nothing happens by itself');
  cfg.voice_device = 'gpu'; vc.cfgChanged();
  check(JSON.stringify(vc.state.pending) === '["device","model"]', 'a GPU (the Vulkan engine is installed) is named too');
  cfg.voice_model = 'small'; cfg.voice_device = 'cpu'; vc.cfgChanged();
  check(vc.state.pending.length === 0, 'changed back: nothing waits any more');
  cfg.voice_model = 'base'; vc.cfgChanged();
  await vc.restart();
  check(be.calls.map(c => c[0]).join() === 'stop,start' && be.calls[1][2] === 'base' && vc.state.pending.length === 0, 'restart(): stop, start with the new model; nothing waits any more');
  cfg.voice_engine = 'openai'; cfg.voice_oa_url = 'http://x/v1'; vc.cfgChanged(); vc.message({ type: 'status', state: 'ready', device: 'cpu' });
  check(vc.state.pending.includes('engine'), 'another method (the server) is named'); }

// ---- not running: nothing is followed
{ const be = fake(); const cfg = { voice_target: 'wow' }; const vc = new VoiceControl({ files, backend: be, getCfg: () => cfg, debounceMs: 10 });
  cfg.voice_lang = 'en'; vc.cfgChanged(); await wait(40);
  check(be.calls.length === 0 && vc.state.pending.length === 0, 'off: a change of the options does nothing (the next start reads them)'); }
// the engine ended: the pending timers do not touch it
{ const { vc, be, cfg } = await running({});
  cfg.voice_lang = 'en'; vc.cfgChanged(); vc.message({ type: 'exit', code: 1 }); await wait(60);
  check(be.calls.length === 0 && vc.state.state === 'error', 'the engine ended before the change was sent: nothing is sent to a dead engine'); }

// ---- the loudness: the light way
{ const { vc, levels } = await running({});
  let changes = 0; vc.onChange = () => changes++;
  vc.message({ type: 'level', db: -41.2, peak: 0.1, speech: true, thr: -44.4 });
  vc.message({ type: 'capture', mode: 'process', program: 'W', pid: 1, status: 'listening', level: 0.2, peak: 0.3, gate: true });
  const c1 = changes;
  for (let i = 0; i < 20; i++) vc.message({ type: 'capture', mode: 'process', program: 'W', pid: 1, status: 'listening', level: i / 20, peak: 0.3, gate: i % 2 === 0 });
  check(changes === c1, 'the same capture state 20 times (loudness and gate moving): the state is not set again, nothing is redrawn');
  check(levels.length === 22 && levels[0].source === 'engine' && levels[0].db === -41.2 && levels[0].speech === true && levels[1].source === 'capture' && levels[1].gate === true, 'but every loudness reading goes out, from the engine and from the capture');
  vc.message({ type: 'capture', mode: 'device', device: 'H', program: 'W', pid: 1, status: 'listening' });
  check(changes === c1 + 1, 'a change that is shown (another mode) is set'); }

// ---- the sentences that came out
{ const { vc } = await running({});
  vc.message({ type: 'text', text: 'a' }); vc.message({ type: 'text', text: 'b' });
  check(vc.state.texts.count === 2 && Date.now() - vc.state.texts.last < 1000, 'the number of sentences and when the last one came');
  await vc.stop(); check(vc.state.texts.count === 0, 'turned off: counted again from 0'); }

// ---- the messages themselves
check(JSON.stringify(liveOf({ voice_lang: '', voice_prompt: '  hi ', voice_end_ms: 99999, voice_max_s: 'x' })) === '{"lang":"auto","prompt":"hi","end_ms":5000,"max_s":12,"min_db":-44,"mode":"sentence","partial_ms":1000}', 'what can change while it runs, with the limits of the options');
check(controlFrame({ lang: 'ko' }) === 'CMRFC0000000d{"lang":"ko"}', 'the control frame: CMRFC + the length in 8 hexadecimal digits + JSON');
check(controlFrame({ prompt: '안녕' }).startsWith('CMRFC00000013') && new TextEncoder().encode('{"prompt":"안녕"}').length === 19 && '{"prompt":"안녕"}'.length === 15, 'the length counts bytes (UTF-8), not characters');
check(engineArgs({}, { engine: 'cpu', model: 'base' }).includes('--framed'), 'the engine is told to expect frames');

// ---- the backend: the capture alone, the control message, a late "off" of an old capture
{ const calls = [], L = {}; let gen = 10;
  const invoke = async (c, a) => { calls.push([c, a]); if (c === 'capture_start') return { ok: true, gen: ++gen }; if (c === 'ext_running') return true; return null; };
  const listen = async (n, f) => { (L[n] ||= []).push(f); return () => { L[n] = L[n].filter(x => x !== f); }; };
  const emit = (n, p) => (L[n] || []).slice().forEach(f => f({ payload: p }));
  const be = makeBackend({ invoke, listen, log: null }); const got = []; be.onMessage = m => got.push(m);
  await be.start({ voice_target: 'wow' }, { engine: 'cpu', model: 'small' });
  check(calls.find(c => c[0] === 'capture_start')[1].options.framed === true, 'the capture is told to write frames');
  calls.length = 0;
  await be.restartCapture({ voice_target: 'wow', voice_capture: 'device' });
  check(calls.map(c => c[0]).join() === 'capture_stop,capture_start' && calls[1][1].options.method === 'device' && !calls.some(c => c[0].startsWith('ext_')), 'restartCapture: stop and start the capture only; the engine is not touched');
  emit('capture-state', { id: 'stt', gen: 11, mode: 'off' }); emit('capture-state', { id: 'stt', gen: 12, mode: 'process' });
  check(got.length === 1 && got[0].mode === 'process', 'the late "off" of the capture that was replaced is ignored');
  calls.length = 0; await be.sendControl({ lang: 'en' });
  check(calls.length === 1 && calls[0][0] === 'ext_stdin' && calls[0][1].text === 'CMRFC0000000d{"lang":"en"}' && !calls[0][1].close, 'a control message goes to the input of the engine as text'); }
