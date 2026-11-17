// How fast each Whisper model is on this computer. Two kinds of numbers, kept per "model + device" (the same model is much slower on the CPU):
//   live  = measured while the voice recognition runs: every sentence the engine hands in carries `dur` (seconds of speech) and `ms` (time it took
//           to recognise it); the last KEEP sentences are kept.
//   bench = the speed test: the same sound file run through the model with the engine's `--bench` mode, so models can be compared fairly.
// The main number is the ratio  recognising time / speech time:  0.4 = 10 seconds of speech are done in 4 seconds,  1 = just keeps up,  above 1 = falls behind.
// Kept in extensions/stt/bench.json (inside the program folder, like everything of the extension).
//
//   engine line of the test:  {"type":"bench","model":"small","dur":12.3,"ms":4100,"load_ms":900,"text":"what it heard"}
//     (the engine loads the model, runs the file once to warm up, runs it again and reports the second run's time; then it ends)
import { FOLDER } from './voice_catalog.js';

export const BENCH_DIR = FOLDER + '/bench';          // the sound files for the test (.wav) are put here
export const BENCH_FILE = FOLDER + '/bench.json';
export const KEEP = 30;                              // sentences kept per model
export const SLOW_AFTER = 5;                         // "falls behind" is only said after this many sentences

export const keyOf = (model, device) => `${model}|${device === 'gpu' ? 'gpu' : 'cpu'}`;
export const emptyLog = () => ({ v: 1, live: {}, bench: {} });

const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// the file as text -> the log (a broken or foreign file gives an empty log)
export function parseLog(text) {
  const out = emptyLog();
  let o; try { o = JSON.parse(text || ''); } catch { return out; }
  if (!o || o.v !== 1) return out;
  for (const [k, list] of Object.entries(o.live || {})) {
    if (!Array.isArray(list)) continue;
    const ok = list.filter(s => Array.isArray(s) && num(s[0]) !== null && num(s[1]) !== null).slice(-KEEP).map(s => [s[0], s[1], num(s[2]) || 0]);
    if (ok.length) out.live[k] = ok;
  }
  for (const [k, b] of Object.entries(o.bench || {})) {
    if (b && num(b.dur) !== null && num(b.ms) !== null) out.bench[k] = { file: String(b.file || ''), dur: b.dur, ms: b.ms, load_ms: num(b.load_ms), text: String(b.text || '').slice(0, 400), at: num(b.at) || 0 };
  }
  return out;
}
export const stringify = log => JSON.stringify(log);

// one sentence of the running recognition. A sentence with no speech length or time (an engine that does not tell) is not counted.
export function recordLive(log, model, device, dur, ms, at = Date.now()) {
  if (!model || !(num(dur) > 0) || num(ms) === null) return false;
  const k = keyOf(model, device), list = log.live[k] || (log.live[k] = []);
  list.push([dur, ms, at]);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  return true;
}
export function recordBench(log, model, device, r, at = Date.now()) {
  if (!model || !(num(r && r.dur) > 0) || num(r.ms) === null) return false;
  log.bench[keyOf(model, device)] = { file: String(r.file || ''), dur: r.dur, ms: r.ms, load_ms: num(r.load_ms), text: String(r.text || '').slice(0, 400), at };
  return true;
}
export function forget(log, model) {            // a model that is deleted loses its numbers (every device)
  for (const part of [log.live, log.bench]) for (const k of Object.keys(part)) if (k.split('|')[0] === model) delete part[k];
}

// samples [[dur, ms]] -> { n, ratio, avgMs, speech }  (null when there is nothing)
export function summarize(samples) {
  if (!samples || !samples.length) return null;
  let dur = 0, ms = 0;
  for (const s of samples) { dur += s[0]; ms += s[1]; }
  if (!(dur > 0)) return null;
  return { n: samples.length, ratio: ms / (dur * 1000), avgMs: ms / samples.length, speech: dur };
}

// the table of the options: one entry per model+device that has numbers
export function table(log) {
  const keys = new Set([...Object.keys(log.live), ...Object.keys(log.bench)]), out = [];
  for (const k of keys) {
    const [model, device] = k.split('|');
    const b = log.bench[k];
    out.push({ model, device, live: summarize(log.live[k]), bench: b ? { ratio: b.ms / (b.dur * 1000), dur: b.dur, ms: b.ms, file: b.file, text: b.text, load_ms: b.load_ms, at: b.at } : null });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.device.localeCompare(b.device));
}

// 'slow' when the recognition of this model falls behind the speech (enough sentences, ratio above 1), else ''
export function advice(log, model, device) {
  const s = summarize(log.live[keyOf(model, device)]);
  return s && s.n >= SLOW_AFTER && s.ratio > 1 ? 'slow' : '';
}

export const ratioText = r => (typeof r === 'number' && Number.isFinite(r) ? '×' + (r < 10 ? r.toFixed(2) : r.toFixed(1)) : '-');
