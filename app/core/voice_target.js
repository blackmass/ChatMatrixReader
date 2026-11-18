// Whose sound the voice recognition listens to (the options 소리 대상 / 프로그램), and how: turned into what the exe's capture (src-tauri/src/capture.rs)
// is told. No sound here: this only decides WHICH sessions belong to the program, and the capture settings.
//
//   target  { mode: 'system' }                                          the default output device, everything
//           { mode: 'app', names, role, sub, skip_audio_service }        the program(s) with these file names ("wow*" = any ending);
//                                                                        role / sub: only that job of a Chromium program (renderer, utility + AudioService)
//   method  auto     the sound of that program alone first; if Windows refuses, the whole output device it plays on, passed on only while the program
//                    itself is audibly playing (the "gate")
//           process  the program alone only | device  always the whole device with the gate
import { T } from './timings.js';
import { OS } from '../platform.js';

export const DISCORD_NAMES = ['discord.exe', 'discordptb.exe', 'discordcanary.exe', 'discorddevelopment.exe'];
// the choices differ by system: Windows can take the sound of one program or of a whole output device (with a gate); on a Mac (ScreenCaptureKit) it is the
// program alone or the whole Mac, and there is no gate
export const methodsFor = os => (os === 'macos'
  ? [['auto', '자동 (프로그램만 따로 받고, 안 되면 시스템 전체)'], ['process', '프로그램만 따로 받기'], ['device', '시스템 전체 소리 받기 (프로그램을 가리지 않음)']]
  : [['auto', '자동 (프로그램만 따로 받고, 안 되면 장치 전체)'], ['process', '프로그램만 따로 받기'], ['device', '장치 전체를 받고 프로그램이 소리 낼 때만 통과']]);
export const METHODS = methodsFor(OS);
export const PCM = 's16';          // what the engine reads: 16 kHz mono 16 bit little endian ('f32' = float is understood by the capture too)

// on a Mac the programs are told by their name or bundle id (the capture matches both, "*" = any ending); there are no sound sessions to tell
// Discord's voice chat from its other sounds, so 'discord' and 'discord-all' are the same there
export const MAC_NAMES = { wow: ['world of warcraft*', 'com.blizzard.worldofwarcraft*', 'wow*'], discord: ['discord*', 'com.hnc.discord*'] };

// -> { target } or { error: 'no_app' }
export function targetOf(cfg, os = OS) {
  const mac = os === 'macos';
  switch (cfg.voice_target || 'discord') {
    case 'system': return { target: { mode: 'system' } };
    case 'wow': return { target: { mode: 'app', names: mac ? MAC_NAMES.wow : ['wow*'], role: '', sub: '', skip_audio_service: false } };
    case 'discord-all': return { target: { mode: 'app', names: mac ? MAC_NAMES.discord : DISCORD_NAMES, role: '', sub: '', skip_audio_service: false } };
    case 'app': {
      // 'chrome.exe' = every sound of the program, 'chrome.exe|utility|AudioService' = one job of it (the picker of the options)
      const [exe, role = '', sub = ''] = String(cfg.voice_app || '').trim().split('|');
      if (!exe) return { error: 'no_app' };
      return { target: { mode: 'app', names: [exe], role: mac ? '' : role === 'main' ? 'main' : role, sub: mac ? '' : sub, skip_audio_service: false } };
    }
    default: return { target: { mode: 'app', names: mac ? MAC_NAMES.discord : DISCORD_NAMES, role: '', sub: '', skip_audio_service: !mac } };     // 'discord': the voice chat, not the videos
  }
}

export const methodOf = cfg => (['process', 'device'].includes(cfg.voice_capture) ? cfg.voice_capture : 'auto');

// everything capture_start needs (the timer values are the ones of the options tab 고급)
export function captureOptions(cfg, os = OS) {
  const t = targetOf(cfg, os);
  if (t.error) return t;
  return {
    options: {
      target: t.target, method: methodOf(cfg), pcm: PCM, framed: true,
      poll: T.VOICE_POLL_MS / 1000, gate_peak: T.VOICE_GATE_PERMILLE / 1000, gate_hold: T.VOICE_GATE_HOLD_MS / 1000,
      lose_after: T.VOICE_LOSE_SEC, no_audio: T.VOICE_NOAUDIO_SEC,
    },
  };
}

// the line of the options that says how the sound is received now (state.capture: the `capture-state` event of the exe)
export function captureText(c, tr) {
  if (!c || c.mode === 'off') return '';
  const who = c.program ? ' · ' + c.program : '';
  if (c.status === 'retry' || c.status === 'reconnecting') return tr('소리: 다시 연결하는 중입니다') + (c.reason ? ' (' + c.reason + ')' : '');
  switch (c.mode) {
    case 'process': return tr('소리: 프로그램만 따로 받는 중') + who + (c.pid ? ' (pid ' + c.pid + ')' : '');
    case 'device': {
      const refused = c.reason ? ' · ' + tr('프로그램만 따로 받기는 안 됨') + ': ' + c.reason : '';
      return tr('소리: 장치 전체를 받고 프로그램이 소리 낼 때만 통과') + who + ' · ' + c.device + refused;       // (open / closed is shown on the loudness bar)
    }
    case 'system': return tr('소리: 시스템 전체') + ' · ' + c.device + (c.program && c.reason ? ' · ' + tr('프로그램만 따로 받기는 안 됨') + ': ' + c.reason : '');
    default: return tr('소리: 프로그램이 소리를 낼 때까지 기다리는 중');
  }
}
