// 일반: the game and the reading of the chat from the screen. (Rows are added when the thing they set exists: language, "quit with the
// game" and the update check come with their features.)
import { languages } from '../i18n_host.js';

const { emit } = window.__TAURI__.event;
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
    ] },
    { title: '읽기', rows: [
      { key: 'poll_hz', type: 'number', label: '초당 읽기 횟수', min: 5, max: 60, unit: '회', keywords: 'fps 속도 빈도 캡처' },
      { key: 'full_scan_sec', type: 'number', label: '전체 탐색 간격', min: 5, max: 600, unit: '초', keywords: '찾기 스캔',
        note: '매트릭스가 잡히지 않으면 1초마다 마지막으로 찾은 위치를 다시 확인하고, 거기에 없으면 이 간격마다 화면을 훑습니다. 너무 짧으면 게임에 부담이 됩니다.' },
      { type: 'info', label: '매트릭스 위치', keywords: '매트릭스 좌표', text: cfg => (cfg.last_pos ? `${cfg.last_pos[0]}, ${cfg.last_pos[1]}` : '아직 없음') },
      { type: 'button', label: '못 찾을 때', button: '매트릭스 다시 찾기', keywords: '재탐색 새로고침', action: () => emit('research', {}) },
    ] },
  ],
};
