// The speed numbers of the models (core/voice_bench.js), their use in VoiceControl, and the model list / speed test of the installer.
import { check } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import * as B from '../app/core/voice_bench.js';
import { VoiceControl } from '../app/core/voice.js';
import { makeInstaller, makeBencher } from '../app/voice_install.js';
import { benchArgs } from '../app/core/voice_proto.js';

// ---- the numbers
const log = B.emptyLog();
check(!B.recordLive(log, 'small', 'cpu', 0, 100) && !B.recordLive(log, 'small', 'cpu', undefined, 100) && !B.recordLive(log, '', 'cpu', 5, 100), 'a sentence without speech length / time / model is not counted');
B.recordLive(log, 'small', 'cpu', 10, 4000); B.recordLive(log, 'small', 'cpu', 5, 1000);
const s = B.summarize(log.live['small|cpu']);
check(s.n === 2 && Math.abs(s.ratio - 5000 / 15000) < 1e-9 && s.avgMs === 2500, 'ratio = recognising time / speech time over the sentences (5 s of 15 s of speech = ×0.33)');
check(B.ratioText(0.4) === '×0.40' && B.ratioText(12.34) === '×12.3' && B.ratioText(null) === '-', 'ratio text');
for (let i = 0; i < 40; i++) B.recordLive(log, 'small', 'cpu', 2, 3000);
check(log.live['small|cpu'].length === B.KEEP, 'only the last ' + B.KEEP + ' sentences are kept');
check(B.advice(log, 'small', 'cpu') === 'slow' && B.advice(log, 'small', 'gpu') === '' && B.advice(log, 'base', 'cpu') === '', 'falling behind (ratio above 1, enough sentences) is advised, per model and device');
const few = B.emptyLog(); for (let i = 0; i < 3; i++) B.recordLive(few, 'm', 'cpu', 1, 5000);
check(B.advice(few, 'm', 'cpu') === '', 'a few slow sentences are not enough to advise');
B.recordBench(log, 'small', 'cpu', { file: 'a.wav', dur: 20, ms: 5000, load_ms: 800, text: 'hello' });
B.recordBench(log, 'base', 'gpu', { file: 'a.wav', dur: 20, ms: 500, text: 'helo' });
check(!B.recordBench(log, 'x', 'cpu', { dur: 0, ms: 5 }) && !B.recordBench(log, 'x', 'cpu', null), 'a test result without a length is not kept');
const t = B.table(log);
check(t.map(r => r.model + '/' + r.device).join() === 'base/gpu,small/cpu' && t[1].bench.ratio === 0.25 && t[1].live.n === B.KEEP && t[0].live === null, 'the table: one entry per model + device with both kinds of numbers');
const back = B.parseLog(B.stringify(log));
check(JSON.stringify(B.table(back)) === JSON.stringify(t), 'written and read back it is the same');
check(B.table(B.parseLog('{oops')).length === 0 && B.table(B.parseLog('{"v":2}')).length === 0 && B.table(B.parseLog(JSON.stringify({ v: 1, live: { 'a|cpu': [[1, 2], ['x', 1], 7] }, bench: { 'a|cpu': { dur: 'x' } } }))).length === 1, 'a broken or foreign file is ignored, bad entries are dropped');
B.forget(log, 'small');
check(B.table(log).map(r => r.model).join() === 'base', 'a deleted model loses its numbers (every device)');

// ---- VoiceControl: the sentences of the running engine feed the live numbers, the file is written
const files = memoryFiles({ 'extensions/stt/engine-cpu/cmr-stt.exe': 'x', 'extensions/stt/models/ggml-small.bin': 'x' });
const seen = [];
const vc = new VoiceControl({ files, getCfg: () => ({ voice_model: 'small', voice_device: 'cpu' }), onChange: st => seen.push(st.perf.length) });
await vc.rescan();
vc.set({ state: 'on', model: 'small', device: 'cpu' });
vc.message({ type: 'text', text: 'a', dur: 4, ms: 2000 }); vc.message({ type: 'text', text: 'b' });
check(vc.state.perf.length === 1 && vc.state.perf[0].live.n === 1 && vc.state.perf[0].live.ratio === 0.5, 'a sentence with dur and ms is counted, one without is not');
for (let i = 0; i < 6; i++) vc.message({ type: 'text', text: 'c', dur: 1, ms: 2000 });
check(vc.state.advice === 'slow', 'the state tells when the running model falls behind');
await vc.saveLog(true);
check(JSON.parse(files.data.get('extensions/stt/bench.json')).live['small|cpu'].length === 7, 'the numbers are written to extensions/stt/bench.json');
const vc2 = new VoiceControl({ files, getCfg: () => ({}) });
await vc2.rescan();
check(vc2.state.perf.length === 1 && vc2.state.perf[0].model === 'small', 'and read again at the next start');
await vc2.addBench('small', 'cpu', { file: 'a.wav', dur: 10, ms: 3000, text: 'hi' });
check(vc2.state.perf[0].bench.ratio === 0.3 && JSON.parse(files.data.get('extensions/stt/bench.json')).bench['small|cpu'].text === 'hi', 'a speed test result is kept at once');
await vc2.forgetModel('small');
check(vc2.state.perf.length === 0, 'forgetting a model clears its numbers');
await vc2.clearLog();
check(JSON.parse(files.data.get('extensions/stt/bench.json')).v === 1, 'clearing writes an empty log');

// ---- a model of the list: get one by name, delete one
const calls = [];
const invoke = async (cmd, a) => { calls.push([cmd, a]); return {}; };
const listeners = {}; const listen = async (n, f) => { (listeners[n] ||= []).push(f); return () => { listeners[n] = listeners[n].filter(x => x !== f); }; };
const f2 = memoryFiles({ 'extensions/stt/engine-cpu/cmr-stt.exe': 'x', 'extensions/stt/models/ggml-base.bin': 'x', 'extensions/stt/models/ggml-base.bin.part': 'y' });
const inst = makeInstaller({ files: f2, invoke, listen, getCfg: () => ({ voice_model: '' }) });
await inst.install('model:small', () => {});
check(calls.length === 1 && calls[0][1].dest === 'extensions/stt/models/ggml-small.bin', 'model:<name> downloads just that model (not the one of the options)');
await inst.removeModel('base');
check(!f2.data.has('extensions/stt/models/ggml-base.bin') && !f2.data.has('extensions/stt/models/ggml-base.bin.part') && f2.data.has('extensions/stt/engine-cpu/cmr-stt.exe'), 'deleting a model removes its file (and the half download), the engine stays');
let err = ''; try { await inst.removeModel('../config'); } catch (e) { err = e.message; }
check(err === 'bad model name', 'a model name cannot lead out of the models folder');

// ---- the speed test, against a fake engine
check(benchArgs({ engine: 'cpu', model: 'small' }, '../bench/a.wav').join(' ') === '--bench ../bench/a.wav --model ../models/ggml-small.bin --device cpu', 'test arguments');
const fb = memoryFiles({ 'extensions/stt/engine-cpu/cmr-stt.exe': 'x', 'extensions/stt/models/ggml-small.bin': 'x', 'extensions/stt/models/ggml-base.bin': 'x',
  'extensions/stt/bench/talk.wav': 'w', 'extensions/stt/bench/notes.txt': 't', 'extensions/stt/bench/B.WAV': 'w' });
const emit = (n, p) => (listeners[n] || []).slice().forEach(f => f({ payload: p }));
const runs = [];
const inv3 = async (cmd, a) => {
  if (cmd === 'ext_run') {
    runs.push(a.args.join(' '));
    const model = /ggml-([^.]+)\.bin/.exec(a.args.join(' '))[1];
    setTimeout(() => {
      if (model === 'base') { emit('ext-line', { id: 'stt-bench', line: 'loading…' }); emit('ext-line', { id: 'stt-bench', line: '{"type":"status","state":"error","msg":"no good"}' }); }
      else emit('ext-line', { id: 'stt-bench', line: JSON.stringify({ type: 'bench', model, dur: 20, ms: 6000, load_ms: 700, text: 'hello there' }) });
      emit('ext-exit', { id: 'stt-bench', code: 0 });
    }, 5);
  }
  return {};
};
const bencher = makeBencher({ files: fb, invoke: inv3, listen, getCfg: () => ({ voice_device: 'cpu' }) });
check((await bencher.list()).join() === 'B.WAV,talk.wav', 'the test files are the .wav files of extensions/stt/bench');
const got = [], failed = [], says = [];
await bencher.run({ models: ['small', 'base', 'medium'], file: 'talk.wav', report: t => says.push(t), onResult: (m, d, r) => got.push([m, d, r]), onFail: (m, why) => failed.push([m, why]) });
check(runs.length === 2 && runs[0] === '--bench ../bench/talk.wav --model ../models/ggml-small.bin --device cpu', 'each installed model runs the same file, one after the other');
check(got.length === 1 && got[0][0] === 'small' && got[0][1] === 'cpu' && got[0][2].ms === 6000 && got[0][2].text === 'hello there' && got[0][2].file === 'talk.wav', 'the result of the engine is handed on with the file');
check(failed.map(f => f[0] + ':' + f[1]).join('|').startsWith('base:no good|medium:'), 'an engine error and a missing model are reported per model, the rest goes on');
check(says.some(t => t.includes('1/3 small')) && says.at(-1) === '' && !bencher.running, 'progress is reported and cleared; not running afterwards');
let e2 = ''; try { await bencher.run({ models: ['small'], file: '../x.wav', report() {}, onResult() {}, onFail() {} }); } catch (e) { e2 = e.message; }
check(e2 !== '', 'a file name that leads out is refused');
// cancel
const inv4 = async (cmd) => { if (cmd === 'ext_kill') setTimeout(() => emit('ext-exit', { id: 'stt-bench', code: 1 }), 1); return {}; };
const b4 = makeBencher({ files: fb, invoke: inv4, listen, getCfg: () => ({}) });
const got4 = [], fail4 = [];
const p4 = b4.run({ models: ['small', 'base'], file: 'talk.wav', report() {}, onResult: (m) => got4.push(m), onFail: (m, w) => fail4.push(m) });
await new Promise(r => setTimeout(r, 20)); b4.cancel(); await p4;
check(got4.length === 0 && fail4.length === 0 && !b4.running, 'cancelling stops the test without results or failures');
