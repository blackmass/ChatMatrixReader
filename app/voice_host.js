// Voice recognition in the hub: the on / off state (core/voice.js), told to the options window ('voice-state'), which asks with
// 'voice-hello' (the state now), 'voice-toggle' (on / off), 'voice-install' { what } and 'voice-remove'.
// Installing / taking away / starting the engine is done by `installer` and `backend` (voice_install.js, through the generic tools of the exe);
// without them (older exe) the messages say so. What is installed is read from the folder extensions/stt/ as it is.
import { VoiceControl } from './core/voice.js';
import { log } from './core/log.js';
import { explain } from './voice_install.js';
import { tr } from './core/i18n.js';
import { stateWhy } from './core/voice_text.js';
import { voiceWidgetState, VOICE_ID } from './widgets/core_voice.js';
import { isMac, voiceSupported, OS_VERSION } from './platform.js';

const { emit, listen } = window.__TAURI__.event;

// `onActive(on)`: told when the voice recognition is turned on (starting or running) and when it is off (the windows "only while it is on" follow it)
export function startVoice({ settings, files, publish, pipeline, backend = null, installer = null, bencher = null, onActive = () => {}, widgets = null }) {
  let lastShown = '', lampKey = '', active = false, lastLevel = null;
  // the official widget (core:voice-level): the state of the voice recognition as the state of a widget; a loudness reading is only worked out while a window shows it
  const pushWidget = (force = true) => { if (widgets && (force || widgets.isUsed(VOICE_ID))) widgets.publish(VOICE_ID, voiceWidgetState(control.state, lastLevel, tr)); };
  // the speaker icon of the windows: on / off / starting / error (+ why), not the whole state
  const lampOf = s => ({ state: s.state, text: s.state === 'error' ? stateWhy(s) : '' });
  const control = new VoiceControl({
    files, backend, getCfg: () => settings.cfg(),
    onLevel: l => { emit('voice-level', l); if (l.source === 'engine' || !lastLevel || lastLevel.source !== 'engine' || performance.now() - (lastLevel.at || 0) > 1500) { lastLevel = { ...l, at: performance.now() }; pushWidget(false); } },       // (the loudness bar of the options: not part of the state)
    onChange: s => {
      emit('voice-state', s);
      if (s.state === 'off' || s.state === 'error') lastLevel = null;
      pushWidget();
      const lamp = lampOf(s), lk = lamp.state + '|' + lamp.text;
      if (lk !== lampKey) { lampKey = lk; emit('voice-lamp', lamp); }
      const now = s.state === 'on' || s.state === 'starting';
      if (now !== active) { active = now; onActive(now); }
      const key = s.state + '|' + s.code + '|' + s.msg;
      if (key === lastShown) return;
      lastShown = key;
      log.info(`음성 인식: ${s.state}${s.code ? ' (' + s.code + ')' : ''}${s.msg ? ' ' + s.msg : ''}`);
      // not installed: the same note in the chat window as 2.0 (the other errors are shown in the options, where the button was pressed)
      if (s.state === 'error' && s.code === 'not_installed') publish(pipeline.onVoice({ type: 'status', state: 'error', msg: 'not installed' }));
    },
  });
  // the lines of the engine: the chat (pipeline) and the state
  // (an engine that ends while it is being stopped is no news: the chat only hears about one that ended by itself)
  const onMessage = m => { const expected = m.type === 'exit' && (control.state.state === 'stopping' || control.state.state === 'off'); control.message(m); publish(pipeline.onVoice(expected ? { ...m, expected } : m)); };
  if (backend) backend.onMessage = onMessage;

  // macOS before 13 has no sound capture we can use: the voice recognition is never started there (the options show a note instead of the settings)
  if (isMac && !voiceSupported) {
    control.set({ unsupported: 'mac' });
    log.info(`음성 인식: macOS ${OS_VERSION}에서는 지원하지 않습니다 (macOS 13 이상 필요)`);
    listen('voice-hello', () => emit('voice-state', control.state));
    listen('voice-lamp-hello', () => emit('voice-lamp', lampOf(control.state)));
    return { control, onMessage: () => {} };
  }
  listen('voice-hello', async () => { await control.rescan(); emit('voice-state', control.state); });
  listen('voice-toggle', () => control.toggle());
  listen('voice-lamp-hello', () => emit('voice-lamp', lampOf(control.state)));       // (a window that was just opened asks for the icon)
  listen('voice-restart', () => control.restart());                // (the options changed that only a restart applies)
  settings.onChange(() => control.cfgChanged());                    // (what is followed while it runs: see core/voice.js)
  listen('voice-install', async ev => {
    if (!installer) { control.set({ task: 'no_installer' }); return; }
    if (control.state.busy) return;
    control.set({ busy: true, task: '' });
    try { await installer.install(ev.payload.what, t => control.set({ task: t })); }
    catch (e) { control.set({ task: explain(e) }); log.warn('음성 확장 설치: ' + String(e?.message || e)); }
    control.set({ busy: false }); await control.rescan();
  });
  listen('voice-cancel', () => { if (installer && installer.cancel) installer.cancel(); });
  listen('voice-remove', async () => {
    if (!installer) { control.set({ task: 'no_installer' }); return; }
    if (control.state.busy) return;
    control.set({ busy: true, task: '' });
    try { await control.stop(); await installer.remove(); } catch (e) { control.set({ task: explain(e) }); }
    control.set({ busy: false }); await control.rescan();
  });

  // ---- the model list and the speed test of the options
  listen('voice-model-install', async ev => {
    if (!installer) { control.set({ task: 'no_installer' }); return; }
    if (control.state.busy || control.state.benchTask) return;
    control.set({ busy: true, task: '' });
    try { await installer.install('model:' + String(ev.payload.name || ''), t => control.set({ task: t })); }
    catch (e) { control.set({ task: explain(e) }); log.warn('음성 모델 설치: ' + String(e?.message || e)); }
    control.set({ busy: false }); await control.rescan();
  });
  listen('voice-model-remove', async ev => {
    if (!installer || !installer.removeModel) { control.set({ task: 'no_installer' }); return; }
    const name = String(ev.payload.name || '');
    if (control.state.busy || control.state.benchTask) return;
    if (name === control.state.model && (control.state.state === 'on' || control.state.state === 'starting')) { control.set({ task: tr('지금 쓰고 있는 모델입니다. 먼저 음성인식을 끄세요.') }); return; }
    control.set({ busy: true, task: '' });
    try { await installer.removeModel(name); await control.forgetModel(name); } catch (e) { control.set({ task: explain(e) }); }
    control.set({ busy: false }); await control.rescan();
  });
  const benchFiles = async () => { control.set({ benchFiles: bencher ? await bencher.list() : [] }); };
  listen('voice-bench-files', () => benchFiles());
  listen('voice-bench', async ev => {
    if (!bencher) { control.set({ benchTask: '', task: 'no_installer' }); return; }
    if (control.state.busy || control.state.benchTask) return;
    if (control.state.state !== 'off' && control.state.state !== 'error') { control.set({ task: tr('속도 시험은 음성인식이 꺼져 있을 때만 할 수 있습니다. (켜져 있으면 서로 느리게 만듭니다)') }); return; }
    const { models, file } = ev.payload || {};
    if (!Array.isArray(models) || !models.length) { control.set({ task: tr('시험할 모델을 고르세요.') }); return; }
    control.set({ benchTask: '…', task: '', benchFail: {} });
    const fail = {};
    try {
      await bencher.run({ models, file, report: t => control.set({ benchTask: t || '…' }),
        onResult: (model, device, r) => control.addBench(model, device, r),
        onFail: (model, why) => { fail[model] = why; control.set({ benchFail: { ...fail } }); } });
    } catch (e) { control.set({ task: explain(e) }); log.warn('음성 속도 시험: ' + String(e?.message || e)); }
    control.set({ benchTask: '', benchFail: { ...fail } });
  });
  listen('voice-bench-cancel', () => { if (bencher) bencher.cancel(); });
  listen('voice-perf-clear', () => control.clearLog());

  control.rescan().then(() => { if (settings.cfg().voice_enabled) control.start(); });      // "start with the program"
  return { control, onMessage };
}
