// The timer values of the program (no imports from the program: every page may read them). They are SETTINGS: the options tab 고급 changes them
// (config key `tuning`: { NAME: value }), settings.js hands the saved values to applyTuning(), and every place reads T.NAME when it needs the value,
// so a change is seen at once. `every(name, fn)` is a timer that reads its own period each round and measures how long each round takes.
import { add as perfAdd } from './perf.js';

// [name, default, min, max, unit, group, label, where, what it does]
export const TUNE = [
  ['OVERLAY_POLL_MS', 100, 10, 1000, 'ms', '번역창', '창 상태 확인', 'pane.js', '마우스 위치, 조작 키 누름, 창 이동, 휠로 이전 대화 보기를 확인하는 주기 (작을수록 키에 바로 반응, 클수록 가벼움)'],
  ['REVIEW_LEAVE_MS', 1500, 200, 10000, 'ms', '번역창', '이전 대화 보기 끝내기까지', 'pane.js', '휠로 이전 대화를 보다가 맨 아래에서 마우스가 창을 벗어난 뒤, 다시 클릭 관통이 되기까지 기다리는 시간'],
  ['TIP_MAX_W', 250, 100, 1000, 'px', '번역창', '링크 툴팁 최대 폭', 'center.js · chatview.css', '채팅 글의 링크(아이템, 퀘스트 등) 툴팁의 가로 최대 크기 (와우는 250). 이보다 긴 줄은 줄바꿈됨. 위젯 툴팁은 위젯이 정함'],
  ['FADE_TICK_MS', 33, 8, 500, 'ms', '번역창', '글이 흐려질 때 다시 그리기', 'chatview.js', '글이 흐려지는 동안 화면을 다시 그리는 주기 (작을수록 부드러움, 33이면 초당 30번)'],
  ['FADE_IDLE_MS', 250, 50, 2000, 'ms', '번역창', '사라질 때가 됐는지 확인', 'chatview.js', '흐려지는 글이 없을 때 시간이 다 됐는지 확인하는 주기'],
  ['FADE_MS', 3000, 200, 10000, 'ms', '번역창', '완전히 사라지기까지', 'chatview.js', '사라질 때가 된 글이 완전히 사라지기까지 걸리는 시간'],
  ['GAME_LOOK_MS', 1000, 100, 10000, 'ms', '프로그램', '게임 창 확인', 'capture_host.js', '게임 창 위치·상태를 보고, 이어 붙이는 중인 긴 글을 정리하는 주기'],
  ['HUB_TICK_MS', 1000, 100, 10000, 'ms', '프로그램', '게임 종료 확인', 'hub.js', '와우가 없어졌는지 확인하고 창들에게 알리는 주기'],
  ['GRACE_SEC', 5, 1, 120, '초', '프로그램', '와우 종료 후 대기', 'exitwatch.js', '"와우가 종료되면 같이 종료"일 때, 와우가 사라진 뒤 종료까지 기다리는 시간'],
  ['CONFIG_SAVE_MS', 300, 50, 5000, 'ms', '프로그램', '설정 저장 대기', 'settings.js', '설정을 바꾼 뒤 config.json에 쓰기까지 기다리는 시간 (연달아 바꿔도 한 번만 씀)'],
  ['UPKEEP_TICK_MS', 2000, 200, 10000, 'ms', '프로그램', '서버·단어장 점검', 'upkeep_host.js', '번역 서버 연결, 단어장·프롬프트 변경을 살펴보는 주기'],
  ['VOICE_POLL_MS', 250, 50, 5000, 'ms', '음성인식', '소리 세션 확인', 'voice_target.js · capture.rs', '대상 프로그램이 어느 출력 장치에서 얼마나 크게 소리를 내는지 보는 주기'],
  ['VOICE_GATE_PERMILLE', 2, 0, 500, '‰', '음성인식', '소리 통과 기준', 'capture.rs', '"장치 전체" 방식에서 프로그램의 소리 크기(0~1000‰)가 이 값을 넘을 때만 소리를 엔진에 넘김 (2는 0.002). 0이면 항상 통과'],
  ['VOICE_GATE_HOLD_MS', 1000, 0, 10000, 'ms', '음성인식', '소리 통과 유지', 'capture.rs', '프로그램 소리가 기준 아래로 내려간 뒤에도 이만큼 더 통과시켜 문장 끝이 잘리지 않게 함'],
  ['VOICE_LOSE_SEC', 10, 1, 600, '초', '음성인식', '프로그램을 놓친 것으로 보기까지', 'capture.rs', '대상 프로그램의 소리 세션이 이만큼 보이지 않으면 듣던 장치를 놓음 (다시 소리를 내면 찾음)'],
  ['VOICE_NOAUDIO_SEC', 8, 0, 600, '초', '음성인식', '소리 없음 경고', 'capture.rs', '이만큼 소리가 하나도 없으면 "소리가 없습니다" 경고를 한 번 냄 (0이면 경고 안 함)'],
  ['SEND_TICK_MS', 25, 5, 500, 'ms', '프로그램', '보내기 상자 키 확인', 'send_host.js', '보내기 키·Enter 누름을 확인하는 주기'],
  ['EDGE_STICK_PX', 100, 10, 500, 'px', '프로그램', '모니터 가장자리 저항', 'frame.js', '창을 끌어서 모니터 가장자리(옆에 다른 모니터가 있는 쪽)에 닿으면 걸려서 멈추고, 이 거리(px)보다 더 끌면 옆 모니터로 넘어갑니다. 옆 모니터가 없는 쪽은 넘어가지 않습니다'],
];

export const T = {};
for (const [name, def] of TUNE) T[name] = def;
export const DEFAULT_TUNING = Object.fromEntries(TUNE.map(([name, def]) => [name, def]));

// the saved values -> T (a value that is missing, not a number or outside its range is the default)
export function applyTuning(saved) {
  for (const [name, def, min, max] of TUNE) {
    const v = saved && typeof saved === 'object' ? saved[name] : undefined;
    T[name] = typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : def;
  }
}


// A timer that asks T[name] for its next wait every round (a change of the setting is seen at once). Each run is measured (core/perf.js).
// fn may be async: the next round is waited for after it is done. Returns { stop() }.
export function every(name, fn) {
  let stopped = false, handle = 0;
  const round = async () => {
    if (stopped) return;
    const t0 = performance.now();
    try { await fn(); } catch { /* the caller handles its own errors; the timer keeps going */ }
    perfAdd(name, performance.now() - t0);
    if (!stopped) handle = setTimeout(round, T[name]);
  };
  handle = setTimeout(round, T[name]);
  return { stop() { stopped = true; clearTimeout(handle); } };
}
