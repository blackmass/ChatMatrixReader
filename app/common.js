// Shared by every page. `window.__TAURI__` is put there by the exe; if it is missing, nothing else can work.
if (!window.__TAURI__) {
  document.body.insertAdjacentHTML('afterbegin',
    '<div style="background:#a00;color:#fff;padding:8px;font:14px sans-serif">window.__TAURI__ 가 없습니다 (exe가 이 페이지에 기능을 열어주지 않음)</div>');
}
const T = window.__TAURI__;
const invoke = T.core.invoke;
const { listen, emit } = T.event;
const thisWin = T.window.getCurrentWindow();

// Is the active window the game? The Python reader's rule: a program named wow*.exe, or else a window with exactly this title.
const GAME_TITLE = 'world of warcraft';
function isGame(s) {
  const exe = s.fgExe || '';
  return (exe.startsWith('wow') && exe.endsWith('.exe')) || s.fgTitle.trim().toLowerCase() === GAME_TITLE;
}
const isOurs = s => s.fgExe ? s.fgExe.startsWith('chatmatrix') : (s.fgTitle.startsWith('CMR') || s.fgTitle.startsWith('ChatMatrix'));

// Translation is asked of the hub (hub.js in the control window): it owns the one translation queue, so Google's spacing and pauses
// exist once for the whole program. -> the translated text (rejects with the error)
const rpcWait = new Map();
let rpcId = 0;
listen('rpc-result', ev => {
  const w = rpcWait.get(ev.payload.id);
  if (!w) return;
  rpcWait.delete(ev.payload.id);
  if (ev.payload.error) w.reject(new Error(ev.payload.error)); else w.resolve(ev.payload.text);
});
function translate(text, to = 'ko') {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    rpcWait.set(id, { resolve, reject });
    emit('rpc-translate', { id, text, to });
    setTimeout(() => { if (rpcWait.delete(id)) reject(new Error('번역 응답 없음 (허브 창이 열려 있어야 합니다)')); }, 45000);
  });
}
const translateVia = async (text, to) => ({ text: await translate(text, to), via: 'hub' });
