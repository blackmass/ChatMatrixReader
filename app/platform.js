// Which system the program runs on: 'windows' | 'macos' | something else. Asked of the exe once (the command os_kind); a page that does not run in the
// program (the tests) gets 'windows'. The pages work the same everywhere; only the few things a system cannot do (the voice recognition on macOS for now)
// look at this.
export const OS = await (async () => {
  try {
    const t = globalThis.__TAURI__;
    if (!t || !t.core) return 'windows';
    const kind = await t.core.invoke('os_kind');
    return typeof kind === 'string' && kind ? kind : 'windows';
  } catch { return 'windows'; }       // (an older exe does not know the command: it is Windows)
})();
export const isMac = OS === 'macos';
