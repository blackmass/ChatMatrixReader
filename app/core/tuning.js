// Every "how often" and "how long" of the program in one list (the options tab 고급 shows it, read only), so that nobody has to search the
// code for them. The values of the newer parts live HERE and are read from here; the older ones stay in their own files (where they were
// tuned and tested) and are only listed. Nothing is saved to the config. Port of tuning.py.
import { GOOGLE_MIN_INTERVAL } from './translate.js';
import { TranslationService as S } from './translation_service.js';
import { TIMEOUT as JOINER_TIMEOUT } from './joiner.js';
import { DEFAULTS } from './config.js';

// The timers that can be changed live in core/timings.js (TUNE). What is listed here is fixed in the code or has its own option:
// [group, name, value (or a function), unit, where, what it does]
const TABLE = [
  ['읽기', '초당 읽기 횟수', () => DEFAULTS.poll_hz, '회/초', 'capture.js', '화면에서 채팅을 읽는 횟수 (일반 탭의 설정)'],
  ['읽기', '전체 탐색 간격', () => DEFAULTS.full_scan_sec, '초', 'capture.js', '매트릭스를 못 찾을 때 화면 전체를 훑는 간격 (일반 탭의 설정)'],
  ['읽기', '긴 글 조각 대기', JOINER_TIMEOUT, '초', 'joiner.js', '긴 메시지의 다음 조각을 기다리는 시간 (안 오면 거기까지 보여 줌)'],
  ['번역', '구글(키 없음) 요청 간격', GOOGLE_MIN_INTERVAL, '초', 'translate.js', '키 없는 구글 번역 요청 사이의 최소 간격'],
  ['번역', '한도에 걸렸을 때 최대 대기', S.MAX_WAIT, '초', 'translation_service.js', '더 오래 기다려야 하면 오류로 표시'],
  ['번역', '일시 오류 뒤 재시도 대기', S.SOFT_RETRY_DELAY, '초', 'translation_service.js', '일시 오류 뒤 한 번 더 시도하기까지 기다리는 시간'],
  ['번역', '한도 재시도 횟수', S.MAX_RETRIES, '회', 'translation_service.js', '한도에 걸린 한 줄을 다시 시도하는 최대 횟수'],
  ['번역', '단기 기억(같은 문장 재사용)', S.SHORT_MAX, '줄', 'translation_service.js', '최근에 번역한 서로 다른 문장을 기억하는 수'],
  ['번역', '장기 기억', S.LONG_MAX, '줄', 'translation_service.js', '단기 기억에 있는 동안 다시 나온 문장을 오래 기억하는 수'],
];

export function entries() {
  return TABLE.map(([group, name, value, unit, where, desc]) => ({ group, name, value: typeof value === 'function' ? value() : value, unit, where, desc }));
}
