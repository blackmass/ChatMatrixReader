// Installing and taking away the voice extension (extensions/stt/), and starting / stopping its engine program. Everything goes through the
// generic tools of the exe (ext_download / ext_run / ext_stdin / ext_kill / ext_remove, src-tauri/src/ext.rs): nothing about Whisper is in the exe.
// `invoke` and `listen` are given in, so this can be tested without the exe (tests/test_voice_install.mjs).
import { tr } from './core/i18n.js';
import { modelOf, scan, plan } from './core/voice.js';
import { BENCH_DIR } from './core/voice_bench.js';
import { FOLDER, CATALOG_FILE, mergeCatalog, engineDir, exePath, modelPath } from './core/voice_catalog.js';
import { engineArgs, benchArgs, parseLine, controlFrame } from './core/voice_proto.js';
import { captureOptions } from './core/voice_target.js';

const mb = n => (n >= 1024 * 1024 * 1024 ? (n / 1024 / 1024 / 1024).toFixed(1) + ' GB' : (n / 1024 / 1024).toFixed(0) + ' MB');

export function explain(err) {
  const m = String((err && err.message) || err || '');
  if (m === 'cancelled') return tr('취소했습니다. 다시 누르면 이어서 받습니다.');
  if (m === 'sha256 mismatch') return tr('받은 파일이 손상되었습니다 (체크섬이 맞지 않음). 다시 시도해 주세요.');
  return tr('설치 실패') + ': ' + m.slice(0, 200);
}

export function makeInstaller({ files, invoke, listen, getCfg }) {
  let current = null;           // id of the download in progress
  let stopped = false;
  const api = {
    // what: 'cpu' | 'vulkan' | 'cuda' (the engine, and the model it would use) | 'model' (only the model that is wanted now)
    //       | 'model:<name>' (only that model: the model list of the options)
    async install(what, report) {
      stopped = false;
      let forced = '';
      if (what.startsWith('model:')) { forced = what.slice(6); what = 'model'; }
      const cat = mergeCatalog(await files.read(CATALOG_FILE).catch(() => null));
      const steps = [];
      let engineKind = what;
      if (what !== 'model') {
        const e = cat.engines[what];
        if (!e) throw new Error('unknown engine ' + what);
        if (!e.files.length) throw new Error(tr('이 엔진은 아직 내려받을 수 있게 올라와 있지 않습니다.'));
        for (const f of e.files) steps.push({ label: f.name, url: f.url, sha256: f.sha256, dest: `${engineDir(what)}/${f.name}` });
      } else {
        const have = (await files.list(FOLDER).catch(() => [])).filter(n => /^engine-.+\/$/.test(n));
        engineKind = have.some(n => n === 'engine-vulkan/' || n === 'engine-cuda/') ? 'vulkan' : 'cpu';
      }
      const model = forced || modelOf(getCfg(), engineKind);
      const m = cat.models[model];
      const haveModel = (await files.list(FOLDER + '/models').catch(() => [])).includes(`ggml-${model}.bin`);
      if (!haveModel) {
        if (!m) throw new Error(tr('모델 {model}의 내려받을 주소를 모릅니다.', { model }));
        steps.push({ label: model, url: m.url, sha256: m.sha256, dest: modelPath(model) });
      }
      let idx = 0;
      const off = await listen('ext-progress', ev => {
        const p = ev.payload || {};
        if (p.id !== current) return;
        const pct = p.total ? Math.floor(p.done / p.total * 100) : 0;
        report(tr('받는 중: {name} {done} / {total} ({pct} %)', { name: steps[idx].label, done: mb(p.done), total: p.total ? mb(p.total) : '?', pct }));
      });
      try {
        for (; idx < steps.length; idx++) {
          if (stopped) throw new Error('cancelled');
          const s = steps[idx];
          current = `dl-${idx}-${Date.now()}`;
          report(tr('받는 중: {name} {done} / {total} ({pct} %)', { name: s.label, done: '0 MB', total: '?', pct: 0 }));
          await invoke('ext_download', { id: current, url: s.url, dest: s.dest, sha256: s.sha256 || null });
        }
      } finally { current = null; off(); }
      report('');
      return { steps: steps.length };
    },
    // one model file (and the half of it left by a cancelled download); the engine of the extension stays
    async removeModel(name) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name.startsWith('.')) throw new Error('bad model name');
      await files.remove(modelPath(name));
      await files.remove(modelPath(name) + '.part');
    },
    cancel() { stopped = true; if (current) invoke('ext_cancel', { id: current }).catch(() => {}); },
    // the whole extension: the engine, the models, the temporary files (a running engine has been stopped before)
    async remove() { await invoke('ext_remove', { path: FOLDER }); },
  };
  return api;
}

const ENGINE_ID = 'stt';
const BENCH_ID = 'stt-bench';
const BENCH_LIMIT_MS = 15 * 60 * 1000;      // one model must not hold the test longer than this (a huge model on a slow CPU)

// The speed test: each chosen model runs the same sound file through the engine in its `--bench` mode (core/voice_bench.js says what it prints),
// one after the other, so the models are not slowed down by each other. Not while the recognition itself runs (they would share the computer).
export function makeBencher({ files, invoke, listen, getCfg }) {
  let cancelled = false, running = false;
  const api = {
    // the sound files that can be used: extensions/stt/bench/*.wav
    async list() { return (await files.list(BENCH_DIR).catch(() => [])).filter(n => /\.wav$/i.test(n)).sort(); },
    // models: names; file: a name from list(); report(text) shows where it is; onResult(model, device, { file, dur, ms, load_ms, text }) | onFail(model, why)
    async run({ models, file, report, onResult, onFail }) {
      if (running) throw new Error(tr('속도 시험이 이미 돌고 있습니다.'));
      if (!/^[A-Za-z0-9._ -]{1,100}\.wav$/i.test(file) || file.startsWith('.')) throw new Error(tr('시험용 소리 파일을 고르세요.'));
      running = true; cancelled = false;
      try {
        const installed = await scan(files);
        for (let i = 0; i < models.length; i++) {
          if (cancelled) break;
          const model = models[i], p = plan({ ...getCfg(), voice_engine: 'whisper', voice_model: model }, installed);
          const head = `${i + 1}/${models.length} ${model}`;
          if (p.error) { onFail(model, p.error === 'no_model' ? tr('모델이 설치되어 있지 않습니다.') : tr('엔진이 설치되어 있지 않습니다.')); continue; }
          // (the engine says nothing until it is done: loading the model, one warm-up run and the timed run follow each other, so the time that has passed is shown)
          const t0 = Date.now(), tick = () => report(tr('{head} · 모델 불러오기, 워밍업, 측정 중… {s}초 경과', { head, s: Math.round((Date.now() - t0) / 1000) }));
          tick(); const clock = setInterval(tick, 1000);
          try {
            const r = await runOne(p, model, file);
            if (cancelled) break;
            onResult(model, p.engine === 'cpu' ? 'cpu' : 'gpu', { file, ...r });
          } catch (e) { if (cancelled) break; onFail(model, String((e && e.message) || e).slice(0, 200)); } finally { clearInterval(clock); }
        }
      } finally { running = false; report(''); }
    },
    cancel() { cancelled = true; invoke('ext_kill', { id: BENCH_ID }).catch(() => {}); },
    get running() { return running; },
  };
  // one model: start the engine in test mode, wait for its {"type":"bench"} line and its end
  async function runOne(p, model, file) {
    let result = null, bad = '', finish = () => {};
    const ended = new Promise(r => { finish = r; });
    // the listeners are in place (awaited) before the engine starts, or its first lines could be missed
    const offs = [
      await listen('ext-line', ev => {
        const e = ev.payload || {}; if (e.id !== BENCH_ID) return;
        const m = parseLine(e.line); if (!m) return;
        if (m.type === 'bench') result = { dur: Number(m.dur), ms: Number(m.ms), load_ms: m.load_ms == null ? null : Number(m.load_ms), text: String(m.text || '') };
        else if (m.type === 'status' && m.state === 'error') bad = String(m.msg || '');
      }),
      await listen('ext-exit', ev => { const e = ev.payload || {}; if (e.id === BENCH_ID) finish(); }),
    ];
    let timer = null;
    try {
      await invoke('ext_run', { id: BENCH_ID, exe: exePath(p.engine), args: benchArgs(p, `../bench/${file}`) });
      timer = setTimeout(() => { bad = tr('시간이 너무 오래 걸려 멈췄습니다.'); invoke('ext_kill', { id: BENCH_ID }).catch(() => {}); }, BENCH_LIMIT_MS);
      await ended;
    } finally { clearTimeout(timer); for (const o of offs) o(); }
    if (cancelled) throw new Error('cancelled');
    if (!result || !(result.dur > 0) || !Number.isFinite(result.ms)) throw new Error(bad || tr('엔진이 결과를 내지 않고 끝났습니다.'));
    return result;
  }
  return api;
}

export function makeBackend({ invoke, listen, log }) {
  let offs = [];
  let gen = 0;            // which capture is the current one (a capture that was stopped and started again says "off" late: that is ignored)
  const drop = () => { for (const off of offs) off(); offs = []; };
  const api = {
    onMessage: () => {},
    async start(cfg, plan) {
      if (plan.engine === 'server') throw new Error(tr('OpenAI 호환 서버 연결은 아직 만들어지지 않았습니다.'));
      const cap = captureOptions(cfg);
      if (cap.error) throw new Error(tr('프로그램을 직접 고르기: 옵션에서 프로그램을 골라 주세요.'));
      drop();
      offs.push(await listen('ext-line', ev => {
        const p = ev.payload || {}; if (p.id !== ENGINE_ID) return;
        const m = parseLine(p.line);
        if (m) api.onMessage(m); else if (log) log.info('음성 엔진: ' + String(p.line).slice(0, 300));
      }));
      offs.push(await listen('ext-err', ev => { const p = ev.payload || {}; if (p.id === ENGINE_ID && log) log.warn('음성 엔진: ' + String(p.line).slice(0, 300)); }));
      offs.push(await listen('ext-exit', ev => {
        const p = ev.payload || {}; if (p.id !== ENGINE_ID) return;
        invoke('capture_stop', { id: ENGINE_ID }).catch(() => {});
        drop();
        api.onMessage({ type: 'exit', code: p.code });
      }));
      // the sound capture of the exe (it tells how it listens, and warns when no sound comes)
      const current = p => p.id === ENGINE_ID && !(typeof p.gen === 'number' && p.gen < gen);
      offs.push(await listen('capture-state', ev => { const p = ev.payload || {}; if (current(p)) api.onMessage({ type: 'capture', ...p }); }));
      offs.push(await listen('capture-warn', ev => { const p = ev.payload || {}; if (current(p)) api.onMessage({ type: 'warn', ...p }); }));
      gen = 0;
      try {
        await invoke('ext_run', { id: ENGINE_ID, exe: exePath(plan.engine), args: engineArgs(cfg, plan) });
        const r = await invoke('capture_start', { id: ENGINE_ID, options: cap.options });
        if (r && typeof r.gen === 'number') gen = r.gen;
      } catch (e) {
        invoke('capture_stop', { id: ENGINE_ID }).catch(() => {});
        invoke('ext_kill', { id: ENGINE_ID }).catch(() => {});
        drop(); throw e;
      }
    },
    // the sound capture alone, again (another program, another method ...): the engine and its model stay as they are
    async restartCapture(cfg) {
      const cap = captureOptions(cfg);
      if (cap.error) throw new Error(tr('프로그램을 직접 고르기: 옵션에서 프로그램을 골라 주세요.'));
      try { await invoke('capture_stop', { id: ENGINE_ID }); } catch { /* it had ended */ }
      const r = await invoke('capture_start', { id: ENGINE_ID, options: cap.options });
      if (r && typeof r.gen === 'number') gen = r.gen;
    },
    // a control message into the engine's input: the language, the hint ... of the next sentences (core/voice_proto.js liveOf)
    async sendControl(payload) { await invoke('ext_stdin', { id: ENGINE_ID, text: controlFrame(payload) }); },
    // stops the sound first, then asks the engine to end (closing its input), then makes sure
    async stop() {
      try { await invoke('capture_stop', { id: ENGINE_ID }); } catch { /* not capturing */ }
      if (!(await invoke('ext_running', { id: ENGINE_ID }))) return;
      try { await invoke('ext_stdin', { id: ENGINE_ID, text: '', close: true }); } catch { /* already gone */ }
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (!(await invoke('ext_running', { id: ENGINE_ID }))) return;
      }
      await invoke('ext_kill', { id: ENGINE_ID });
    },
  };
  return api;
}
