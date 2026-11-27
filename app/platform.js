// Which system the program runs on: 'windows' | 'macos' | something else. Asked of the exe once (the command os_kind); a page that does not run in the
// program (the tests) gets 'windows'. The pages work the same everywhere; only the few things a system cannot do (the voice recognition on a macOS
// before 13) look at this.
export const OS = await (async () => {
  try {
    const t = globalThis.__TAURI__;
    if (!t || !t.core) return 'windows';
    const kind = await t.core.invoke('os_kind');
    return typeof kind === 'string' && kind ? kind : 'windows';
  } catch { return 'windows'; }       // (an older exe does not know the command: it is Windows)
})();
export const isMac = OS === 'macos';
// the version of macOS ('14.5'), '' elsewhere or when it is not known
export const OS_VERSION = await (async () => {
  try {
    if (!isMac) return '';
    const v = await globalThis.__TAURI__.core.invoke('os_version');
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
})();
// The build number of Windows (0 elsewhere or when it is not known): 22000 or more is Windows 11. Windows 11 has no working blur of the system, so the program blurs the picture of the game itself there
// (docs/HANDOFF.md 4-0aq), and only when the way of reading is "game window".
export const WIN_BUILD = await (async () => {
  try {
    if (OS !== 'windows') return 0;
    const b = Number(await globalThis.__TAURI__.core.invoke('os_build'));
    return Number.isFinite(b) && b > 0 ? b : 0;
  } catch { return 0; }               // (an older exe or no program: not Windows 11)
})();
export const isWin11 = OS === 'windows' && WIN_BUILD >= 22000;
// The voice recognition needs the sound capture of macOS 13 (ScreenCaptureKit with audio). An unknown version counts as fine (the capture then says so itself).
export const voiceSupported = !isMac || !OS_VERSION || parseInt(OS_VERSION, 10) >= 13;
