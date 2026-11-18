// 번역: how lines are translated (method, server connection) and the choice per channel. The prompt and the glossary are their own tab.
import { ALL } from '../winmanager.js';
import { chName, chColor } from './channels.js';
import { LANGS } from '../core/translate_rules.js';
import { CUSTOM_PRESETS, CUSTOM_PRESET_MANUAL } from '../core/translate.js';

// a preset fills the address, headers, body and answer place (the user can still change each)
export const notKorean = cfg => { const t = (cfg.target_lang || '').trim(); return t !== '' && t !== '한국어' && t.toLowerCase() !== 'ko' && t.toLowerCase() !== 'korean'; };
export const LANG_WARNING = '목표 언어가 한국어가 아니면 단어장과 프롬프트도 그 언어에 맞게 새로 써야 합니다. 지금 단어장의 뜻과 기본 프롬프트의 예시는 한국어라서, 그대로 두면 AI가 목표 언어와 상관없이 한국어로 번역할 수 있습니다.';

// The model list of the AI server: the program (hub) asks the server with the address and key as they are set now ('rpc-models' -> 'rpc-models-result').
// Resolves with [{ value }]; rejects with an Error that has `kind` ('connect' | 'format') for the note beside the box.
let modelSeq = 0, modelReady = null;
const modelWaiting = new Map();
export async function requestModels() {
  const { emit, listen } = window.__TAURI__.event;
  if (!modelReady) {
    modelReady = listen('rpc-models-result', ev => {
      const r = ev.payload || {}, w = modelWaiting.get(r.id);
      if (!w) return;
      modelWaiting.delete(r.id); clearTimeout(w.timer);
      if (r.error) w.rej(Object.assign(new Error(r.error), { kind: r.kind })); else w.res((r.models || []).map(value => ({ value })));
    });
  }
  await modelReady;
  return new Promise((res, rej) => {
    const id = ++modelSeq;
    const timer = setTimeout(() => { modelWaiting.delete(id); rej(Object.assign(new Error('timed out'), { kind: 'connect' })); }, 15000);
    modelWaiting.set(id, { res, rej, timer });
    emit('rpc-models', { id });
  });
}

const applyPreset = (ctx, name) => {
  const p = CUSTOM_PRESETS[name];
  ctx.set(p ? { custom_preset: name, custom_url: p[0], custom_headers: p[1], custom_body_type: p[2], custom_body: p[3], custom_path: p[4] } : { custom_preset: '' });
};

const METHODS = [['google_free', '구글 (무료)'], ['google', '구글 (API 키)'], ['openai', 'AI 서버'], ['custom', '직접 설정한 서버']];

export default {
  id: 'translation', title: '번역', test: true, subtitle: '번역 방식과 서버 연결, 채널별 방식',
  cards: [
    { title: '방식', rows: [
      { key: 'translator', type: 'select', label: '번역 방식', keywords: '번역기 구글 ai openai 서버 끄기',
        options: [['none', '번역 안 함'], ['google', '구글 번역'], ['openai', 'AI 서버 (OpenAI 호환)'], ['custom', '직접 설정한 서버']] },
      { key: 'target_lang', type: 'combo', list: LANGS, label: '목표 언어', placeholder: 'ko, pt-BR 처럼 구글 언어 코드', keywords: '번역할 언어 target 한국어 영어 일본어',
        note: '받은 채팅을 이 언어로 번역합니다. 목록에 없는 언어는 "직접 입력"에 구글 언어 코드(예: pt, ar, zh-TW)를 쓰세요. AI에게는 이 이름이 그대로 전달됩니다.' },
      { type: 'notice', label: '', show: notKorean, text: LANG_WARNING },
    ] },
    { title: '구글', fold: true, open: cfg => cfg.translator === 'google', note: '번역 방식이 아니어도, 채널별 방식에서 고르면 여기 설정을 씁니다.', rows: [
      { key: 'google_free', type: 'check', label: '무료 방식 사용', keywords: '구글 무료',
        note: '끄면 아래 API 키로 공식 구글 번역을 씁니다. 무료 방식은 비공식이라 많이 보내면 잠시 막힐 수 있습니다.' },
      { key: 'google_api_key', type: 'password', label: 'API 키', wide: true, keywords: '구글 키 api key', show: cfg => !cfg.google_free },
    ] },
    { title: 'AI 서버', fold: true, open: cfg => cfg.translator === 'openai', rows: [
      { key: 'api_url', type: 'text', label: '서버 주소', wide: true, placeholder: 'http://localhost:1234/v1', keywords: 'openai lm studio ollama url' },
      { key: 'api_model', type: 'suggest', label: '모델 이름', placeholder: '비워 두면 서버 기본', keywords: '모델 model 목록', items: () => requestModels(),
        needs: cfg => ((cfg.api_url || '').trim() ? '' : '서버 주소를 먼저 적어 주세요'), cacheKey: cfg => (cfg.api_url || '') + '|' + (cfg.api_key || ''), fail: { connect: '연결 확인 실패', format: '모델 로드 실패' },
        note: '칸을 누르면 위의 서버에서 모델 목록을 가져와 보여 줍니다. 목록에 없는 이름은 그대로 적어도 됩니다.' },
      { key: 'api_key', type: 'password', label: 'API 키', wide: true, keywords: '키 key 토큰', note: '로컬 서버는 비워 둡니다.' },
      { key: 'temperature', type: 'number', label: '창의성 (temperature)', min: 0, max: 2, step: 0.1, keywords: '온도 temperature' },
      { key: 'max_tokens', type: 'number', label: '답변 최대 길이', min: 20, max: 4000, unit: '토큰' },
      { key: 'disable_reasoning', type: 'check', label: '추론(생각) 끄기', keywords: 'reasoning thinking', note: '추론하는 모델에서 번역이 느려지는 것을 막습니다.' },
    ] },
    { title: '직접 설정한 서버', fold: true, open: cfg => cfg.translator === 'custom', note: '{text} 같은 자리표시자 사용법은 docs 폴더의 설명을 참고하세요.', rows: [
      { key: 'custom_preset', type: 'select', label: '서비스', keywords: '프리셋 deepl papago azure gemini claude libretranslate 파파고 딥엘', apply: applyPreset,
        options: [['', CUSTOM_PRESET_MANUAL], ...Object.keys(CUSTOM_PRESETS).map(n => [n, n])],
        note: 'DeepL, Azure, Papago 등은 고르면 아래 칸이 채워집니다. 키만 넣으면 됩니다. 아래 칸을 직접 고쳐도 됩니다.' },
      { type: 'info', label: '고른 서비스의 안내', show: cfg => !!(CUSTOM_PRESETS[cfg.custom_preset] || [])[5], text: cfg => (CUSTOM_PRESETS[cfg.custom_preset] || [])[5] || '' },
      { key: 'custom_url', type: 'text', label: '주소', wide: true, keywords: 'url deepl 직접' },
      { key: 'custom_key', type: 'password', label: '키', wide: true },
      { key: 'custom_headers', type: 'textarea', label: '헤더 (JSON)', rows: 3, keywords: 'headers' },
      { key: 'custom_body_type', type: 'select', label: '본문 형식', options: [['json', 'JSON'], ['form', '폼']] },
      { key: 'custom_body', type: 'textarea', label: '본문', rows: 5, keywords: 'body' },
      { key: 'custom_path', type: 'text', label: '번역문 위치', wide: true, placeholder: 'translations.0.text', keywords: 'path 결과' },
    ] },
    { title: '속도와 안전', rows: [
      { key: 'timeout', type: 'number', label: '응답 기다리는 시간', min: 3, max: 300, unit: '초', keywords: '타임아웃' },
      { key: 'max_parallel', type: 'number', label: '동시에 보내는 수', min: 1, max: 8, keywords: '병렬', note: '구글 무료 방식은 1~2가 안전합니다.' },
      { key: 'max_pending', type: 'number', label: '대기열 최대', min: 1, max: 200, unit: '줄', keywords: '밀림 대기', note: '번역이 밀릴 때 이보다 많이 쌓이면 새 줄은 번역하지 않고 원문만 보여 줍니다.' },
      { key: 'translate_test_start', type: 'check', label: '시작 시 연결 시험', keywords: '테스트 시험 번역 서버' },
      { key: 'log_request', type: 'check', label: '요청 로그 기록', keywords: '로그 디버그 프롬프트', note: '문제를 찾을 때만 켜세요. 로그가 커집니다.' },
    ] },
    { title: '채널별 방식', note: '채널마다 다른 방식을 쓰거나 번역하지 않을 수 있습니다. 비워 두면 위의 번역 방식을 따릅니다.', rows: [
      { key: 'channel_route', type: 'routes', label: '채널별 선택', keywords: '채널 귓속말 파티 길드 번역 끄기', codes: ALL, names: chName, color: chColor,
        options: [...METHODS, ['off', '번역 안 함']] },
    ] },
  ],
};
