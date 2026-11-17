// The texts of the voice recognition messages (port of the text helpers of voice.py). The process handling lives elsewhere.
import { tr } from './i18n.js';
const tr0 = tr;

export const LOG_NAME = 'logs/chatmatrix.log';          // (where the lines of the engine end up: the program log, `음성 엔진: ...`)

export function notInstalledText(broken = false) {
  return broken ? tr('음성 인식 설치가 끝나지 않았습니다. 옵션의 음성 탭에서 설치하기를 다시 눌러 주세요.')
                : tr('음성 인식(Whisper)이 설치되어 있지 않습니다. 옵션의 음성 탭에서 설치하기를 눌러 설치해 주세요.');
}

// the child's error text ("[no_connection] ...") in the user's language; any other text stays as it is
export function explainError(msg) {
  const m = /\[(\w+)\]\s*([\s\S]*)/.exec(msg || '');
  if (!m) return msg || '';
  const code = m[1], detail = m[2].trim();
  switch (code) {
    case 'no_connection': return tr('서버에 연결할 수 없습니다. 주소를 확인하고 서버가 실행 중인지 보세요. ({detail})', { detail });
    case 'not_found': return tr('주소가 맞지 않습니다 (404). 주소 끝이 /v1 인지 확인하세요. ({detail})', { detail });
    case 'unauthorized': return tr('API 키가 맞지 않습니다. ({detail})', { detail });
    case 'bad_request': return tr('서버가 요청을 받아들이지 않았습니다. 모델 이름을 확인하세요. ({detail})', { detail });
    case 'server_error': return tr('서버 내부 오류입니다. ({detail})', { detail });
    case 'timeout': return tr('서버가 제한 시간 안에 답하지 않았습니다. ({detail})', { detail });
    case 'bad_response': return tr('서버의 답을 알아볼 수 없습니다. OpenAI 방식의 음성 인식(transcriptions)을 지원하는 서버인지 확인하세요. ({detail})', { detail });
    case 'bad_address': return tr('주소는 http:// 또는 https:// 로 시작해야 합니다 (예: http://localhost:8000/v1)');
    default: return msg;
  }
}

// why the voice recognition is not on (state.code / state.msg of core/voice.js), in words
export function stateWhy(s) {
  switch (s.code) {
    case 'not_installed': return tr('Whisper가 설치되어 있지 않습니다. 아래 Whisper 칸에서 설치해 주세요.');
    case 'no_model': return tr('모델 {model}이 설치되어 있지 않습니다.', { model: s.msg });
    case 'no_url': return tr('서버 주소가 비어 있습니다. 아래 서버 칸에 주소를 적어 주세요.');
    case 'no_backend': return tr('이 빌드에는 음성 엔진을 실행하는 기능이 아직 없습니다.');
    default: return s.msg || tr('알 수 없는 오류');
  }
}

// the one line that says what the voice recognition is doing (the options and the tip of the widget)
export function statusText(s, tr = tr0) {
  const DEVICE = { cpu: 'CPU', gpu: 'GPU' };
  return s.state === 'on' ? tr('켜져 있음') + ' · ' + [s.engine === 'server' ? tr('OpenAI 호환 서버') : 'Whisper', DEVICE[s.device], s.model].filter(Boolean).join(' · ')
    : s.state === 'starting' ? tr('켜는 중…') : s.state === 'stopping' ? tr('끄는 중…')
    : s.state === 'error' ? tr('꺼져 있음') + ' · ' + stateWhy(s) : tr('꺼져 있음');
}
