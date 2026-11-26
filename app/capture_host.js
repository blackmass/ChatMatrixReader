// The capture loop wired to the exe: screen grabs and the game window come from Rust commands, what the loop reads goes into the pipeline
// (hub.js publishes the events to the translation windows). Port of the Program parts of app.py: the queue poll, tick(), the hint
// "matrix not found", the game coming back to the front.
import { CaptureWorker } from './core/capture.js';
import { LostHint } from './core/upkeep.js';
import { log } from './core/log.js';
import { tr } from './core/i18n.js';
import { every } from './core/timings.js';
import { isMac } from './platform.js';

const invoke = window.__TAURI__.core.invoke;
// The wait between two looks. On macOS the timers of a page that is not in front are slowed down by the system (seconds instead of 33 ms), so the exe
// does the waiting there (the answer of a command is not a timer). Everywhere else (and when the exe cannot do it) a timer of the page.
let nativeSleep = null;
async function sleep(seconds) {
  if (nativeSleep === null) { try { nativeSleep = (await invoke('os_kind')) === 'macos'; } catch { nativeSleep = false; } }
  const ms = Math.max(0, Math.round(seconds * 1000));
  if (nativeSleep) { try { await invoke('sleep_ms', { ms }); return; } catch { nativeSleep = false; } }
  await new Promise(r => setTimeout(r, ms));
}
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
    grab, now: nowSec, sleep,
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
  // How the screen is read ("화면 읽기 방식", a test): 'window' = the window of the game only (the exe: capture_game), what stands over it is not in the picture. Whatever goes wrong, the screen is read as before for a
  // while and the reason is in the log; the time of both ways is told now and then.
  const way = { mode: 'screen', started: false, backoffUntil: 0, lastWhy: '', n: { window: 0, screen: 0, failed: 0 }, ms: { window: 0, screen: 0 }, at: nowSec() };
  io.grab = async (x, y, w, h) => {
    const want = settings.cfg().capture_mode === 'window' && game.hwnd;                // (a Mac: ScreenCaptureKit, macOS 14 or later; the exe says no on an older one and the screen is read then, see below)
    if (!want && (way.mode === 'window' || way.started)) { if (way.mode === 'window') log.info('캡처: 화면 읽기 방식: 화면'); way.mode = 'screen'; way.started = false; invoke('capture_game_stop').catch(() => {}); }          // (the option is off: the exe lets the window go)
    if (want && nowSec() >= way.backoffUntil) {
      const t0 = performance.now();
      way.started = true;
      try {
        const u8 = new Uint8Array(await invoke('capture_game', { hwnd: game.hwnd, x, y, w, h }));
        const head = new DataView(u8.buffer, u8.byteOffset, 8);
        if (way.mode !== 'window') { way.mode = 'window'; log.info('캡처: 화면 읽기 방식: 게임 창'); }
        way.n.window++; way.ms.window += performance.now() - t0;
        return { px: u8.subarray(8), width: head.getUint32(0, true), height: head.getUint32(4, true) };
      } catch (e) {
        const why = String(e && e.message || e);
        way.n.failed++; way.backoffUntil = nowSec() + 10;
        if (way.mode === 'window') way.mode = 'screen';
        if (why !== way.lastWhy) { way.lastWhy = why; log.warn('캡처: 게임 창 읽기가 안 돼서 화면으로 읽습니다 (10초 뒤 다시 시도): ' + why); }
      }
    }
    const t1 = performance.now();
    const r = await grab(x, y, w, h);
    way.n.screen++; way.ms.screen += performance.now() - t1;
    return r;
  };
  const wayReport = () => {                                     // every half minute that the test is on: how long each way took
    if (nowSec() - way.at < 30) return;
    if (settings.cfg().capture_mode === 'window' || way.n.window) log.info(`캡처: 게임 창 ${way.n.window}회 평균 ${(way.ms.window / Math.max(1, way.n.window)).toFixed(1)}ms, 화면 ${way.n.screen}회 평균 ${(way.ms.screen / Math.max(1, way.n.screen)).toFixed(1)}ms, 게임 창 실패 ${way.n.failed}회`);
    way.n = { window: 0, screen: 0, failed: 0 }; way.ms = { window: 0, screen: 0 }; way.at = nowSec();
  };
  const worker = new CaptureWorker(io, out, () => settings.cfg());
  // Off ("매트릭스 읽기", for who uses only the overlay): the screen is never read, nothing about the matrix is said. The game window is still looked for (the order of the windows, "quit with the game"). Read once: a change is for the next start.
  const reading = settings.cfg().read_matrix !== false;

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
      if (reading && !worker.paused && game.front && !wasFront && !connected) for (const ms of [400, 1500]) setTimeout(() => { if (!connected) { log.info('게임으로 돌아옴: 매트릭스를 읽고 있지 않아 다시 찾습니다'); worker.research(); } }, ms);
      wasFront = game.front;
      publish(pipeline.tick(nowSec()));
      wayReport();
      const act = reading && !worker.paused ? lost.check(cfg, game.found ? game : null, connected, nowSec()) : null;
      if (act && act[0] === 'show') {
        // act[1] = no position was ever found: the guide of the first start (the game may not even be running)
        const msg = '⚠ ' + (act[1]
          ? tr('매트릭스를 아직 찾지 못했습니다. ① 와우에 애드온(ChatMatrix)이 설치되어 있고 켜져 있는지 확인하세요. ② 설치했다면 와우 화면에 초록색 매트릭스 박스가 잘 보이는지 확인하세요. ③ 잘 보이는데도 감지가 안 되면, 애드온 설정에서 색 레벨 단계를 한 단계씩 낮추고(예: /cm levels 16) 이 창 위쪽의 ⟳ 아이콘을 누르면서 다시 시도해 보세요.')
          : tr('매트릭스를 찾지 못했습니다. 게임에서 애드온이 켜져 있고 매트릭스가 화면에 보이는지 확인하세요. '
            + '로딩 중이거나 애드온을 리로드한 경우라면 매트릭스가 다시 보일 때 바로 감지하니 그냥 두셔도 됩니다. '
            + '매트릭스 위치를 옮겼다면, 창 위쪽의 ⟳ 아이콘을 눌러 매트릭스를 다시 찾아 주세요.'));
        system(msg, 'lost');
      } else if (act && act[0] === 'hide') removeSystem('lost');
    } catch (e) { log.error('주기 점검 실패: ' + (e?.message || e)); }
  }
  const timer = every('GAME_LOOK_MS', look);
  look();
  if (reading) worker.run();                                    // (runs until stop())
  else log.info('매트릭스 읽기가 꺼져 있어 화면을 읽지 않습니다');

  return {
    worker, game,
    get reading() { return reading && !worker.paused; },
    research() { if (!reading) { system('ℹ ' + tr('매트릭스 읽기가 꺼져 있습니다. 옵션 > 일반에서 켜고 다시 시작하세요.')); return; } log.info('매트릭스 다시 찾기 요청'); awaiting = true; worker.research(); system('ℹ ' + tr('매트릭스를 다시 찾습니다...')); },
    stop() { worker.stop(); timer.stop(); invoke('capture_game_stop').catch(() => {}); },
    connected: () => connected,
    // a part of the game window, for the plugins (x, y from the top left of the window, in its own pixels): the same way the screen is read now (the window of the game or the screen, whatever the option says)
    clientSize: () => (game.found && game.rect ? { width: game.rect[2], height: game.rect[3] } : null),
    // the screen itself, with no game window needed (the manual capture works without the game): the rectangle of all the screens together [x, y, w, h] in pixels, and a part of it
    screenRect: async () => invoke('screen_rect'),
    grabScreen: (x, y, w, h) => grab(x, y, w, h),
    async grabClient(x, y, w, h) {
      if (!game.found || !game.rect) throw new Error('the game window is not there (or it is minimized)');
      const [gx, gy, gw, gh] = game.rect;
      if (x < 0 || y < 0 || x + w > gw || y + h > gh) throw new Error(`the part is not inside the game window (${gw}x${gh})`);
      return io.grab(gx + x, gy + y, w, h);
    },
  };
}
