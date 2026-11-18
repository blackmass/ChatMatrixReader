// Voice recognition: what is installed, and the on / off state the options window shows. (No sound and no Whisper in here: the engine is a
// separate program in extensions/stt/, started through `backend`. Without a backend - a build that cannot start programs yet - turning it on
// ends in an error that says so.)
//
//   state.state: 'off' | 'starting' | 'on' | 'stopping' | 'error'
//   state.code:  why it is in 'error': 'not_installed' | 'no_model' | 'no_url' | 'no_backend' | 'failed' (state.msg has the text of the engine)
//   state.installed: { engines: ['cpu', 'vulkan', 'cuda', 'metal'], models: ['base', 'large-v3-turbo'] }
//   state.device: what the engine computes on now ('cpu' | 'gpu' | ''), state.stats: { cpu, ram, gpu, vram } | null (told by the engine)
//   state.perf: the speed table of every model measured so far (core/voice_bench.js table()), state.advice: 'slow' when the running model falls behind
//   state.capture: how the sound is received now (the `capture-state` event of the exe; core/voice_target.js captureText), state.warn: the last warning text ('' = none)
//   state.pending: what the options changed that only a restart applies: ['model', 'device', 'engine'] ([] = nothing); state.texts: { count, last } of the sentences
//                  recognised since it was turned on (last = Date.now() of the latest)
//   While it is on, a change of the options is followed (cfgChanged): the sound capture alone is restarted for another program / method (0.5 s after the last
//   change), the language, hint and sentence settings are sent to the engine as a control message, and what needs another model or device is only
//   named in `pending` until restart() is asked.
//   state.benchTask: what the speed test is doing now ('' = not running)
//
//   backend = { start(cfg, plan) -> Promise, stop() -> Promise }        plan = { engine: 'cpu' | 'vulkan' | 'cuda' | 'metal' | 'server', model, device? }   (device: only 'metal', one program for both: 'cpu' | 'gpu')
import * as bench from './voice_bench.js';
import { tr } from './i18n.js';
import { captureOptions } from './voice_target.js';
import { liveOf } from './voice_proto.js';
import { OS } from '../platform.js';
export const FOLDER = 'extensions/stt';
export const ENGINES = ['cpu', 'vulkan', 'cuda', 'metal'];
export const DEFAULT_MODEL = 'large-v3-turbo';   // the same on every engine (as in 2.x); the options say to take a smaller one when the CPU is too slow
// whose sound is recognised (2.0's voice_target): the presets and 'app' = a program picked from the list (voice_app = its file name)
// discord = the voice chat of Discord only, discord-all = everything Discord plays. (Discord's program and the session of its voice chat are not the
// same: which session each preset means is settled with the sound capture; here only the choice is kept.)
// (on a Mac there is no sound session to tell the voice chat of Discord from its other sounds: one Discord entry)
export const targetsFor = os => (os === 'macos'
  ? [['wow', '와우'], ['discord', '디스코드'], ['system', '시스템 전체 소리'], ['app', '프로그램을 직접 고르기']]
  : [['wow', '와우'], ['discord', '디스코드 (음성 대화)'], ['discord-all', '디스코드 (전체)'], ['system', '시스템 전체 소리'], ['app', '프로그램을 직접 고르기']]);
export const TARGETS = targetsFor(OS);
export const LANGS = [['ko', '한국어'], ['en', 'English'], ['ja', '日本語'], ['zh', '中文'], ['es', 'Español'], ['pt', 'Português'], ['fr', 'Français'], ['de', 'Deutsch'], ['ru', 'Русский'], ['it', 'Italiano'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['uk', 'Українська'], ['ar', 'العربية']];
export const MODES = ['sentence', 'live'];
export const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'];

// 2.0 wrote 'cuda' for "the graphics card": read as 'gpu'
export const deviceOf = cfg => (cfg.voice_device === 'cuda' || cfg.voice_device === 'gpu' ? 'gpu' : cfg.voice_device === 'cpu' ? 'cpu' : 'auto');
// the model that is meant: the one written in the options, else the default (`engine` is kept for a later per-engine default; not used now)
export const defaultModelFor = () => DEFAULT_MODEL;
export const modelOf = (cfg, engine = '') => (cfg.voice_model || '').trim() || defaultModelFor(engine);

// What is in extensions/stt/: a folder "engine-<kind>/" is an engine, a file "models/ggml-<name>.bin" a model. (Nothing is written down
// anywhere else: a folder the user deleted by hand is simply "not installed".)
export async function scan(files) {
  const out = { engines: [], models: [] };
  let top = [];
  try { top = await files.list(FOLDER); } catch { return out; }
  for (const kind of ENGINES) if (top.includes(`engine-${kind}/`)) out.engines.push(kind);
  if (top.includes('models/')) {
    let names = [];
    try { names = await files.list(FOLDER + '/models'); } catch { /* none */ }
    for (const n of names) { const m = /^ggml-(.+)\.bin$/.exec(n); if (m) out.models.push(m[1]); }
  }
  return out;
}

// Which engine and model a start would use; { error: code } when it cannot start.
export function plan(cfg, installed) {
  if ((cfg.voice_engine || 'whisper') === 'openai') return (cfg.voice_oa_url || '').trim() ? { engine: 'server', model: (cfg.voice_oa_model || '').trim() } : { error: 'no_url' };
  const have = installed.engines, gpu = have.includes('cuda') ? 'cuda' : have.includes('vulkan') ? 'vulkan' : have.includes('metal') ? 'metal' : null;
  if (!have.length) return { error: 'not_installed' };
  const want = deviceOf(cfg);
  // (metal = the Mac engine: the CPU and the GPU are in the same program, the option only says which one it is told to use)
  const engine = want === 'cpu' ? (have.includes('cpu') ? 'cpu' : have.includes('metal') ? 'metal' : null) : want === 'gpu' ? gpu : (gpu || 'cpu');
  if (!engine) return { error: 'not_installed', want };
  const model = modelOf(cfg, engine);
  if (!installed.models.includes(model)) return { error: 'no_model', model, engine };
  return engine === 'metal' ? { engine, model, device: want === 'cpu' ? 'cpu' : 'gpu' } : { engine, model };
}

const captureKey = cfg => JSON.stringify(captureOptions(cfg).options || null);       // (what the sound capture is told: the target, the method, the timers)

export class VoiceControl {
  // onLevel(l): the loudness, 10 times a second ({ source: 'engine' | 'capture', db, peak, speech, thr, gate }): not part of the state, so nothing is redrawn for it
  constructor({ files, backend = null, getCfg, onChange = () => {}, onLevel = () => {}, debounceMs = 500 }) {
    this.files = files; this.backend = backend; this.getCfg = getCfg; this.onChange = onChange; this.onLevel = onLevel; this.debounceMs = debounceMs;
    this.applied = null; this.tCapture = null; this.tLive = null; this.capKey = '';
    this.state = { state: 'off', code: '', msg: '', engine: '', model: '', device: '', installed: { engines: [], models: [] }, stats: null, task: '', busy: false, wantModel: '', perf: [], advice: '', benchTask: '', benchFail: {}, benchFiles: [], capture: null, warn: '', pending: [], texts: { count: 0, last: 0 } };
    this.log = bench.emptyLog(); this.logLoaded = false; this.saveTimer = null;
  }
  // the speed numbers (extensions/stt/bench.json): read once, written a little after a change
  async loadLog() {
    if (this.logLoaded) return;
    this.logLoaded = true;
    try { this.log = bench.parseLog(await this.files.read(bench.BENCH_FILE)); } catch { /* none yet */ }
    this.refreshPerf();
  }
  refreshPerf() { this.set({ perf: bench.table(this.log), advice: this.state.model ? bench.advice(this.log, this.state.model, this.state.device) : '' }); }
  saveLog(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => { this.saveTimer = null; return Promise.resolve(this.files.write(bench.BENCH_FILE, bench.stringify(this.log))).catch(() => {}); };
    if (now) return write();
    this.saveTimer = setTimeout(write, 2000);
  }
  // the numbers of the speed test (from voice_install.js makeBencher) or of a deleted model
  addBench(model, device, r) { if (bench.recordBench(this.log, model, device, r)) { this.refreshPerf(); return this.saveLog(true); } }
  forgetModel(model) { bench.forget(this.log, model); this.refreshPerf(); return this.saveLog(true); }
  clearLog() { this.log = bench.emptyLog(); this.refreshPerf(); return this.saveLog(true); }
  set(patch) { Object.assign(this.state, patch); this.onChange(this.state); }
  async rescan() {
    const installed = await scan(this.files), p = plan(this.getCfg(), installed);
    this.set({ installed, wantModel: p.model || '' });
    await this.loadLog();
    return installed;
  }

  async start() {
    if (this.state.state === 'on' || this.state.state === 'starting') return;
    const installed = await this.rescan(), p = plan(this.getCfg(), installed);
    if (p.error) return this.set({ state: 'error', code: p.error, msg: p.model || '', device: '', stats: null });
    if (!this.backend) return this.set({ state: 'error', code: 'no_backend', msg: '', device: '', stats: null });
    const cfg = this.getCfg();
    this.set({ state: 'starting', code: '', msg: '', engine: p.engine, model: p.model, pending: [], texts: { count: 0, last: 0 }, capture: null, warn: '' });
    this.applied = this.snapshot(cfg, p);               // (what this run was started with: later changes are compared with it)
    try { await this.backend.start(cfg, p); } catch (e) { this.applied = null; this.set({ state: 'error', code: 'failed', msg: String(e?.message || e).slice(0, 200) }); }
  }
  // what the running engine and capture were given: the sound capture options, the live settings, the model and the compute device
  snapshot(cfg, p) { return { capture: captureKey(cfg), live: JSON.stringify(liveOf(cfg)), engine: p.engine, device: p.device || '', model: p.model }; }

  // ---- the options changed while it runs
  cfgChanged() {
    if (!this.backend || !this.applied || !['on', 'starting'].includes(this.state.state)) return;
    const cfg = this.getCfg();
    this.updatePending(cfg);
    if (captureKey(cfg) !== this.applied.capture) { clearTimeout(this.tCapture); this.tCapture = setTimeout(() => this.applyCapture(), this.debounceMs); }
    if (JSON.stringify(liveOf(cfg)) !== this.applied.live) { clearTimeout(this.tLive); this.tLive = setTimeout(() => this.applyLive(), this.debounceMs); }
  }
  // what only a restart applies: another model, another compute device, another method (Whisper / server)
  updatePending(cfg) {
    const p = plan(cfg, this.state.installed), now = [];
    if (p.engine) { if ((p.engine === 'server') !== (this.applied.engine === 'server')) now.push('engine'); else if (p.engine !== this.applied.engine || (p.device || '') !== this.applied.device) now.push('device'); }
    else if (p.error === 'no_url') now.push('engine');
    else if (p.want && p.want !== 'cpu' && this.applied.engine === 'cpu') now.push('device');          // (a GPU is wanted but no GPU engine is installed: a restart says so)
    if (p.model !== undefined && p.model !== this.applied.model && p.engine !== 'server') now.push('model');
    if (JSON.stringify(now) !== JSON.stringify(this.state.pending)) this.set({ pending: now });
  }
  async applyCapture() {
    this.tCapture = null;
    if (!this.applied || !['on', 'starting'].includes(this.state.state)) return;
    const cfg = this.getCfg(), key = captureKey(cfg);
    if (key === this.applied.capture) return;
    this.set({ capture: { mode: 'none', status: 'reconnecting' }, warn: '' });
    try { await this.backend.restartCapture(cfg); this.applied.capture = key; }
    catch (e) { this.set({ capture: { mode: 'none', status: 'retry', reason: String(e?.message || e).slice(0, 120) } }); }
  }
  async applyLive() {
    this.tLive = null;
    if (!this.applied || !['on', 'starting'].includes(this.state.state)) return;
    const payload = liveOf(this.getCfg()), key = JSON.stringify(payload);
    if (key === this.applied.live) return;
    try { await this.backend.sendControl(payload); this.applied.live = key; } catch { /* the engine is gone: its end is reported by itself */ }
  }
  // the options that need another model or device: stop and start again (the button next to the notice)
  async restart() { await this.stop(); await this.start(); }
  clearTimers() { clearTimeout(this.tCapture); clearTimeout(this.tLive); this.tCapture = this.tLive = null; }
  async stop() {
    if (this.state.state === 'off') return;
    this.clearTimers(); this.applied = null;
    if (this.backend && (this.state.state === 'on' || this.state.state === 'starting')) {
      this.set({ state: 'stopping' });
      try { await this.backend.stop(); } catch { /* it is gone either way */ }
    }
    this.set({ state: 'off', code: '', msg: '', device: '', stats: null, capture: null, warn: '', pending: [], texts: { count: 0, last: 0 } });
  }
  toggle() { return this.state.state === 'on' || this.state.state === 'starting' ? this.stop() : this.start(); }

  // a message of the engine (the same lines pipeline.onVoice gets): the state follows it
  message(m) {
    if (m.type === 'status') {
      if (m.state === 'ready' || m.state === 'listening') this.set({ state: 'on', code: '', msg: '', device: m.device || this.state.device });
      else if (m.state === 'error') this.set({ state: 'error', code: 'failed', msg: m.msg || '', device: '', stats: null });
    } else if (m.type === 'capture') {
      // 4 times a second: the loudness and the gate go the light way, the state is only set when something that is shown changed
      this.onLevel({ source: 'capture', peak: m.peak, level: m.level, gate: !!m.gate });
      const c = m.mode === 'off' ? null : { mode: m.mode, device: m.device, program: m.program, pid: m.pid, status: m.status, reason: m.reason };
      const key = JSON.stringify(c);
      if (key !== this.capKey) { this.capKey = key; this.set({ capture: c }); }
    } else if (m.type === 'level') {
      this.onLevel({ source: 'engine', db: m.db, peak: m.peak, speech: !!m.speech, thr: m.thr });
    } else if (m.type === 'warn') {
      // the capture tells a code and its values; the words are written here, in the language of the user
      if (m.code === 'no_audio') this.set({ warn: tr('프로그램에서 {seconds}초 동안 소리가 나지 않았습니다. 프로그램이 켜져 있고 소리가 나는지 확인하세요. (이 프로그램이 내는 소리만 듣습니다)', { seconds: m.seconds || '' }) });
      else if (m.code === 'dropped') this.set({ warn: tr('음성 엔진이 소리를 제때 읽지 못해 오래된 소리를 버렸습니다.') });
      else if (m.code === 'audio_back') this.set({ warn: '' });
    } else if (m.type === 'text') {
      this.set({ texts: { count: this.state.texts.count + 1, last: Date.now() } });
      // a sentence with its speech length (`dur`, s) and recognising time (`ms`): the live speed of the model that runs
      if (bench.recordLive(this.log, this.state.model, m.device || this.state.device, m.dur, m.ms)) { this.refreshPerf(); this.saveLog(); }
    } else if (m.type === 'stats') this.set({ stats: { cpu: m.cpu, ram: m.ram, gpu: m.gpu, vram: m.vram, gpu_why: m.gpu_why || '', vram_why: m.vram_why || '' }, device: m.device || this.state.device });
    else if (m.type === 'exit' && this.state.state !== 'off' && this.state.state !== 'stopping') { this.clearTimers(); this.applied = null; this.set({ state: 'error', code: 'failed', msg: `exit ${m.code}`, device: '', stats: null, capture: null, pending: [] }); }
  }
}
