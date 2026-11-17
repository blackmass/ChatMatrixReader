// Which sound is listened to, and what the options show about it (core/voice_target.js); the capture calls of the backend; the state of VoiceControl.
import { check } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import { applyTuning, T } from '../app/core/timings.js';
import { targetOf, captureOptions, captureText, methodOf, PCM, DISCORD_NAMES } from '../app/core/voice_target.js';
import { makeBackend } from '../app/voice_install.js';
import { VoiceControl } from '../app/core/voice.js';
import { tr } from '../app/core/i18n.js';

// ---- the target
applyTuning({});
const t = c => targetOf(c).target;
check(t({}).names === DISCORD_NAMES && t({}).skip_audio_service === true && t({ voice_target: 'discord' }).mode === 'app', 'Discord (voice chat): the Discord programs, without the video / web sound');
check(t({ voice_target: 'discord-all' }).skip_audio_service === false && t({ voice_target: 'discord-all' }).names.includes('discordptb.exe'), 'Discord (everything): all its sound');
check(t({ voice_target: 'wow' }).names.join() === 'wow*', 'WoW: any program that starts with wow');
check(t({ voice_target: 'system' }).mode === 'system', 'the whole system');
check(JSON.stringify(t({ voice_target: 'app', voice_app: 'chrome.exe' })) === JSON.stringify({ mode: 'app', names: ['chrome.exe'], role: '', sub: '', skip_audio_service: false }), 'a picked program: all its sound');
const job = t({ voice_target: 'app', voice_app: 'Discord.exe|utility|AudioService' });
check(job.names[0] === 'Discord.exe' && job.role === 'utility' && job.sub === 'AudioService', 'a picked job of a program: its role and sub');
check(targetOf({ voice_target: 'app', voice_app: '  ' }).error === 'no_app' && captureOptions({ voice_target: 'app' }).error === 'no_app', 'a program to pick but none picked: says so');

// ---- the options for the exe
const o = captureOptions({ voice_target: 'wow' }).options;
check(o.method === 'auto' && o.pcm === PCM && PCM === 's16' && o.poll === 0.25 && o.gate_peak === 0.002 && o.gate_hold === 1 && o.lose_after === 10 && o.no_audio === 8, 'defaults: auto, 16 bit, poll 0.25 s, gate 0.002 held 1 s, lost after 10 s, warn after 8 s (as in 2.x)');
check(methodOf({ voice_capture: 'device' }) === 'device' && methodOf({ voice_capture: 'process' }) === 'process' && methodOf({ voice_capture: 'x' }) === 'auto' && methodOf({}) === 'auto', 'method: auto unless the options say otherwise');
applyTuning({ VOICE_GATE_PERMILLE: 10, VOICE_POLL_MS: 100, VOICE_NOAUDIO_SEC: 0 });
const o2 = captureOptions({ voice_target: 'wow', voice_capture: 'device' }).options;
check(o2.gate_peak === 0.01 && o2.poll === 0.1 && o2.no_audio === 0 && o2.method === 'device', 'the timers of the options tab 고급 are used');
applyTuning({ VOICE_POLL_MS: 5 });
check(T.VOICE_POLL_MS === 250, 'a value outside its range is the default');
applyTuning({});

// ---- what the options say
check(captureText(null, tr) === '' && captureText({ mode: 'off' }, tr) === '', 'nothing while it is off');
check(captureText({ mode: 'none', status: 'waiting' }, tr).includes('기다리는'), 'waiting for the program');
check(captureText({ mode: 'process', program: 'Discord.exe', pid: 42, status: 'listening' }, tr) === '소리: 프로그램만 따로 받는 중 · Discord.exe (pid 42)', 'the program alone');
const dev = captureText({ mode: 'device', program: 'Discord.exe', device: 'Headset', gate: false, reason: 'initialize 0x88890021', status: 'listening' }, tr);
check(dev.includes('Headset') && dev.includes('0x88890021') && !dev.includes('막는 중'), 'the whole device: which device and why the single capture was not used (open / closed is on the loudness bar)');
check(captureText({ mode: 'system', device: 'Speakers' }, tr).includes('시스템 전체') && captureText({ mode: 'process', status: 'retry', reason: 'gone' }, tr).includes('다시 연결'), 'whole system / reconnecting');

// ---- the backend starts the sound with the engine and stops it first
const calls = []; const L = {}; let running = false;
const invoke = async (cmd, a) => { calls.push(cmd + (a && a.id ? ':' + a.id : '')); if (cmd === 'ext_run') running = true; if (cmd === 'ext_running') return running; if (cmd === 'ext_stdin') setTimeout(() => { running = false; }, 30); if (cmd === 'ext_kill') running = false; return null; };
const listen = async (n, f) => { (L[n] ||= []).push(f); return () => { L[n] = L[n].filter(x => x !== f); }; };
const emit = (n, p) => (L[n] || []).slice().forEach(f => f({ payload: p }));
const be = makeBackend({ invoke, listen, log: { info() {}, warn() {} } });
const msgs = []; be.onMessage = m => msgs.push(m);
await be.start({ voice_target: 'wow' }, { engine: 'cpu', model: 'small' });
check(calls.filter(c => c.startsWith('ext_run') || c.startsWith('capture')).join() === 'ext_run:stt,capture_start:stt', 'the engine starts first, then the sound goes to it');
emit('capture-state', { id: 'stt', mode: 'process', program: 'Wow.exe', pid: 7 }); emit('capture-state', { id: 'other', mode: 'device' });
emit('capture-warn', { id: 'stt', code: 'no_audio', msg: 'quiet' });
check(msgs.length === 2 && msgs[0].type === 'capture' && msgs[0].mode === 'process' && msgs[1].type === 'warn' && msgs[1].code === 'no_audio', 'capture state and warnings of this engine are handed on (others are not)');
calls.length = 0;
await be.stop();
check(calls[0] === 'capture_stop:stt' && calls.includes('ext_stdin:stt'), 'stopping: the sound first, then the engine');
// the engine ends by itself: the sound is stopped
await be.start({ voice_target: 'wow' }, { engine: 'cpu', model: 'small' }); calls.length = 0;
emit('ext-exit', { id: 'stt', code: 3 });
check(calls.includes('capture_stop:stt') && msgs.at(-1).type === 'exit', 'the engine ends: the capture ends with it');
// the capture cannot start: the engine is taken down again and the error goes up
const bad = makeBackend({ invoke: async (c, a) => { if (c === 'capture_start') throw new Error('Windows only'); calls.push(c); return null; }, listen, log: null });
let err = ''; calls.length = 0;
try { await bad.start({ voice_target: 'wow' }, { engine: 'cpu', model: 'small' }); } catch (e) { err = e.message; }
check(err === 'Windows only' && calls.includes('ext_kill') && calls.includes('capture_stop'), 'a failing capture takes the engine down and says why');
let err2 = ''; try { await be.start({ voice_target: 'app', voice_app: '' }, { engine: 'cpu', model: 'small' }); } catch (e) { err2 = e.message; }
check(err2.includes('프로그램') && !calls.slice(-1).includes('ext_run'), 'no program picked: refused before anything starts');

// ---- VoiceControl keeps the state and the warning
const vc = new VoiceControl({ files: memoryFiles(), getCfg: () => ({}) });
vc.set({ state: 'on' });
vc.message({ type: 'capture', mode: 'device', device: 'H', program: 'P', pid: 1, gate: true, level: 0.1, peak: 0.2, status: 'listening', reason: '' });
check(vc.state.capture.mode === 'device' && vc.state.capture.program === 'P' && vc.state.capture.gate === undefined, 'the capture state is kept (the gate and the loudness go the light way)');
vc.message({ type: 'warn', code: 'no_audio', seconds: 8, msg: 'no sound' });
check(vc.state.warn.includes('8초') && !vc.state.warn.includes('no sound'), 'a no-sound warning is kept, in the words of the program (not the English of the capture)');
vc.message({ type: 'warn', code: 'dropped', msg: 'x' });
check(vc.state.warn.includes('버렸습니다'), 'a dropped-sound warning too');
vc.message({ type: 'warn', code: 'audio_back', msg: 'back' });
check(vc.state.warn === '', 'and cleared when the sound is back');
vc.message({ type: 'warn', code: 'other', msg: 'x' });
check(vc.state.warn === '', 'other warnings are not shown there');
vc.message({ type: 'capture', mode: 'off' });
check(vc.state.capture === null, 'the capture ends: nothing is shown');
vc.message({ type: 'warn', code: 'no_audio', msg: 'again' }); vc.message({ type: 'capture', mode: 'process', status: 'listening' });
await vc.stop();
check(vc.state.capture === null && vc.state.warn === '', 'turned off: no capture line, no warning');
