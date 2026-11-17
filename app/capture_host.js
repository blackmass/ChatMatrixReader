// The capture loop wired to the exe: screen grabs and the game window come from Rust commands, what the loop reads goes into the pipeline
// (hub.js publishes the events to the translation windows). Port of the Program parts of app.py: the queue poll, tick(), the hint
// "matrix not found", the game coming back to the front.
import { CaptureWorker } from './core/capture.js';
import { LostHint } from './core/upkeep.js';
import { log } from './core/log.js';
import { tr } from './core/i18n.js';
import { every } from './core/timings.js';

const invoke = window.__TAURI__.core.invoke;
const nowSec = () => performance.now() / 1000;
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

// a screenshot from the exe: 8 bytes (width, height as u32) + BGRA
async function grab(x, y, w, h) {
  const u8 = new Uint8Array(await invoke('capture', { x, y, w, h }));
  const head = new DataView(u8.buffer, u8.byteOffset, 8);
  return { px: u8.subarray(8), width: head.getUint32(0, true), height: head.getUint32(4, true) };
}

// settings: the ConfigStore functions (cfg(), set(patch)); publish(events); pipeline; extras for nothing else
export function startCapture({ settings, publish, pipeline }) {
  const system = (text, tag = '') => publish([{ type: 'Notice', kind: 'system', text, stamp: stamp(), replace: false, tag }]);
  const removeSystem = tag => publish([{ type: 'Notice', kind: 'remove', text: '', stamp: '', replace: false, tag }]);

  // ---- the game window (looked at every second or two; the handle is remembered so a search happens only when it is gone)
  const game = { hwnd: 0, rect: null, front: false, found: false };
  let wasFront = false, awaiting = false, connected = false, screen = [0, 0, 1920, 1080];
  const lost = new LostHint();

  const io = {
    grab, now: nowSec, sleep: s => new Promise(r => setTimeout(r, Math.max(0, s) * 1000)),
    screen: () => screen,
    gameRect: () => game.rect,
  };
  const out = {
    lines: lines => publish(pipeline.onLines(lines, nowSec())),
    pos: p => settings.set({ last_pos: p }),
    status: s => {
      if (s.kind === 'connected' && s.found) {
        removeSystem('lost');                                   // the hint "matrix not found" has done its job
        if (awaiting) { awaiting = false; system('✔ ' + tr('매트릭스를 찾았습니다.') + ' ' + s.text.replace(tr('연결됨'), '').trim()); }
        if (!connected) { connected = true; log.info('캡처: ' + s.text); }
      } else if (s.kind === 'connected' || s.kind === 'waiting') {
        connected = true;
      } else if (s.kind === 'lost') {
        if (connected) log.warn('캡처: ' + s.text);
        connected = false;
      } else if (s.kind === 'error') {
        log.warn('캡처: ' + s.text); connected = false;
      }
    },
  };
  const worker = new CaptureWorker(io, out, () => settings.cfg());

  async function look() {                                       // every second: the game window, the lines waiting in the joiner, the hint
    try {
      const cfg = settings.cfg();
      screen = await invoke('screen_rect');
      const g = await invoke('find_game', { known: game.hwnd || null, title: cfg.wow_window_title || 'World of Warcraft' });
      if (g) {
        if (!game.found) log.info(`게임 창 찾음: hwnd=${g.hwnd} 제목=${JSON.stringify(g.title)} 프로그램=${g.exe || '?'}`);
        game.hwnd = g.hwnd; game.rect = g.rect; game.front = !!g.front; game.found = true;
      } else {
        if (game.found) log.info('게임 창이 사라졌습니다');
        game.hwnd = 0; game.rect = null; game.front = false; game.found = false;
      }
      // the game came back to the front while the matrix is not being read (covered, or the game was away): search again by itself;
      // the game redraws a moment later, so look twice
      if (game.front && !wasFront && !connected) for (const ms of [400, 1500]) setTimeout(() => { if (!connected) { log.info('게임으로 돌아옴: 매트릭스를 읽고 있지 않아 다시 찾습니다'); worker.research(); } }, ms);
      wasFront = game.front;
      publish(pipeline.tick(nowSec()));
      const act = lost.check(cfg, game.found ? game : null, connected, nowSec());
      if (act && act[0] === 'show') {
        let msg = '⚠ ' + tr('매트릭스를 찾지 못했습니다. 게임에서 애드온이 켜져 있고 매트릭스가 화면에 보이는지 확인하세요. '
          + '로딩 중이거나 애드온을 리로드한 경우라면 매트릭스가 다시 보일 때 바로 감지하니 그냥 두셔도 됩니다. '
          + '처음 실행했거나 매트릭스 위치를 옮겼다면, 창 위쪽의 ⟳ 아이콘을 눌러 매트릭스를 다시 찾아 주세요.');
        if (act[1]) msg += ' ' + tr('왼쪽 아래가 아니어도 한 번 찾으면 위치를 기억합니다.');
        system(msg, 'lost');
      } else if (act && act[0] === 'hide') removeSystem('lost');
    } catch (e) { log.error('주기 점검 실패: ' + (e?.message || e)); }
  }
  const timer = every('GAME_LOOK_MS', look);
  look();
  worker.run();                                                 // (runs until stop())

  return {
    worker, game,
    research() { log.info('매트릭스 다시 찾기 요청'); awaiting = true; worker.research(); system('ℹ ' + tr('매트릭스를 다시 찾습니다...')); },
    stop() { worker.stop(); timer.stop(); },
    connected: () => connected,
  };
}
