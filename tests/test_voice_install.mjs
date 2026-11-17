// The installer and the engine backend of the voice extension, against a fake exe (invoke / listen given in).
import { check } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import { makeInstaller, makeBackend, explain } from '../app/voice_install.js';
import { mergeCatalog, exePath, modelPath, BUILTIN } from '../app/core/voice_catalog.js';
import { engineArgs, parseLine } from '../app/core/voice_proto.js';
import { plan, modelOf } from '../app/core/voice.js';

// ---- catalog
const merged = mergeCatalog(JSON.stringify({ engines: { cpu: { files: [{ name: 'cmr-stt.exe', url: 'https://x/e.exe', sha256: 'A'.repeat(64) }] }, nope: { files: [] } },
  models: { small: { url: 'https://x/s.bin' }, '../bad': { url: 'https://x' }, odd: { url: 'ftp://x' } } }));
check(merged.engines.cpu.files[0].sha256 === 'a'.repeat(64) && merged.models.small.url === 'https://x/s.bin', 'catalog.json entries replace the built-in ones');
check(merged.problems.join('|') === 'engine nope|model ../bad|model odd', 'wrong entries are left out and named');
check(mergeCatalog('{oops').problems.length === 1 && mergeCatalog('').models.base.url.startsWith('https://huggingface.co/'), 'a broken catalog.json changes nothing');
check(Object.values(BUILTIN.models).every(m => m.url.startsWith('https://')), 'built-in addresses are https');

// ---- default model follows the engine
check(modelOf({ voice_model: '' }, 'cpu') === 'large-v3-turbo' && modelOf({ voice_model: '' }, 'vulkan') === 'large-v3-turbo' && modelOf({ voice_model: 'base' }, 'cpu') === 'base', 'default model: large-v3-turbo on every engine (as in 2.x), what is written wins');
check(plan({ voice_device: 'cpu' }, { engines: ['cpu'], models: [] }).model === 'large-v3-turbo', 'plan wants the default model for the CPU engine too');

// ---- installer
const calls = [], listeners = {};
const invoke = async (cmd, a) => { calls.push([cmd, a]); if (cmd === 'ext_download' && a.url.includes('fail')) throw new Error('HTTP 404'); return { ok: true }; };
const listen = async (name, f) => { listeners[name] = f; return () => { delete listeners[name]; }; };
const files = memoryFiles({ 'extensions/stt/catalog.json': JSON.stringify({ engines: { cpu: { files: [{ name: 'cmr-stt.exe', url: 'https://x/e.exe', sha256: '' }] } }, models: { 'large-v3-turbo': { url: 'https://x/small.bin', sha256: 'b'.repeat(64) } } }) });
const reports = [];
const inst = makeInstaller({ files, invoke, listen, getCfg: () => ({ voice_model: '' }) });
const r = await inst.install('cpu', t => reports.push(t));
check(calls.map(c => c[0] + ' ' + c[1].dest).join('|') === 'ext_download extensions/stt/engine-cpu/cmr-stt.exe|ext_download extensions/stt/models/ggml-large-v3-turbo.bin', 'installing the CPU engine downloads the engine, then the model it would use');
check(calls[1][1].sha256 === 'b'.repeat(64) && calls[0][1].sha256 === null && r.steps === 2, 'the checksum goes along (none = null)');
check(reports.some(t => t.includes('cmr-stt.exe')) && reports.at(-1) === '', 'progress is reported, and cleared at the end');
let err = '';
try { await inst.install('cuda', () => {}); } catch (e) { err = e.message; }
check(err.includes('올라와') || err.includes('published'), 'an engine without an address says so (CUDA: planned, never released)');
calls.length = 0;
files.data.set('extensions/stt/models/ggml-large-v3-turbo.bin', 'x');
await inst.install('cpu', () => {});
check(calls.length === 1, 'a model that is already there is not downloaded again');
calls.length = 0;
await inst.install('model', () => {});
check(calls.length === 0, 'only the model: nothing to do when it is there');
const bad = makeInstaller({ files: memoryFiles({ 'extensions/stt/catalog.json': JSON.stringify({ models: { small: { url: 'https://x/fail.bin' } } }) }), invoke, listen, getCfg: () => ({ voice_model: 'small' }) });
err = '';
try { await bad.install('model', () => {}); } catch (e) { err = e.message; }
check(err === 'HTTP 404' && explain(new Error('cancelled')).includes('이어서') && explain(new Error('sha256 mismatch')).includes('손상'), 'a failed download is explained');
calls.length = 0; await inst.remove();
check(calls.length === 1 && calls[0][0] === 'ext_remove' && calls[0][1].path === 'extensions/stt', 'removing = the whole extension folder');

// ---- arguments and lines
const a = engineArgs({ voice_lang: 'ko', voice_end_ms: 99999, voice_max_s: 'x', voice_mode: 'live', voice_partial_ms: 1000, voice_prompt: ' Tank ' }, { engine: 'vulkan', model: 'small' });
check(a.join(' ') === '--model ../models/ggml-small.bin --device gpu --lang ko --end-ms 5000 --max-s 12 --min-db -44 --mode live --pcm s16 --rate 16000 --framed --partial-ms 1000 --prompt Tank', 'engine arguments: relative model path, limits, hint');
check(engineArgs({}, { engine: 'cpu', model: 'base' }).slice(0, 4).join(' ') === '--model ../models/ggml-base.bin --device cpu', 'cpu engine: device cpu');
check(parseLine('{"type":"text","text":"hi"}').text === 'hi' && parseLine('loading model…') === null && parseLine('{bad') === null && parseLine('{"x":1}') === null, 'engine lines: JSON objects with a type, anything else is a log line');

// ---- backend
const ran = [], msgs = [], logs = [];
let running = false;
const inv2 = async (cmd, a) => { ran.push(cmd); if (cmd === 'ext_run') { running = true; return { ok: true }; } if (cmd === 'ext_running') return running; if (cmd === 'ext_stdin') { setTimeout(() => { running = false; }, 150); } if (cmd === 'ext_kill') running = false; return null; };
const L = {}; const listen2 = async (n, f) => { L[n] = f; return () => { delete L[n]; }; };
const be = makeBackend({ invoke: inv2, listen: listen2, log: { info: t => logs.push(t), warn: t => logs.push(t) } });
be.onMessage = m => msgs.push(m.type + ':' + (m.state || m.text || m.code));
await be.start({ voice_lang: 'auto' }, { engine: 'cpu', model: 'small' });
L['ext-line']({ payload: { id: 'stt', line: '{"type":"status","state":"ready","device":"cpu"}' } });
L['ext-line']({ payload: { id: 'stt', line: 'loading…' } });
L['ext-line']({ payload: { id: 'other', line: '{"type":"text","text":"no"}' } });
check(ran[0] === 'ext_run' && msgs.join() === 'status:ready' && logs.length === 1, 'the engine is started; its JSON lines become messages, other lines go to the log, other programs are ignored');
await be.stop();
check(ran.includes('ext_stdin') && !ran.includes('ext_kill'), 'stop: closes its input and waits for it to end (no kill)');
running = true; ran.length = 0;
const stuck = makeBackend({ invoke: async (c, a) => { ran.push(c); return c === 'ext_running' ? true : null; }, listen: listen2 });
await stuck.stop();
check(ran.at(-1) === 'ext_kill', 'stop: an engine that does not end is killed');
L['ext-exit']?.({ payload: { id: 'stt', code: 3 } });
check(msgs.at(-1) === 'exit:3', 'its end is reported');
let sErr = '';
try { await be.start({}, { engine: 'server', model: '' }); } catch (e) { sErr = e.message; }
check(sErr.length > 0, 'the server engine is not connected yet: says so');
