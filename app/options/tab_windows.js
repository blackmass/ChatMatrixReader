// 창: the translation windows. A toolbar picks the window (1 = the main window, the others from config.child_windows), the cards below
// show THAT window's settings. Rows with `win: true` are per window: options.js reads/writes them in the right place (see scope there).
// The key of a row is the name an extra window uses; the main window's differs for a few (options.js: MAIN_KEY).
import { nameFor } from '../winname.js';
import { ALL } from '../winmanager.js';
import { VOICE_ID, dockHost, dockedOf, without } from '../core/winconf.js';
import { goneOwner, onGoneChange, goneNote } from './orphans.js';
import { entries as fontItems } from '../fonts.js';
import { registry as widgetRegistry } from '../widgets/defaults.js';
import { widgetsRow } from './widget_row.js';

const { emit, listen } = window.__TAURI__.event;

import { chName, chColor } from './channels.js';
import { tr } from '../core/i18n.js';
const FADE_START = 60;                    // an empty "hide old lines" box: the first arrow press gives 60 s (up or down), then one step at a time
// the size of the upper line of a window (its own, or window 1's when it follows): where an empty "lower line size" starts from
const upperSize = x => { const r = { win: true, key: 'font_size' }; const n = Number(x.get(r) ?? x.mainValue(r)); return Number.isFinite(n) && n > 0 ? n : 11; };
const isMain = ctx => ctx.sel === 1;
const child = ctx => ctx.sel !== 1;

const tab = {
  id: 'windows', title: '창', subtitle: '번역창 목록과 모양',
  cards: [
    { title: '이 창', rows: [
      { win: true, key: 'dock_to', type: 'select', label: '탭으로 합칠 창', keywords: '붙이기 합치기 탭 종속 다른 창 도킹 dock merge tab', show: (c, x) => child(x),
        options: x => {
          const l = x.cfg().child_windows;
          if (dockedOf(l, x.sel).length) return [[0, '합치지 않음']];                      // (a window that has tabs cannot be a tab)
          return [[0, '합치지 않음'], [1, nameFor(x.cfg(), 1)], ...l.filter(c => c.id !== x.sel && c.id !== 1 && c.kind !== 'web' && !(Number(c.dock_to) > 0)).map(c => [c.id, nameFor(x.cfg(), c.id)])];
        },
        note: ['고른 창 안의 탭이 됩니다. 이 창은 따로 열리지 않고, 그 창의 위쪽 탭을 눌러 오갑니다. 글은 탭마다 따로 쌓입니다.',
          '창의 위치, 배경, 클릭 관통 같은 창 자체의 설정은 그 창을 따르고, 글꼴과 채널 같은 글 설정은 이 창의 것을 씁니다 (따르는 옵션은 흐리게 보입니다).'] },
      { type: 'info', label: '탭이 붙은 창', show: (c, x) => child(x) && dockedOf(x.cfg().child_windows, x.sel).length > 0,
        text: () => '이 창에는 다른 창이 탭으로 붙어 있어서, 다른 창의 탭이 될 수 없습니다.' },
      { win: true, key: 'tab_alert', type: 'check', label: '새 글 알림 (탭)', keywords: '알림 새 글 표시 귓말 탭 점',
        show: (c, x) => dockHost(x.cfg().child_windows, x.sel) > 0 || dockedOf(x.cfg().child_windows, x.sel).length > 0,
        note: ['다른 탭을 보는 동안 이 탭에 새 글이 오면 탭 이름 앞에 주황색 점을 띄웁니다. 그 탭을 누르면 사라집니다.',
          '귓속말처럼 놓치기 싫은 글을 따로 탭에 모아 둘 때 쓰세요. 클릭 관통 중에도 탭 줄만 보입니다.'] },
      { win: true, key: 'hide_tools', type: 'check', label: '평소에 기능 버튼 숨기기', keywords: '아이콘 버튼 숨김 가리기 인터페이스 설정 닫기',
        note: '창 위쪽 오른쪽의 기능 버튼들(번역·음성·설정·닫기)을 마우스가 창 밖에 있을 때 숨깁니다. 마우스를 창 안으로 가져가면 나타납니다.' },
      { win: true, key: 'hide_tabs', type: 'check', label: '평소에 이름 탭 숨기기', keywords: '탭 이름 숨김 가리기 인터페이스',
        note: '창 위쪽 왼쪽의 이름 탭을 마우스가 창 밖에 있을 때 숨깁니다. 마우스를 창 안으로 가져가면 나타납니다.' },
      { win: true, key: 'hide_frame', type: 'check', label: '평소에 프레임 숨기기', keywords: '테두리 스크롤 크기 조절 숨김 가리기 인터페이스',
        note: ['바깥 사각 프레임, 스크롤 막대, 오른쪽 아래의 크기 조절 손잡이를 마우스가 창 밖에 있을 때 숨깁니다.',
          '마우스를 창 안으로 가져가면 나타납니다.'] },
      { win: true, key: 'name', type: 'text', label: '이름', placeholder: '창 이름', keywords: '창 이름 탭 제목 메인',
        note: '창 위쪽의 탭에 이 이름이 보입니다. 비워 두면 기본 이름(메인, 음성인식, 창 번호)을 씁니다.' },
      { win: true, key: 'open_mode', type: 'select', label: '열리는 때', keywords: '열기 닫기 항상', show: (c, x) => child(x),
        options: x => [['always', '프로그램을 켤 때 항상'], ['voice', '음성 인식을 켤 때만'], ['never', '닫아 둠 (직접 열 때만)']],
        hints: { always: '창의 X로 닫거나 직접 연 것은 그때만 적용되고 이 설정은 바뀌지 않습니다. 프로그램을 다시 켜면 열립니다.', voice: '음성인식을 켜면 열리고 끄면 닫힙니다. 직접 열거나 X로 닫은 것은 그때만 적용되고, 다음에 음성인식을 켜고 끌 때 다시 이 설정을 따릅니다.' } },
      { win: true, key: 'clear_on_open', type: 'check', label: '열 때 비우기', keywords: '지우기 이전 대화 메시지 정리 열릴 때 음성', show: (c, x) => child(x),
        note: ['창이 열릴 때 이전 대화를 가져오지 않고 빈 창으로 시작합니다. 프로그램이 자동으로 열 때도, 직접 열 때도 같습니다.',
          '예: 음성인식을 껐다 켤 때 지난 음성 글이 남아 있지 않게 하려면 켜세요.',
          '열린 뒤에 오는 글은 평소처럼 나옵니다. 창이 열려 있는 동안에는 지우지 않습니다.'] },
      { type: 'info', label: '메인 창', keywords: '창 1', show: (c, x) => isMain(x), text: () => '이 창을 닫으면 프로그램이 끝납니다.' },
    ] },
    { title: '보여 줄 채널', rows: [
      { win: true, key: 'channels', type: 'channels', label: '이 창에 나오는 채널', keywords: '채널 필터 귓속말 파티 길드', codes: ALL, names: chName, color: chColor,
        note: '체크한 채널의 글만 이 창에 나옵니다. 메인 창에서 뺀 채널을 다른 창에 따로 모아 볼 수 있습니다.' },
    ] },
    { title: '글', rows: [
      { win: true, key: 'font_family', type: 'suggest', items: () => fontItems(), blank: x => (x.sel === 1 ? '기본 (맑은 고딕)' : '창 1을 따름'), label: '글꼴', placeholder: '글꼴 이름', keywords: '폰트 font',
        note: '프로그램 폴더의 fonts 폴더에 글꼴 파일(.ttf .otf .woff2)을 넣고 옵션 창을 다시 열면 목록에 나옵니다 (글꼴 이름과 파일 이름). 설치된 글꼴도 목록에 있습니다. 칸을 누르면 목록이 열리고, 목록에 없는 이름은 그대로 적어도 됩니다.' },
      { win: true, key: 'font_weight', type: 'select', label: '글자 굵기', keywords: '폰트 굵게 두껍게 얇게 bold weight',
        options: [[100, '100 Thin (가장 얇은)'], [200, '200 Extra Light (매우 얇은)'], [300, '300 Light (얇은)'], [400, '400 Normal (기본)'], [500, '500 Medium (약간 두꺼운)'],
          [600, '600 Semi Bold (중간 두꺼움)'], [700, '700 Bold (표준 두꺼움)'], [800, '800 Extra Bold (매우 두꺼움)'], [900, '900 Black (가장 두꺼운)']],
        note: '글꼴이 그 굵기를 가지고 있어야 달라 보입니다. 굵기가 하나뿐인 글꼴은 600 이상일 때 굵게 흉내 낸 글씨로 나오고, 그보다 가는 굵기는 구분되지 않을 수 있습니다.' },
      { win: true, key: 'font_size', type: 'number', label: '글자 크기', min: 6, max: 48, unit: 'pt', keywords: '폰트 크기', note: '추가 창에서 비워 두면 창 1을 따릅니다.' },
      { win: true, key: 'trans_font_size', type: 'number', label: '아래 줄 글자 크기 (기본은 번역)', min: 0, max: 32, unit: 'pt', zeroEmpty: true,
        zeroText: (x, child) => (child ? tr('윗줄과 같음 · {n}pt', { n: upperSize(x) }) : tr('윗줄 크기를 따름 · {n}pt', { n: upperSize(x) })),
        startAt: (x, dir) => (Number(x.mainValue({ win: true, key: 'trans_font_size' })) > 0 ? undefined : upperSize(x) + dir),
        note: '비워 두면 윗줄과 같은 크기입니다 (추가 창에서는 창 1을 따릅니다). 위아래 순서를 바꿔도 항상 아래 줄에 적용됩니다.' },
      { win: true, key: 'trans_color', type: 'color', label: '아래 줄 글자 색 (기본은 번역)', keywords: '색상 컬러 번역 글자 색', note: '위아래 순서를 바꿔도 항상 아래 줄에 적용됩니다. 기본 순서에서는 아래 줄이 번역입니다.' },
      { win: true, key: 'align', type: 'select', label: '글 정렬', options: [['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽']], keywords: '정렬 가운데' },
      { win: true, key: 'head_mode', type: 'select', label: '줄 머리말', keywords: '채널 이름 머리글',
        options: x => [...(isMain(x) ? [['', '(채널 상세 설정 따름)']] : []), ['detail', '자세히'], ['basic', '기본'], ['nochan', '채널 표시 없이'], ['body', '내용만']] },
      { win: true, key: 'show_time', type: 'check', label: '시간 표시', keywords: '시각' },
      { win: true, key: 'class_colors', type: 'check', label: '직업 색 이름', keywords: '직업 색상 클래스' },
      { win: true, key: 'swap_trans', type: 'check', label: '번역 위, 원문 아래', keywords: '순서 바꾸기' },
    ] },
    { title: '글자 모양', rows: [
      { win: true, key: 'outline', type: 'number', label: '글자 외곽선', min: 0, max: 30, unit: '× 0.1px', keywords: '테두리 외곽선 outline stroke', note: '글자 둘레에 두르는 윤곽선의 굵기입니다. 10이면 1px, 0이면 끕니다.' },
      { win: true, key: 'outline_color', type: 'color', label: '외곽선 색', show: (c, x) => Number(x.get({ win: true, key: 'outline' }, c)) > 0 },
      { win: true, key: 'bold_fix', type: 'number', label: '굵기 보정', min: -10, max: 10, unit: ['× 0.1px', '(음수는 × 0.03px)'], keywords: '굵게 얇게 두껍게 깎기 bold thin', note: [
          '양수: 글자 둘레를 이만큼 키워 글자를 굵게 합니다 (10이면 1px).',
          '음수: 외곽선 색(기본 검정)의 아주 가는 선을 글자 가장자리에 덧그려 얇아 보이게 합니다 (-5이면 0.15px). 어두운 배경에서 Windows가 글자를 와우보다 굵게 그릴 때 쓰세요.',
          '글자를 깎는 게 아니라 가장자리를 덮는 것이라서 외곽선 색이 보입니다.',
          '0이면 끕니다. 글자 굵기 옵션과는 별개입니다.'] },
      { win: true, key: 'letter_spacing', type: 'number', label: '글자 사이 간격', min: -10, max: 20, unit: '× 0.1px', keywords: '자간 letter spacing', note: '글자와 글자 사이에 더하는 간격입니다. 10이면 1px, 음수는 좁게, 0이면 그대로입니다.' },
      { win: true, key: 'plain_text', type: 'check', label: '글자 맞춤 단순화', keywords: '커닝 kerning 합자', note: '글자 쌍 보정(커닝)과 합자를 끕니다.' },
    ] },
    { title: '그림자', rows: [
      { win: true, key: 'shadow', type: 'check', label: '글자 그림자', keywords: '그림자 shadow' },
      { win: true, key: 'shadow_dx', type: 'number', label: '그림자 가로 이동', min: -8, max: 8, unit: 'px', show: (c, x) => !!x.get({ win: true, key: 'shadow' }, c) },
      { win: true, key: 'shadow_dy', type: 'number', label: '그림자 세로 이동', min: -8, max: 8, unit: 'px', show: (c, x) => !!x.get({ win: true, key: 'shadow' }, c) },
      { win: true, key: 'shadow_color', type: 'color', label: '그림자 색', show: (c, x) => !!x.get({ win: true, key: 'shadow' }, c) },
    ] },
    { title: '줄', rows: [
      { win: true, key: 'line_spacing', type: 'number', label: '줄 간격', min: -20, max: 40, unit: 'px', keywords: '행간 원문 번역 사이', note: '한 묶음 안에서 윗줄과 아랫줄(원문과 번역) 사이의 간격입니다. 글 하나가 길어서 여러 줄로 나뉠 때 그 줄들 사이는 \'줄 높이\'입니다.' },
      { win: true, key: 'line_height', type: 'number', label: '줄 높이', min: -10, max: 40, unit: 'px', keywords: '행간 긴 글 줄바꿈 여러 줄', note: '글 하나가 길어서 여러 줄로 나뉠 때, 그 줄들 사이의 간격입니다. 원문과 번역 사이는 \'줄 간격\', 묶음 사이는 \'묶음 사이 간격\'입니다.' },
      { win: true, key: 'group_spacing', type: 'number', label: '묶음 사이 간격', min: -20, max: 60, unit: 'px', note: '채팅 한 줄(원문과 번역 한 쌍)과 다음 줄 사이의 간격입니다.' },
      { win: true, key: 'indent', type: 'number', label: '들여쓰기', min: 0, max: 16, unit: '칸', note: '왼쪽 정렬에서 긴 줄의 둘째 줄과 번역 줄을 밀어 넣는 칸 수.' },
      { win: true, key: 'max_lines', type: 'number', label: '보관할 줄 수', min: 50, max: 5000, unit: '줄', keywords: '최대 줄' },
      { win: true, key: 'bottom', type: 'check', label: '아래쪽에 붙이기', keywords: '바닥 하단', note: '글이 적을 때 창 아래쪽에 쌓이고, 새 글이 오면 위로 밀립니다.' },
      { win: true, key: 'whole_groups', type: 'check', label: '온전한 묶음만', keywords: '잘린 묶음 맨 위 반쯤 가리기 음성 whole',
        note: ['창 맨 위에 반쯤 걸쳐 잘려 보이는 묶음(원문과 번역 한 쌍)을 통째로 숨기고, 온전히 보이는 묶음만 보여 줍니다.',
          '위로 스크롤해서 이전 대화를 읽는 동안에는 전부 보입니다.',
          '글을 아래쪽에 붙인 창과 같이 쓰면 가장 깔끔합니다 (음성 창 추천).'] },
      { win: true, key: 'max_groups', type: 'number', label: '보일 묶음 수', min: 0, max: 50, unit: '개', zeroEmpty: true, keywords: '최근 몇 개만 최대 묶음 개수',
        zeroText: () => tr('제한 없음'),
        startAt: (x, dir) => (Number(x.mainValue({ win: true, key: 'max_groups' })) > 0 ? undefined : 3),
        note: ['가장 최근 묶음 몇 개만 보여 줍니다. 비워 두면 제한이 없습니다 (추가 창에서는 창 1을 따릅니다).',
          '위로 스크롤해서 이전 대화를 읽는 동안에는 전부 보입니다.',
          "'온전한 묶음만'과 같이 쓰면 둘 중 더 적게 보이는 쪽을 따릅니다."] },
      { win: true, key: 'fade_sec', type: 'number', label: '오래된 글 숨기기', min: 0, max: 86400, unit: '초', keywords: '사라짐 페이드', zeroEmpty: true,
        zeroText: () => tr('숨기지 않음'),
        startAt: (x, dir) => (Number(x.mainValue({ win: true, key: 'fade_sec' })) > 0 ? undefined : FADE_START),
        note: [
          '비워 두면 숨기지 않습니다 (추가 창에서는 창 1을 따릅니다).',
          '숫자를 넣으면 그 시간이 지난 글이 사라지고, 위로 스크롤하면 다시 보입니다.'] },
    ] },
    { title: '위젯', note: '창에 붙이는 작은 부품입니다. 창마다 따로 켜고 배치합니다 (창 1을 따르지 않습니다). 켜 두면 부품 위에 마우스를 올렸을 때 자세한 상태가 보입니다.',
      rows: [widgetsRow(widgetRegistry)] },
    { title: '위치', rows: [
      { win: true, key: 'lock_window', type: 'check', label: '창 고정', keywords: '이동 크기 조절 잠금 드래그 고정 lock',
        note: '마우스로 창을 옮기거나 크기를 바꿀 수 없게 합니다. 탭을 누르다가 창이 밀리는 일을 막습니다.' },
      { win: true, key: 'topmost', type: 'check', label: '항상 맨 위에', keywords: '최상위 topmost 위에 표시',
        apply: (ctx, v) => { ctx.put({ win: true, key: 'topmost' }, v); if (v) ctx.put({ win: true, key: 'topmost_wow_only' }, false); } },
      { win: true, key: 'topmost_wow_only', type: 'check', label: '와우 위에만', keywords: '게임 위 topmost 다른 창 뒤',
        note: '와우 바로 위에만 놓이고, 다른 프로그램 창이 와우를 덮으면 이 창도 같이 가려집니다. 켜면 "항상 맨 위에"는 꺼집니다.',
        apply: (ctx, v) => { ctx.put({ win: true, key: 'topmost_wow_only' }, v); if (v) ctx.put({ win: true, key: 'topmost' }, false); } },
    ] },
    { title: '배경과 조작', rows: [
      { win: true, key: 'blur', type: 'select', label: '배경 흐림', options: [[0, '끔'], [1, '약하게'], [2, '강하게']], keywords: '블러 아크릴',
        note: '윈도우의 문제로, 흐림을 켠 창이 여러 개 있으면 컴퓨터 전체가 느려질 수 있습니다. 한두 개 창에서만 쓰는 것을 권합니다.' },
      { win: true, key: 'bg_opacity', type: 'percent', min: 0.03, label: '배경 진하기', keywords: '투명도 불투명' },
      { win: true, key: 'tab_opacity', type: 'percent', min: 0.05, label: '탭 배경 진하기', keywords: '투명도 불투명 탭 상단 바 아이콘 버튼',
        note: '창 위쪽의 이름 탭과 기능 버튼 상자의 배경과 테두리가 얼마나 진한지 정합니다. 100%면 또렷하게 보이고, 낮추면 흐려져 게임 화면 위에서 덜 거슬립니다. 글자는 그대로입니다.' },
      { win: true, key: 'text_opacity', type: 'percent', min: 0.2, label: '글 진하기', keywords: '투명도 불투명' },
      { win: true, key: 'click_through', type: 'check', label: '클릭 관통', keywords: '마우스 관통 클릭 통과 click through',
        note: '창이 클릭을 받지 않고 뒤의 게임으로 보냅니다. 아래 조작 키를 누르고 있으면 이 창을 조작할 수 있습니다. 옵션은 Ctrl+Alt+O 또는 트레이 아이콘으로 엽니다. 와우가 없을 때는 관통되지 않고 그대로 보입니다.' },
      { key: 'auto_copy', type: 'check', label: '자동 복사', keywords: '복사 선택 글 마우스 나갈 때 copy',
        note: '창에서 글을 선택한 뒤 마우스가 창을 벗어나면 선택한 글이 자동으로 복사됩니다. 글이 선택되어 있을 때만 복사합니다.' },
      { key: 'wheel_through', type: 'check', label: '관통 중 휠 스크롤 허용', keywords: '휠 스크롤 이전 대화 관통 wheel',
        show: (c, x) => !!x.get({ win: true, key: 'click_through' }, c), note: [
          '꺼져 있으면 클릭 관통 중에는 (링크 설명 보기를 빼면) 아무 조작도 되지 않습니다.',
          '켜면 마우스를 창 위에 두고 휠을 위로 올려 이전 대화를 볼 수 있습니다 (맨 아래까지 내리면 다시 관통).',
          '글자가 자동으로 사라지는 중이거나 사라진 상태에서는 휠을 아래로 내려도 다시 나타납니다 (이때만 아래 휠도 게임이 아닌 이 창이 받습니다).',
          "'관통 창 숨기기'가 켜진 창에서는 이 설정이 적용되지 않습니다 (뒤의 게임 채팅을 쓰는 중이라 휠은 게임 것입니다)."] },
      { key: 'through_tips', type: 'check', label: '관통 중 링크 보기 허용', keywords: '툴팁 링크 아이템 퀘스트 마우스 올리기 관통 tooltip item quest hover',
        show: (c, x) => !!x.get({ win: true, key: 'click_through' }, c), note: [
          '클릭 관통 중에도 채팅의 링크(아이템, 퀘스트 등)에 마우스를 올리면 설명이 뜹니다. 마우스는 게임으로 그대로 전달되고, 설명만 창에 그려집니다.',
          '끄면 클릭 관통 중에는 설명이 뜨지 않습니다 (조작 가능한 상태에서는 늘 뜹니다).',
          "'관통 창 숨기기'가 켜진 창에서는 마우스를 올리면 창이 투명해지므로 설명도 뜨지 않습니다."] },
      { win: true, key: 'hover_clear', type: 'check', label: '관통 창 숨기기', keywords: '마우스 올리면 투명 호버 지우기 가리기 hover',
        show: (c, x) => !!x.get({ win: true, key: 'click_through' }, c), note: [
          '클릭 관통일 때 마우스를 창 위로 가져가면 창이 완전히 투명해져 뒤의 게임이 보입니다. 아래 조작 키를 누르고 있으면 투명해지지 않습니다.',
          "이 옵션이 켜진 창에서는 '관통 중 휠 스크롤 허용'과 '관통 중 링크 보기 허용'이 적용되지 않습니다 (뒤의 게임 채팅창을 그대로 쓰는 용도).",
          '조작 키를 눌러 조작 가능한 상태가 되면 평소와 같습니다.'] },
      { win: true, key: 'interact_keys', type: 'keys', label: '조작 키', show: (c, x) => isMain(x), keywords: '시프트 컨트롤', note: '체크한 키를 모두 누르고 있을 때 창을 조작할 수 있습니다.' },
    ] },
  ],

  // the window picker above the cards. env = { cfg(), sel(), select(id) }
  toolbar(env) {
    onGoneChange(() => { if (el.isConnected) refresh(); });
    const el = document.createElement('div'); el.className = 'wintool';
    const pick = document.createElement('select');
    const add = btn('새 창'), toggle = btn('열기'), del = btn('삭제'), state = document.createElement('span'); state.className = 'winstate';
    el.append(pick, state, toggle, add, del);
    let open = new Set(), armed = false, known = new Set(env.cfg().child_windows.map(c => c.id));
    listen('win-state', ev => { open = new Set(ev.payload.open); refresh(); });
    emit('win-state-hello', {});

    pick.onchange = () => { env.select(Number(pick.value)); armed = false; };
    add.onclick = () => emit('win-command', { cmd: 'add', name: '' });
    toggle.onclick = () => emit('win-command', { cmd: open.has(env.sel()) ? 'close' : 'open', id: env.sel() });
    del.onclick = () => {
      if (!armed) { armed = true; del.textContent = '정말 삭제?'; del.classList.add('on'); setTimeout(() => { armed = false; refresh(); }, 3000); return; }
      armed = false; const id = env.sel(), c = env.cfg().child_windows.find(w => w.id === id); env.select(1);
      if (c && c.owner && goneOwner(c.owner)) emit('cfg-patch', { patch: { child_windows: without(env.cfg().child_windows, [id]) } });          // (what is left of a plugin that is gone: the window manager does not delete the windows of a plugin)
      else emit('win-command', { cmd: 'remove', id });
    };
    function refresh() {
      const kids = env.cfg().child_windows, sel = env.sel();
      for (const c of kids) if (!known.has(c.id)) { known.add(c.id); if (c.kind !== 'web') { env.select(c.id); return; } }       // a window was just made: show it
      pick.textContent = '';
      const plug = kids.filter(c => c.owner && c.kind !== 'web');                       // (the web windows of the plugins are in the tab 미니 브라우저)
      for (const [id, name] of [[1, nameFor(env.cfg(), 1)], ...kids.filter(c => !c.owner).map(c => [c.id, nameFor(env.cfg(), c.id)])]) {
        const o = document.createElement('option'); o.value = id; o.textContent = `${id} · ${name}`; pick.append(o);
      }
      if (plug.length) {                                                                // (the windows of the plugins: below ours, after a line)
        const line = document.createElement('option'); line.disabled = true; line.textContent = '── ' + tr('플러그인 창') + ' ──'; pick.append(line);
        for (const c of plug) { const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.id} · ${nameFor(env.cfg(), c.id)}` + (goneOwner(c.owner) ? ' · ' + tr('지워진 플러그인') : ''); pick.append(o); }
      }
      pick.value = String(kids.some(c => c.id === sel && c.kind !== 'web') || sel === 1 ? sel : 1);
      const dh = dockHost(kids, sel), isOpen = sel === 1 || open.has(sel), mine = kids.find(c => c.id === sel), owned = !!(mine && mine.owner);
      const orphan = owned && goneOwner(mine.owner), off = owned && !orphan && !((env.cfg().plugins || {})[mine.owner] || {}).enabled;
      state.textContent = orphan ? tr('지워진 플러그인의 설정') : off ? tr('플러그인이 꺼져 있습니다')  : dh ? tr('{name} 창의 탭', { name: nameFor(env.cfg(), dh) }) : sel === 1 ? '항상 열려 있음' : isOpen ? '열려 있음' : '닫혀 있음';
      toggle.hidden = sel === 1 || !!dh || off || orphan; toggle.textContent = isOpen ? '닫기' : '열기';
      del.hidden = sel === 1 || sel === VOICE_ID || (owned && !orphan);                                  // (the window of a plugin is not deleted here: it goes with its plugin) if (!armed) { del.textContent = '삭제'; del.classList.remove('on'); }
    }
    return { el, refresh };
  },
};

// The windows of a plugin show only the basic settings (the order of the windows, the background, the mouse, the lock ...): what is inside the window is the plugin's
const PLUGIN_ROWS = new Set(['name', 'open_mode', 'topmost', 'topmost_wow_only', 'click_through', 'lock_window', 'bg_opacity', 'blur', 'tab_opacity', 'dock_to', 'hide_tools', 'hide_tabs', 'hide_frame']);
const pluginWindow = x => { const c = x.cfg().child_windows.find(w => w.id === x.sel); return !!(c && c.owner); };
const goneWindow = x => { const c = x.cfg().child_windows.find(w => w.id === x.sel); return !!(c && c.owner && c.kind !== 'web' && goneOwner(c.owner)); };          // (the window of a plugin that is not there: only a note and the way to delete it)
for (const card of tab.cards) for (const row of card.rows) {
  const was = row.show;
  row.show = PLUGIN_ROWS.has(row.key) ? (c, x) => !goneWindow(x) && (!was || was(c, x)) : (c, x) => !pluginWindow(x) && (!was || was(c, x));
}
// (first in the tab: shown only for such a window)
tab.cards.unshift({ title: '지워진 플러그인의 창', rows: [{ type: 'custom', block: true, label: '', keywords: '', show: (c, x) => goneWindow(x), build: x => { const c = x.cfg().child_windows.find(w => w.id === x.sel); return goneNote(c ? c.owner : ''); } }] });
export default tab;

function btn(text) { const b = document.createElement('button'); b.textContent = text; return b; }
