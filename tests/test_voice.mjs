// Voice recognition: what counts as installed, which engine a start picks, and the on / off state.
import { check } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import { scan, plan, VoiceControl, deviceOf, modelOf } from '../app/core/voice.js';

const base = { voice_engine: 'whisper', voice_device: 'auto', voice_model: '', voice_oa_url: '' };
check(JSON.stringify(await scan(memoryFiles())) === '{"engines":[],"models":[]}', 'nothing in the folder: nothing installed');
const full = memoryFiles({ 'extensions/stt/engine-cpu/stt.exe': 'x', 'extensions/stt/engine-vulkan/stt.exe': 'x', 'extensions/stt/models/ggml-base.bin': 'x',
  'extensions/stt/models/ggml-large-v3-turbo.bin': 'x', 'extensions/stt/models/ggml-base.bin.part': 'x', 'extensions/stt/tmp/a': 'x' });
const inst = await scan(full);
check(inst.engines.join() === 'cpu,vulkan' && inst.models.join() === 'base,large-v3-turbo', 'engines are folders, models are ggml-*.bin (a file still being downloaded does not count)');

check(deviceOf({ voice_device: 'cuda' }) === 'gpu' && deviceOf({ voice_device: 'x' }) === 'auto' && modelOf({ voice_model: ' ' }) === 'large-v3-turbo', "2.0's 'cuda' is the GPU; an empty model is the default");
check(plan(base, { engines: [], models: [] }).error === 'not_installed', 'no engine: not installed');
check(plan(base, inst).engine === 'vulkan' && plan(base, inst).model === 'large-v3-turbo', 'auto: the GPU engine when there is one');
check(plan({ ...base, voice_device: 'cpu' }, inst).engine === 'cpu', 'cpu asked: the CPU engine');
check(plan({ ...base, voice_device: 'gpu' }, { engines: ['cpu'], models: ['base'] }).error === 'not_installed', 'GPU asked, only the CPU engine: cannot start');
check(plan(base, { engines: ['cpu', 'vulkan', 'cuda'], models: ['large-v3-turbo'] }).engine === 'cuda', 'CUDA before Vulkan');
// the Mac engine: one program for the GPU and the CPU; the plan says which one it is told to use
{
  const mac = { engines: ['metal'], models: ['large-v3-turbo'] };
  const pa = plan(base, mac), pc = plan({ ...base, voice_device: 'cpu' }, mac), pg = plan({ ...base, voice_device: 'gpu' }, mac);
  check(pa.engine === 'metal' && pa.device === 'gpu' && pg.device === 'gpu', 'metal: auto and GPU -> the GPU');
  check(pc.engine === 'metal' && pc.device === 'cpu', 'metal: CPU asked -> the same engine, told to use the CPU');
  const { engineArgs, benchArgs } = await import('../app/core/voice_proto.js');
  const dev = a => a[a.indexOf('--device') + 1];
  check(dev(engineArgs({}, pc)) === 'cpu' && dev(engineArgs({}, pg)) === 'gpu' && dev(benchArgs(pc, 'f.wav')) === 'cpu', 'the device of the plan goes to the engine');
  const { exePath, exeName, mergeCatalog, BUILTIN } = await import('../app/core/voice_catalog.js');
  check(exePath('metal') === 'extensions/stt/engine-metal/cmr-stt' && exePath('cpu') === 'extensions/stt/engine-cpu/cmr-stt.exe' && exeName('vulkan') === 'cmr-stt.exe', 'the Mac engine has no .exe');
  check(mergeCatalog('').engines.metal.files.length === BUILTIN.engines.metal.files.length && mergeCatalog(JSON.stringify({ engines: { metal: { files: [{ name: 'cmr-stt', url: 'https://x/y' }] } } })).engines.metal.files[0].name === 'cmr-stt', 'the catalog knows metal');
  const vc = new VoiceControl({ files: memoryFiles(), getCfg: () => base });
  vc.applied = vc.snapshot(base, pg);
  vc.state.installed = mac; vc.updatePending({ ...base, voice_device: 'cpu' });
  check(vc.state.pending.includes('device'), 'metal: GPU -> CPU while running is "restart needed" (same engine, other device)');
}
check(plan({ ...base, voice_model: 'small' }, inst).error === 'no_model', 'a model that is not there');
check(plan({ ...base, voice_engine: 'openai' }, inst).error === 'no_url' && plan({ ...base, voice_engine: 'openai', voice_oa_url: 'http://x/v1' }, { engines: [], models: [] }).engine === 'server', 'server: needs an address, not Whisper');

let cfg = { ...base }, seen = [];
let c = new VoiceControl({ files: memoryFiles(), getCfg: () => cfg, onChange: s => seen.push(s.state + ':' + s.code) });
await c.start();
check(c.state.state === 'error' && c.state.code === 'not_installed', 'turned on with nothing installed: says so');
await c.stop();
check(c.state.state === 'off' && c.state.code === '', 'off clears the error');
c = new VoiceControl({ files: full, getCfg: () => cfg });
await c.start();
check(c.state.code === 'no_backend', 'installed, but this build cannot start programs: says so');

const calls = [];
const backend = { start: async (_, p) => { calls.push('start ' + p.engine + ' ' + p.model); }, stop: async () => { calls.push('stop'); } };
c = new VoiceControl({ files: full, backend, getCfg: () => cfg });
await c.toggle();
check(c.state.state === 'starting' && calls.join() === 'start vulkan large-v3-turbo', 'the engine is started with the plan');
c.message({ type: 'status', state: 'ready', device: 'gpu' });
check(c.state.state === 'on' && c.state.device === 'gpu', 'the engine says it is ready: on');
c.message({ type: 'stats', cpu: 12, ram: 900, gpu: 30, vram: 1800 });
check(c.state.stats.vram === 1800, 'resources are kept');
await c.toggle();
check(c.state.state === 'off' && c.state.stats === null && calls.at(-1) === 'stop', 'toggle while on: stopped');
await c.start(); c.message({ type: 'status', state: 'ready' }); c.message({ type: 'exit', code: 3 });
check(c.state.state === 'error' && c.state.msg === 'exit 3', 'the engine ended by itself: an error');
c = new VoiceControl({ files: full, backend: { start: async () => { throw new Error('boom'); }, stop: async () => {} }, getCfg: () => cfg });
await c.start();
check(c.state.state === 'error' && c.state.msg === 'boom', 'a start that fails');
