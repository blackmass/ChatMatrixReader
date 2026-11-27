// 일반: the game and the reading of the chat from the screen. (Rows are added when the thing they set exists: language, "quit with the
// game" and the update check come with their features.)
import { languages } from '../i18n_host.js';
import { isMac } from '../platform.js';
import { tr } from '../core/i18n.js';
import * as settings from '../settings.js';

const { emit } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;
const captureWhy = () => '';                     // (the capture of the game window is there on both systems now)

// The test of the capture of the game window: the game window and the screen are read the same way, and what differs is told (the exe: capture_compare). It reads the whole window of the game.
async function compareCapture() {
  const g = await invoke('find_game', { known: null, title: settings.cfg().wow_window_title || 'World of Warcraft' }).catch(() => null);
  if (!g || !g.rect) return tr('게임 창을 찾지 못했습니다 (게임이 켜져 있고 최소화되지 않았는지 확인하세요).');
  const [x, y, w, h] = g.rect;
  let r;
  try { r = await invoke('capture_compare', { hwnd: g.hwnd, x, y, w, h }); } catch (e) { return tr('시험하지 못했습니다: {e}', { e: String(e) }); }
  if (!r.ok) return tr('게임 창 읽기 실패: {e} (화면 읽기 {ms}ms)', { e: r.error, ms: r.screen_ms }) + (r.border ? ' · ' + tr('노란 테두리: {s}', { s: r.border }) : '');
  const pct = (100 * r.different / Math.max(1, r.total)).toFixed(2);
  return tr('{w}x{h}: 게임 창 {a}ms, 화면 {b}ms. 다른 픽셀 {n}개 ({pct}%, 가장 큰 차이 {max}, 평균 {mean}). 게임 창 그림이 {black}. 왼쪽 아래 그림은 logs 폴더의 capture_window.bmp, capture_screen.bmp입니다.',
    { w, h, a: r.window_ms, b: r.screen_ms, n: r.different, pct, max: r.max, mean: r.mean.toFixed(1), black: r.black ? tr('검습니다 (캡처가 안 되는 상태)') : tr('정상입니다') }) + ' · ' + tr('노란 테두리: {s}', { s: r.border || '-' });
}
// The test of the blur that Windows 11 gets from us (the exe: blur_probe, docs/HANDOFF.md 4-0aq): a corner of the game window is blurred on the graphics card and written to files, the time is told.
async function blurProbe() {
  const g = await invoke('find_game', { known: null, title: settings.cfg().wow_window_title || 'World of Warcraft' }).catch(() => null);
  if (!g || !g.hwnd) return tr('게임 창을 찾지 못했습니다 (게임이 켜져 있고 최소화되지 않았는지 확인하세요).');
  let r;
  try { r = await invoke('blur_probe', { hwnd: g.hwnd }); } catch (e) { return tr('시험하지 못했습니다: {e}', { e: String(e) }); }
  return tr('{w}x{h} 조각: 셰이더 준비 {c}ms. 한 번 흐리는 데 걸린 시간(그래픽카드가 끝날 때까지): 약함 {a}ms, 강함 {b}ms, 흐리지 않고 복사만 {n}ms. 그림은 logs 폴더의 blur_none.bmp, blur_weak.bmp, blur_strong.bmp입니다.',
    { w: r.rect[2], h: r.rect[3], c: r.compile_ms, a: r.weak_ms, b: r.strong_ms, n: r.none_ms });
}
const LANGS = await languages();                       // the locale files in the program folder (opened once with the window)

export default {
  id: 'general', title: '일반', subtitle: '게임과 화면 읽기',
  cards: [
    { title: '표시 언어', rows: [
      { key: 'language', type: 'select', label: '표시 언어', keywords: '언어 language locale 영어 english 한국어',
        options: [['', '시스템 언어를 따름'], ...LANGS.map(l => [l.code, l.name])],
        note: '프로그램의 글자(옵션, 안내 문구)가 바뀝니다. 번역하는 언어(목표 언어)와는 별개입니다. 다른 언어를 더하려면 프로그램 폴더의 locale 폴더에 언어 파일을 넣으세요 (locale/en-US.txt를 복사해서 번역).' },
    ] },
    { title: '화면', rows: [
      { key: 'center_scale', type: 'select', label: '화면 배율', keywords: '배율 dpi 크기 scale 확대 해상도',
        options: [[0, '자동 (주 모니터의 배율)'], [100, '100%'], [125, '125%'], [150, '150%'], [175, '175%'], [200, '200%']],
        note: '번역창 안의 글자와 버튼 크기입니다. 자동은 주 모니터의 배율을 따릅니다. 여러 모니터의 배율이 다르면 모든 모니터에서 같은 배율이 쓰입니다. 창의 위치와 크기(글 영역)는 화면 픽셀로 저장되어 배율을 바꿔도 같은 자리에 있습니다.' },
    ] },
    { title: '게임', rows: [
      { key: 'wow_window_title', type: 'text', label: '와우 창 제목', placeholder: 'World of Warcraft', wide: true, keywords: 'wow 게임 창 이름',
        note: '게임 창은 먼저 프로그램 이름(Wow*.exe)으로 찾고, 못 찾으면 이 제목과 같은 창을 찾습니다.' },
      { key: 'exit_with_game', type: 'check', label: '와우 종료 시 같이 종료', keywords: '게임 끝 자동 종료 quit exit',
        note: '와우 창이 한 번 보인 뒤 사라지면 5초 뒤에 프로그램을 끝냅니다. 프로그램을 와우보다 먼저 켜 둬도 끝나지 않습니다.' },
      { key: 'overlay_hide', type: 'select', label: '캡처·다른 프로그램 사용 시 오버레이 숨기기', keywords: '캡처 도구 스크린샷 창 캡처 win shift s print screen 스니핑 전체 화면 번역창 숨김 오버레이 센터 포커스 와우 앞 미니 브라우저 흐림',
        options: [['off', '끔'], ['capture', '캡처 감지 시 자동 숨김'], ['away', '게임 포커스를 잃으면 숨김']],
        unsupported: () => (isMac ? '윈도우에서만 쓰입니다' : ''),
        note: ['윈도우 11의 캡처 도구(Win+Shift+S, Print Screen 키)에서 "창 캡처"를 고르면 마우스를 올린 창을 자동으로 골라 줍니다. 그런데 번역창이 "항상 위"나 "게임 위에만"이면 화면 전체를 덮는 투명한 창 위에 그려지고, 캡처 도구는 그 투명한 창을 하나의 창으로 보기 때문에 어느 창 위에 마우스를 올려도 화면 전체가 골라집니다.',
          '"캡처 감지 시 자동 숨김"을 고르면 이 키를 누르는 순간부터 캡처 도구가 끝날 때까지 번역창이 화면에서 사라집니다. 그러면 캡처 도구가 원래 창들(게임, 탐색기 ...)을 제대로 골라 줍니다. 그동안 번역창이 보이지 않고, 캡처한 그림에도 번역창이 찍히지 않습니다. 캡처가 끝나면 바로 돌아옵니다.',
          '"끔"이면 번역창은 그대로 보이고 캡처에도 찍히지만, 창 캡처를 고르면 화면 전체가 잡힙니다 (사각형이나 자유 모양 캡처는 영향이 없습니다).',
          '"캡처 감지 시 자동 숨김"이면 Win+Shift+S와 Print Screen 키를 누를 때를 감지합니다. Print Screen을 눌렀는데 캡처 도구가 뜨지 않으면(게임의 스크린샷 키로 쓰는 경우 등) 번역창이 1초쯤 사라졌다 돌아옵니다. 번역창을 모두 일반 창(운영체제 창)으로 쓰는 경우에는 이 옵션과 상관없이 문제가 없습니다 (그릴 것이 없는 투명 창은 항상 숨겨 두기 때문입니다).',
          '"게임 포커스를 잃으면 숨김"은 와우가 켜져 있는 동안 와우(또는 이 프로그램의 창)가 맨 앞에 없으면 번역창, 배경 흐림, 미니 브라우저가 모두 숨습니다. 다른 프로그램을 쓰거나 캡처 도구를 쓸 때 번역창이 끼어들지 않습니다. 위 "캡처 감지"도 함께 동작해서, 와우가 앞에 있는 채로 Win+Shift+S를 누르는 경우도 덮습니다. 와우가 꺼져 있으면 숨기지 않습니다. 음성인식 결과를 다른 프로그램을 쓰면서 보는 경우에는 쓰지 마세요. 일반 창(운영체제 창)은 숨기지 않습니다.'] },
    ] },
    { title: '읽기', rows: [
      { key: 'read_matrix', type: 'check', label: '매트릭스 읽기', keywords: '매트릭스 캡처 화면 읽기 끄기 오버레이만 웹창 채팅',
        note: '끄면 화면에서 채팅 매트릭스를 읽지 않고, 그에 관한 알림도 나오지 않습니다. 번역은 쓰지 않고 웹창 같은 오버레이만 쓸 때 끄세요. 바꾼 뒤 프로그램을 다시 시작해야 적용됩니다.' },
      { key: 'capture_mode', type: 'select', label: '화면 읽기 방식', keywords: '캡처 게임 창 화면 작업 표시줄 가려짐 wgc 그래픽 캡처 ocr',
        unsupported: captureWhy,
        options: [['screen', '화면'], ['window', '게임 창']],
        hints: { screen: '화면에 보이는 모습을 그대로 읽습니다. 작업 표시줄이나 다른 창이 매트릭스를 덮으면 읽지 못합니다.',
          window: '게임 창 그림만 읽습니다. 위에 다른 창이나 작업 표시줄이 있어도, 번역창이 있어도 상관없습니다. 안 되면 자동으로 화면으로 읽고 기록에 이유를 남깁니다. 윈도우 10에서는 게임 창에 노란 테두리가 보입니다 (윈도우 11에서는 끕니다).' },
        note: '바로 적용됩니다. "게임 창"은 윈도우가 게임 창 하나를 따로 그려 주는 기능을 써서 읽는 것이라, 매트릭스를 작업 표시줄이나 다른 창이 덮어도 읽을 수 있습니다. 윈도우 10은 이 기능이 게임 창에 노란 테두리를 표시하며 끌 수 없습니다. 마음에 들지 않으면 "화면"으로 두세요. 맥에서는 macOS 14 이상에서 되고, 그보다 낮으면 자동으로 화면으로 읽습니다.' },
      { type: 'button', label: '게임 창 읽기 시험', button: '비교해 보기', unsupported: captureWhy, keywords: '캡처 시험 비교 게임 창 화면 픽셀 시간', unsupported: captureWhy,
        note: '게임 창 전체를 두 방식으로 한 번씩 읽어서 걸린 시간과 서로 다른 픽셀 수를 보여 줍니다. 번역창이나 작업 표시줄이 게임 위에 있으면 그 부분은 다르게 나오는 것이 정상입니다.', action: compareCapture },
      { type: 'button', label: '배경 블러 시험 (개발 중)', button: '흐려 보기', unsupported: () => (isMac ? '윈도우에서만 쓰입니다' : ''), keywords: '블러 흐림 배경 시험 윈도우 11 셰이더',
        note: '게임 창의 왼쪽 아래 640x360 조각을 그래픽카드로 흐려서 logs 폴더에 그림으로 저장하고 걸린 시간을 보여 줍니다. "게임 창" 읽기 방식에서, 게임이 보이는 상태에서 누르세요. 개발 중인 기능의 시험입니다.', action: blurProbe },
      { key: 'poll_hz', type: 'number', label: '초당 읽기 횟수', min: 5, max: 60, unit: '회', keywords: 'fps 속도 빈도 캡처' },
      { key: 'full_scan_sec', type: 'number', label: '전체 탐색 간격', min: 5, max: 600, unit: '초', keywords: '찾기 스캔',
        note: '매트릭스가 잡히지 않으면 1초마다 마지막으로 찾은 위치를 다시 확인하고, 거기에 없으면 이 간격마다 화면을 훑습니다. 너무 짧으면 게임에 부담이 됩니다.' },
      { type: 'info', label: '매트릭스 위치', keywords: '매트릭스 좌표', text: cfg => (cfg.last_pos ? `${cfg.last_pos[0]}, ${cfg.last_pos[1]}` : '아직 없음') },
      { type: 'button', label: '못 찾을 때', button: '매트릭스 다시 찾기', keywords: '재탐색 새로고침', action: () => emit('research', {}) },
    ] },
  ],
};
