// The test window. Every button checks one of the things that had to be proven before the real port.
const logEl = document.getElementById('log');
function log(msg, bad) {
  const div = document.createElement('div');
  if (bad) div.className = 'err';
  div.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
window.addEventListener('error', e => log('JS 오류: ' + e.message, true));
window.addEventListener('unhandledrejection', e => log('오류: ' + (e.reason && e.reason.message || e.reason), true));
window.cmrLog = log;                                          // hub.js writes into this list too
const ms = t => (performance.now() - t).toFixed(1) + 'ms';

// ---------------------------------------------------------------- 1. look: the controls are bound in hub.js (they change config.json)

// which window has the keyboard, and whether it counts as the game (the last one that was not this program)
setInterval(async () => {
  try {
    const s = await invoke('os_state', { keys: [0x0D] });
    if (isOurs(s)) return;
    document.getElementById('fg').textContent = `마지막 활성 창: "${s.fgTitle}" / ${s.fgExe || '(프로그램 이름 못 읽음)'} → 와우 인식: ${isGame(s) ? 'O' : 'X'}`;
  } catch (e) {}
}, 500);

// ---------------------------------------------------------------- 2. windows / fake chat: hub.js

// ---------------------------------------------------------------- 3. capture: the loop itself is capture_host.js (started by hub.js)

// Does the page keep running when its window is minimised or covered? (the answer decides who drives the capture loop)
document.getElementById('timer').onclick = () => {
  log('타이머 테스트 시작: 지금 이 창을 최소화하거나 와우로 전환했다가 10초 뒤 돌아오세요.');
  const t0 = performance.now();
  let last = t0, ticks = 0, worst = 0;
  const id = setInterval(async () => {
    const now = performance.now();
    worst = Math.max(worst, now - last); last = now; ticks++;
    await invoke('os_state');
    if (now - t0 >= 10000) {
      clearInterval(id);
      log(`타이머 50ms x 10초: 실행 ${ticks}회 (정상 약 200회), 가장 긴 공백 ${worst.toFixed(0)}ms`);
    }
  }, 50);
};

// ---------------------------------------------------------------- 4. translation
document.getElementById('tr').onclick = async () => {
  const t = performance.now();
  try { const r = await translateVia('LF2M tank and healer for +12', 'ko'); log('번역: ' + r.text + '  (' + ms(t) + ', 경로: ' + r.via + ')'); }
  catch (e) { log('번역 실패: ' + e, true); }
};

document.getElementById('openOptions').onclick = () => invoke('open_options').catch(e => log('옵션 창: ' + e, true));

document.getElementById('copy').onclick = async () => {
  await T.clipboardManager.writeText(logEl.innerText);
  log('결과를 클립보드에 복사했습니다.');
};

invoke('app_folder').then(p => {
  document.getElementById('folder').textContent = 'app 폴더: ' + p + '  (파일을 고치고 이 창에서 Ctrl+R 하면 바로 반영)';
  log('준비됨. WebView: ' + navigator.userAgent.replace(/^.*(Edg\/[\d.]+).*$/, '$1'));
}).catch(e => log('exe 호출 실패: ' + e, true));
