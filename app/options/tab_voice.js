// 음성인식: the voice chat of other people as text in the '음성인식' channel. The engine (Whisper) is an extension in extensions/stt/, not part
// of the program: it is installed and removed here. The live parts (state, installed, resources) are in voice_rows.js.
import { statusRow, installRow, modelsRow, statsRow, appPickerRow, sourcesRow } from './voice_rows.js';
import { MODELS, TARGETS, LANGS, deviceOf } from '../core/voice.js';
import { METHODS } from '../core/voice_target.js';
import { isMac } from '../platform.js';

const whisper = cfg => (cfg.voice_engine || 'whisper') !== 'openai';
const address = v => (v === '' || /^https?:\/\//i.test(v) ? '' : '주소는 http:// 또는 https:// 로 시작해야 합니다 (예: http://localhost:8000/v1)');

// macOS: the voice recognition is not made there yet (planned): one note instead of the settings
const NOT_ON_MAC = [{ title: '음성인식', rows: [
  { type: 'info', label: 'Mac', keywords: 'mac macos 맥 지원 예정', text: () => 'Mac에서는 음성인식을 아직 지원하지 않습니다 (지원 예정). Windows에서만 쓸 수 있습니다.' },
] }];

const CARDS = [
    { title: '음성인식', note: '옵션 이름 옆의 표시: "바로 적용"은 켜 둔 채 바꿔도 반영되고, "다시 시작해야 적용"은 바꾼 뒤 "지금 다시 시작"을 눌러야 반영됩니다. 표시가 없는 옵션은 켜고 끄는 것과 상관없습니다.', rows: [
      { type: 'custom', block: true, label: '상태', keywords: '켜기 끄기 on off 시작 정지 음성 stt', build: statusRow,
        note: '버튼에 적힌 글이 누르면 일어나는 일입니다.' },
      { key: 'voice_enabled', type: 'check', label: '시작할 때 자동으로 켜기', keywords: '자동 시작 음성',
        note: '프로그램을 켤 때 음성인식도 함께 켭니다. 위 버튼으로 지금 켜고 끄는 것과는 별개입니다.' },
      { key: 'voice_engine', type: 'select', when: 'restart', label: '음성인식 방식', keywords: 'whisper openai 서버 엔진 stt',
        options: [['whisper', 'Whisper (이 PC에서 인식)'], ['openai', 'OpenAI 호환 서버']],
        note: '방식을 바꾸면 다시 시작해야 적용됩니다.' },
    ] },
    { title: '인식 대상', note: '어느 프로그램의 소리를 글로 바꿀지 고릅니다.', rows: [
      { key: 'voice_target', type: 'select', when: 'live', label: '소리 대상', keywords: '디스코드 discord 와우 wow 프로그램 세션 소리 대상 캡처', options: TARGETS,
        hints: { discord: '디스코드는 프로그램과 음성 대화의 소리 세션이 따로 있어서, 음성 대화의 소리만 가려 듣습니다.', 'discord-all': '디스코드가 내는 모든 소리를 듣습니다 (음성 대화 외의 알림음도 포함).', app: '아래 목록에서 소리를 내는 프로그램을 고릅니다.' } },
      { key: 'voice_app', type: 'custom', when: 'live', label: '프로그램', keywords: '프로세스 process 프로그램 목록 선택 exe', build: appPickerRow, block: true, show: cfg => cfg.voice_target === 'app',
        note: '지금 소리를 내는 프로그램의 목록입니다. 프로그램을 켜고 소리를 낸 뒤 "목록 새로 고침"을 누르세요.' },
      { key: 'voice_capture', type: 'select', when: 'live', label: '소리 받는 방식', keywords: '캡처 단독 프로세스 loopback 장치 게이트 capture 방식', options: METHODS,
        hints: { auto: '대부분 이것이면 됩니다. 켜져 있는 동안 위쪽 상태 줄에 실제로 어떤 방식으로 받고 있는지 나옵니다.', process: 'Windows가 거부하면 소리를 받지 못하고, 다시 시도합니다.', device: '같은 장치에서 나오는 다른 프로그램의 소리가 섞이지 않도록, 대상 프로그램이 소리를 내는 동안만 통과시킵니다.' },
        note: '프로그램만 따로 받는 것이 가장 정확합니다. 안 될 때 "장치 전체" 방식을 고르세요. 세부 기준은 고급 탭의 "음성인식" 항목에서 바꿉니다.' },
      { key: 'voice_lang', type: 'combo', when: 'live', label: '말하는 언어', blank: '자동 감지 (문장마다)', list: LANGS, placeholder: 'ko, en 처럼 언어 코드', keywords: '언어 language 한국어 영어 정확도',
        note: '상대가 쓰는 언어를 고르면 인식이 더 정확해집니다. 섞어 쓰면 자동 감지를 두세요.' },
    ] },
    { title: '표시 방식', rows: [
      { key: 'voice_mode', type: 'select', when: 'live', label: '표시 방식', keywords: '문장 실시간 live sentence 모드',
        options: [['sentence', '문장 (한 문장이 끝나면 한 번에)'], ['live', '실시간 (말하는 동안 계속 갱신)']],
        hints: { live: 'Whisper는 문장 방식 전용입니다. 실시간 방식은 이것을 지원하는 인식 방식에서만 쓰입니다.' } },
      { key: 'voice_partial_ms', type: 'number', when: 'live', label: '실시간 갱신 간격', min: 200, max: 5000, step: 100, unit: 'ms', show: cfg => cfg.voice_mode === 'live', keywords: '갱신 부분 partial' },
    ] },
    { title: 'Whisper', fold: true, follow: true, open: whisper, note: '확장 기능입니다. 프로그램 폴더의 extensions/stt 안에만 설치되고, 삭제하면 그 폴더가 지워집니다.', rows: [
      { type: 'custom', block: true, label: '설치 상태', keywords: '설치 삭제 추가 install cpu vulkan cuda gpu 엔진 모델', build: installRow },
      { type: 'custom', block: true, label: '받는 곳과 라이선스', keywords: '출처 링크 공식 허깅페이스 huggingface 라이선스 license mit 다운로드 모델 엔진 whisper.cpp openai', build: sourcesRow,
        note: '이 프로그램이 인터넷에서 받는 것은 음성인식 엔진과 모델뿐이고, 받는 곳은 위와 같습니다. 모델과 whisper.cpp는 MIT 라이선스입니다.' },
      { key: 'voice_device', type: 'select', when: 'restart', label: '계산 장치', keywords: 'cpu gpu cuda vulkan 그래픽카드 장치 device',
        options: [['auto', '자동 (GPU가 있으면 GPU)'], ['cpu', 'CPU'], ['gpu', 'GPU']],
        get: cfg => deviceOf(cfg), patch: (cfg, v) => ({ voice_device: v }),
        note: '대부분의 환경에서는 Vulkan(GPU) 엔진과 large-v3-turbo 모델을 권장합니다. GPU는 Vulkan 엔진을 설치했을 때만 쓸 수 있습니다 (NVIDIA 그래픽카드에서도 Vulkan으로 동작합니다. CUDA 엔진은 예정입니다). CPU만 쓸 때는 large-v3-turbo가 말하는 속도를 따라가지 못할 수 있어서, small이나 base처럼 더 작은 모델을 쓰세요 (아래 "모델 목록과 속도"에서 직접 재 볼 수 있습니다).' },
      { key: 'voice_model', type: 'combo', when: 'restart', label: '모델', blank: '기본 (large-v3-turbo)', list: MODELS, placeholder: '모델 이름', keywords: '모델 model large turbo small base tiny',
        note: '큰 모델일수록 정확하지만 느리고 메모리를 많이 씁니다. 얼마나 느린지는 PC마다 달라서, 아래 "모델 목록과 속도"에서 모델을 받아 직접 재 보고 고르세요. 작은 모델은 빠른 대신 작은 소리, 잡음, 게임 용어와 이름에서 틀리기 쉽습니다.' },
      { type: 'custom', block: true, label: '모델 목록과 속도', keywords: '모델 속도 시험 벤치 benchmark 배율 삭제 받기 비교 느림 빠름', build: modelsRow,
        note: '어떤 모델이 설치되어 있는지 보고, 모델마다 받거나 지울 수 있습니다. 배율은 "인식에 걸린 시간 ÷ 말한 시간"입니다: ×0.4는 10초 분량을 4초에 처리한다는 뜻이고, ×1을 넘으면 말을 따라가지 못합니다. "실제 사용 배율"은 음성인식을 쓰는 동안 쌓이고(괄호는 문장 수), "시험 배율"은 같은 소리 파일로 잰 값입니다.' },
      { type: 'custom', block: true, label: '사용 중인 자원', keywords: 'cpu ram gpu vram 메모리 점유율 사용량 자원', build: statsRow,
        note: '음성인식 엔진(별도 프로그램)이 쓰는 양입니다. 켜져 있을 때만 나옵니다.' },
    ] },
    { title: 'OpenAI 호환 서버', fold: true, follow: true, open: cfg => !whisper(cfg), note: 'OpenAI 방식의 음성 인식(/audio/transcriptions)을 지원하는 서버로 소리를 보내 인식합니다. Whisper 설치가 필요 없습니다.', rows: [
      { key: 'voice_oa_url', type: 'text', when: 'restart', label: '서버 주소', wide: true, placeholder: 'http://localhost:8000/v1', keywords: 'url openai 서버 주소', validate: address },
      { key: 'voice_oa_key', type: 'password', when: 'restart', label: 'API 키', wide: true, keywords: '키 key 토큰', note: '로컬 서버는 비워 둡니다.' },
      { key: 'voice_oa_model', type: 'text', when: 'restart', label: '모델 이름', wide: true, placeholder: 'whisper-1', keywords: '모델 model', note: '비워 두면 whisper-1 입니다.' },
      { key: 'voice_oa_timeout', type: 'number', when: 'restart', label: '응답 기다리는 시간', min: 3, max: 300, unit: '초', keywords: '타임아웃 timeout' },
    ] },
    { title: '고급', fold: true, rows: [
      { key: 'voice_end_ms', type: 'number', when: 'live', label: '문장을 끝내는 무음 시간', min: 200, max: 5000, step: 50, unit: 'ms', keywords: '무음 침묵 끊기 vad 문장',
        note: '말이 이만큼 멈추면 한 문장이 끝난 것으로 보고 인식합니다. 짧으면 문장이 잘게 끊기고, 길면 글이 늦게 나옵니다.' },
      { key: 'voice_max_s', type: 'number', when: 'live', label: '한 번에 인식할 최대 길이', min: 3, max: 30, unit: '초', keywords: '최대 길이 자르기',
        note: '쉬지 않고 이어지는 말은 이 길이에서 잘라 인식합니다.' },
      { key: 'voice_min_db', type: 'number', when: 'live', label: '말로 인식하는 최소 소리 크기', min: -60, max: -25, unit: 'dB', keywords: '소리 크기 민감도 기준선 음량 작은 목소리 임계값 threshold db 피크',
        note: '이보다 작은 소리는 말이 아닌 것으로 봅니다. 목소리가 작게 들어와서 인식이 안 되면 값을 낮추고(예: -50), 잡음이 글로 나오면 높이세요. 켜져 있을 때 음량바의 주황 눈금이 이 값을 따라 움직입니다. 주변 잡음이 더 크면 그에 맞춰 눈금이 자동으로 더 올라갑니다.' },
      { key: 'voice_prompt', type: 'text', when: 'live', label: '인식 힌트 (선택)', wide: true, placeholder: 'Tank, Healer, Mythic, Raid …', keywords: '힌트 프롬프트 prompt 단어 용어',
        note: '자주 나오는 단어를 적어 두면 그 단어를 더 잘 알아듣습니다. 말하는 언어가 정해져 있을 때만 쓰세요. 비워 두면 쓰지 않습니다.' },
    ] },
];

export const voiceCards = mac => (mac ? NOT_ON_MAC : CARDS);

export default {
  id: 'voice', title: '음성인식', subtitle: '음성 대화를 글로 바꿔 음성인식 채널에 표시',
  cards: voiceCards(isMac),
};
