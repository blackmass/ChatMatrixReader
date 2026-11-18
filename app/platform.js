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
// The voice recognition needs the sound capture of macOS 13 (ScreenCaptureKit with audio). An unknown version counts as fine (the capture then says so itself).
export const voiceSupported = !isMac || !OS_VERSION || parseInt(OS_VERSION, 10) >= 13;
