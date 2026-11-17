// The talk between this program and the engine program (extensions/stt/engine-<kind>/cmr-stt.exe).
//   program -> engine:  command line (engineArgs), then on its standard input (`--framed`: frames, engine/stt/src/protocol.h) the sound: 16 kHz mono,
//                       `--pcm s16` = 16 bit / `f32` = float, little endian, a continuous stream (the exe fills pauses with silence), and control messages
//                       (liveOf: language, hint ... while it runs)
//   engine -> program:  one JSON object per line on its standard output (same lines as the 2.x engine, pipeline.onVoice reads them):
//     {"type":"status","state":"ready","device":"cpu"|"gpu"}    {"type":"text","text":"...","lang":"ko"}   {"type":"partial","text":"..."}
//     a "text" line also carries "dur" (seconds of speech) and "ms" (time to recognise it): the speed of the model is shown from them (core/voice_bench.js)
//     {"type":"level","db":-41.2,"peak":0.12,"speech":true,"thr":-44.4}   about ten a second: loudness of what the engine hears, a sentence is open, the speech limit
//     {"type":"applied",...}   the answer to a control message
//     {"type":"warn","msg":"..."}   {"type":"stats","cpu":12,"ram":900,"gpu":30,"vram":2100,"device":"gpu"}   {"type":"status","state":"error","msg":"..."}
import { modelPath, engineDir } from './voice_catalog.js';
import { PCM } from './voice_target.js';

const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };

// Arguments are relative to the engine's own folder (it is started there): ../models/ggml-<name>.bin
export function engineArgs(cfg, plan) {
  const rel = modelPath(plan.model).replace('extensions/stt/', '../');
  const args = ['--model', rel, '--device', plan.engine === 'cpu' ? 'cpu' : 'gpu',
    '--lang', (cfg.voice_lang || 'auto'), '--end-ms', String(clamp(cfg.voice_end_ms, 200, 5000, 700)), '--max-s', String(clamp(cfg.voice_max_s, 3, 30, 12)),
    '--min-db', String(clamp(cfg.voice_min_db, -60, -25, -44)), '--mode', cfg.voice_mode === 'live' ? 'live' : 'sentence', '--pcm', PCM, '--rate', '16000', '--framed'];
  if (cfg.voice_mode === 'live') args.push('--partial-ms', String(clamp(cfg.voice_partial_ms, 300, 5000, 1000)));
  const prompt = (cfg.voice_prompt || '').trim();
  if (prompt) args.push('--prompt', prompt.slice(0, 400));
  return args;
}

// What can be changed while the engine runs (sent as a control message, no restart): the language, the hint, the quiet time that ends a sentence, the longest
// piece, the display mode. The model and the device cannot (they are loaded when the engine starts).
export function liveOf(cfg) {
  return {
    lang: cfg.voice_lang || 'auto', prompt: (cfg.voice_prompt || '').trim().slice(0, 400),
    end_ms: clamp(cfg.voice_end_ms, 200, 5000, 700), max_s: clamp(cfg.voice_max_s, 3, 30, 12), min_db: clamp(cfg.voice_min_db, -60, -25, -44),
    mode: cfg.voice_mode === 'live' ? 'live' : 'sentence', partial_ms: clamp(cfg.voice_partial_ms, 300, 5000, 1000),
  };
}

// A control message as the text that goes to the engine's input: "CMRFC" + the length of the JSON in bytes (8 hexadecimal digits) + the JSON
// (engine/stt/src/protocol.h). The header is ASCII so that it can be written as text.
export function controlFrame(obj) {
  const json = JSON.stringify(obj);
  return 'CMRFC' + new TextEncoder().encode(json).length.toString(16).padStart(8, '0') + json;
}

// The speed test: one sound file through one model, then the engine ends (it prints {"type":"bench","dur":s,"ms":ms,"load_ms":ms,"text":"..."}).
// `file` is relative to the engine's folder (../bench/<name>.wav).
export function benchArgs(plan, file) {
  return ['--bench', file, '--model', modelPath(plan.model).replace('extensions/stt/', '../'), '--device', plan.engine === 'cpu' ? 'cpu' : 'gpu'];
}

// One line of the engine -> the message, or null when it is not one (the engine's own log lines are not).
export function parseLine(line) {
  const t = String(line || '').trim();
  if (!t.startsWith('{')) return null;
  try { const m = JSON.parse(t); return m && typeof m.type === 'string' ? m : null; } catch { return null; }
}

export const engineFolder = engineDir;
