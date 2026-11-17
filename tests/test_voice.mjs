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
