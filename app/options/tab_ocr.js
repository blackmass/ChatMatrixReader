// OCR: the words of the screen read as text (the lines are marked as read by OCR). Three steps, each with its own choice: reading (the letters), finding the lines,
// translating. The AI server and the glossary are the ones of the translation tab; only what makes the model read instead of translate is here.
import { WHEN, WHEN_HINTS, READERS, reader, readerWhy } from '../core/ocr.js';
import { DEFAULT_OCR_PROMPT, DEFAULT_CAPTURE_PROMPT } from '../core/prompts.js';
import { tr } from '../core/i18n.js';
import { isMac } from '../platform.js';

const address = v => (v === '' || /^https?:\/\//i.test(v) ? '' : '주소는 http:// 또는 https:// 로 시작해야 합니다 (예: http://localhost:1234/v1)');
const usesAi = cfg => reader(cfg) === 'ai';
const different = cfg => cfg.prompt_update_notice && (cfg.ocr_prompt || '').trim() !== DEFAULT_OCR_PROMPT.trim();
const differentCap = cfg => cfg.prompt_update_notice && (cfg.ocr_cap_prompt || '').trim() !== DEFAULT_CAPTURE_PROMPT.trim();

export default {
  id: 'ocr', title: 'OCR', subtitle: '화면의 글자를 읽어서 채팅 줄로 보여 주기',
  cards: [
    { title: 'OCR 기능', note: '꺼져 있으면 아무 일도 하지 않습니다. 켜면 화면의 채팅을 글자로 읽어서 번역창에 "OCR" 줄로 보여 줍니다. 평소("필요할 때만", "상주")에는 매트릭스가 채팅을 읽을 수 없을 때(검열)에만 읽고, "항상"은 매트릭스 대신 계속 읽습니다. 게임이 꺼져 있거나 최소화되어 있으면 읽지 않습니다. OCR 줄의 번역 방식은 번역 탭의 채널별 방식에서, 보여줄 창은 창 설정의 채널에서 고릅니다. 게임 화면을 읽는 보조 기능이니 블리자드의 이용 정책을 따르는 범위에서 쓰세요. 읽은 줄은 틀릴 수 있습니다.', rows: [
      { key: 'ocr_enabled', type: 'check', label: 'OCR 기능 사용', keywords: 'ocr 글자 인식 검열 화면 읽기 켜기',
        note: '창 설정의 "열리는 때"에서 "OCR 기능을 켤 때만"을 고른 창은 이것을 켤 때 열립니다.' },
      { key: 'ocr_when', type: 'select', label: '동작 시점', keywords: '상주 메모리 필요할 때 검열', options: WHEN, hints: WHEN_HINTS,
        note: '"필요할 때만"과 "상주"의 차이는 OCR 엔진을 메모리에 두는 방식뿐입니다. 엔진이 메모리를 얼마나 쓰고 준비에 얼마나 걸리는지는 PC마다 다르니 쓰면서 맞는 쪽을 고르세요. (AI 서버로 읽을 때는 우리 쪽에 올릴 엔진이 없어서 둘이 같습니다.)' },
    ] },
    { title: '읽는 그림', note: 'OCR이 읽는 그림은 일반 탭의 "화면 읽기 방식"과 같은 방식으로 가져옵니다. 매트릭스와 같은 그림입니다.', rows: [
      { type: 'info', label: '지금 방식', keywords: '캡처 화면 게임 창 읽기 방식', text: cfg => (isMac || cfg.capture_mode !== 'window' ? tr('화면') : tr('게임 창')) },
      { type: 'notice', label: '', show: cfg => isMac || cfg.capture_mode !== 'window',
        text: '"화면" 방식은 화면에 보이는 모습을 그대로 읽습니다. 채팅창 위를 번역창, 작업 표시줄, 다른 프로그램의 창이 가리면 그 부분은 읽지 못하니, 채팅창 위에는 아무것도 두지 마세요.' },
      { type: 'info', label: '', show: cfg => !isMac && cfg.capture_mode !== 'window', keywords: '캡처 게임 창 가려짐', text: () => tr('가려도 읽게 하려면 일반 탭에서 "화면 읽기 방식"을 "게임 창"으로 바꾸세요.') },
      { type: 'info', label: '', show: () => isMac, keywords: '캡처 맥', text: () => tr('Mac은 아직 "게임 창" 방식이 없어서 화면 방식으로만 읽습니다.') },
      { type: 'info', label: '', show: cfg => !isMac && cfg.capture_mode === 'window', keywords: '캡처 게임 창 가려짐', text: () => tr('"게임 창" 방식이라 위에 번역창이나 다른 창이 있어도 읽을 수 있습니다.') },
      { type: 'button', label: '방식 바꾸기', button: '일반 탭 열기', keywords: '캡처 화면 게임 창 방식 바꾸기', action: () => { document.dispatchEvent(new CustomEvent('cmr-show-tab', { detail: 'general' })); } },
      { type: 'info', label: '가려졌을 때', keywords: '툴팁 가려짐 마우스 채팅창 위 인터페이스 창', text: () => tr('마우스 툴팁이나 다른 창이 채팅창을 조금이라도 가리면 그 동안은 읽지 않고, 치워지면 그 사이에 올라온 줄만 읽습니다. 가려진 상태로 올라온 줄은 글이 섞여 읽힐 수 있습니다.') },
      { type: 'info', label: '잘 읽히려면', keywords: '배경 진하게 투명도 글자 대비 인식 정확도', text: () => tr('채팅창 배경이 진할수록(투명도를 낮출수록) 잘 읽힙니다. 글자와 배경의 차이가 클수록 줄을 가르는 것도, 글자를 읽는 것도 정확해집니다.') },
    ] },
    { title: '수동 캡처', note: '화면에서 읽고 싶은 곳(길드 소개, 파티 구인 글처럼 채팅 밖에 있는 글)을 직접 골라 글자를 읽고, 번역 탭의 목표 언어로 번역해서 번역창에 "OCR" 줄로 보여 줍니다. 채팅(검열) 읽기와는 따로 동작해서 위의 "OCR 기능 사용"을 켜지 않아도 됩니다. 사용 방법(단축키 등)은 준비 중입니다.', rows: [
      { type: 'info', label: '처리 방법', keywords: '수동 캡처 처리 방법 읽는 방식 번역 ai windows', text: () => tr('읽는 방식(AI 서버, Windows OCR, macOS Vision)은 그림의 글자를 읽기만 합니다. 번역은 읽는 방식과 상관없이 번역 탭의 방식으로 합니다.') },
      { type: 'info', label: '시작 방법', keywords: '수동 캡처 시작 우클릭 메뉴 단축키', text: () => tr('번역창을 오른쪽 클릭해 "수동 캡처"를 고르거나, 아래 단축키를 누릅니다. 시작하는 순간의 게임 화면이 멈춰 보이고, 그 위에서 읽을 곳을 마우스로 끌어 고릅니다 (Esc: 취소). 마우스 툴팁처럼 금방 사라지는 글은 단축키를 눌러야 읽을 수 있습니다 (메뉴를 누르려고 마우스를 옮기면 사라집니다).') },
      { key: 'ocr_cap_hotkey', type: 'hotkey', blank: '(없음)', label: '수동 캡처 단축키', keywords: '수동 캡처 단축키 핫키 hotkey',
        note: '비워 두면 단축키가 없습니다. 게임이 앞에 있을 때만 동작합니다. 글자·숫자 키는 채팅을 칠 때도 눌리니 Ctrl이나 Alt와 함께 쓰세요 (Shift만 쓰면 대문자를 칠 때 겹칩니다).' },
      { key: 'ocr_cap_prompt', show: usesAi, type: 'textarea', rows: 5, label: '수동 캡처 프롬프트', keywords: '수동 캡처 프롬프트 번역 지시 ocr',
        note: '"AI 서버"로 읽을 때, 모델이 그림의 글자를 글자 그대로 옮기게 하는 지시입니다 (번역은 하지 않습니다: 번역은 번역 탭의 방식이 따로 합니다). 잘 모르면 건드리지 마세요. "기본값"으로 되돌릴 수 있습니다.' },
      { type: 'notice', label: '', show: cfg => usesAi(cfg) && differentCap(cfg), text: '지금 수동 캡처 프롬프트는 프로그램에 들어 있는 최신 기본 프롬프트와 다릅니다. 직접 고치신 게 아니라면 "기본값"으로 되돌려 주세요.' },
    ] },
    { title: '읽기', note: '그림에서 글자를 만드는 단계입니다.', rows: [
      { key: 'ocr_read', type: 'select', label: '읽는 방식', keywords: '엔진 ai windows vision 비전 모델', options: () => READERS(),
        get: cfg => reader(cfg), patch: (cfg, v) => ({ ocr_read: v }),
        note: 'AI 서버: 그림을 보는 모델이 읽어서 정확합니다. 속도는 서버(모델, 그래픽카드)에 달려 있습니다. Windows OCR: 윈도우에 들어 있는 글자 인식으로, 읽는 데 0.03초쯤 걸려 아주 빠르고 PC를 거의 쓰지 않지만, 작은 글자나 기호는 AI보다 덜 정확합니다. macOS Vision: 맥에 들어 있는 글자 인식(Vision)으로, 빠르고 PC를 거의 쓰지 않습니다. 다른 엔진은 나중에 확장 기능으로 받게 됩니다.' },
      { type: 'notice', label: '', show: cfg => reader(cfg) === 'windows',
        text: 'Windows OCR은 읽을 언어의 언어팩(텍스트 인식 포함)이 Windows에 설치되어 있어야 읽습니다 (설정 → 시간 및 언어 → 언어 및 지역). 한국어 채팅이면 한국어 언어팩 하나로 시작하세요. 영문이 틀리게 읽히면 아래 "Windows OCR 언어"에 en-US를 적어 보세요. 로그에 읽을 수 있는 언어 목록이 남습니다.' },
      { key: 'ocr_win_lang', type: 'text', label: 'Windows OCR 언어', show: cfg => reader(cfg) === 'windows', placeholder: '비워 두면 Windows의 언어 설정을 따름 (예: ko, en-US)', keywords: 'windows ocr 언어 ko en 한국어 영어 언어팩',
        note: '한국어 채팅이면 ko, 영어면 en-US처럼 언어 코드를 적습니다. 그 언어의 언어팩이 설치되어 있어야 읽습니다. 로그에 읽을 수 있는 언어 목록이 남습니다. 기호나 이모지(⚠, ▲ 등)는 읽지 못할 수 있습니다.' },
      { type: 'notice', label: '', show: cfg => reader(cfg) === 'vision',
        text: 'macOS Vision은 한국어를 읽으려면 macOS 13 이상이어야 합니다. 더 낮은 버전에서는 영어 같은 일부 언어만 읽습니다. 한국어가 읽히지 않으면 "AI 서버"를 고르세요. 로그에 읽을 수 있는 언어 목록이 남습니다.' },
      { key: 'ocr_win_lang', type: 'text', label: 'macOS Vision 언어', show: cfg => reader(cfg) === 'vision', placeholder: '비워 두면 한국어와 영어 (예: ko, en-US, ja)', keywords: 'macos vision 비전 맥 ocr 언어 ko en 한국어 영어',
        note: '읽을 언어를 쉼표로 적습니다 (ko, en-US, ja 처럼). 맥이 읽을 수 있는 언어만 쓰입니다. 기호나 이모지(⚠, ▲ 등)는 읽지 못할 수 있습니다.' },
      { type: 'notice', label: '', show: cfg => !!readerWhy(reader(cfg)), text: '고른 엔진은 아직 만들고 있어서 읽지 못합니다. 지금은 "AI 서버"를 고르세요.' },
    ] },
    { title: 'AI 서버', note: '비워 두면 번역 탭의 AI 서버(주소, 모델, 키)를 그대로 씁니다. 그림을 볼 수 있는 모델이어야 합니다. 단어장도 번역 탭의 것을 씁니다.', rows: [
      { key: 'ocr_ai_url', show: usesAi, type: 'text', label: '서버 주소', wide: true, placeholder: '비워 두면 번역 탭의 주소', keywords: 'url 주소 서버 lm studio', validate: address },
      { key: 'ocr_ai_model', show: usesAi, type: 'text', label: '모델 이름', wide: true, placeholder: '비워 두면 번역 탭의 모델', keywords: '모델 model 비전' },
      { key: 'ocr_ai_parallel', show: usesAi, type: 'select', label: '동시에 보내는 읽기 수', keywords: '동시 병렬 읽기 요청 속도 lm studio', options: [['1', '1개 (기본)'], ['2', '2개'], ['3', '3개'], ['4', '4개']],
        get: cfg => String(cfg.ocr_ai_parallel || 1), patch: (cfg, v) => ({ ocr_ai_parallel: Number(v) }),
        note: '검열된 메시지가 몰릴 때 읽기를 이만큼 동시에 서버로 보냅니다. 서버가 요청을 동시에 처리할 수 있어야 빨라지고(LM Studio의 동시 처리 설정), 아니면 서버에서 줄을 서서 그대로입니다. 결과는 메시지 번호 순서로 보여 줍니다.' },
      { key: 'ocr_ai_key', show: usesAi, type: 'password', label: 'API 키', wide: true, keywords: '키 key 토큰', note: '비워 두면 번역 탭의 키를 씁니다.' },
      { key: 'ocr_prompt', show: usesAi, type: 'textarea', rows: 8, label: '읽기 프롬프트', keywords: '프롬프트 지시 읽기 ocr',
        note: '모델이 그림을 글자로 옮길 때의 지시입니다. 잘 모르면 건드리지 마세요. "기본값"으로 되돌릴 수 있습니다.' },
      { type: 'notice', label: '', show: cfg => usesAi(cfg) && different(cfg), text: '지금 읽기 프롬프트는 프로그램에 들어 있는 최신 기본 프롬프트와 다릅니다. 직접 고치신 게 아니라면 "기본값"으로 되돌리는 것을 권장합니다.' },
    ] },
  ],
  dot: cfg => different(cfg) || differentCap(cfg),
};
