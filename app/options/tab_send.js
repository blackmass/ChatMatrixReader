// 보내기: what you type in the send box (Shift+Enter) is translated and put on the clipboard.
import { LANGS } from '../core/translate_rules.js';
import { DEFAULT_SEND_PROMPT, DEFAULT_SEND_EXTRA_PROMPT } from '../core/prompts.js';

const different = cfg => cfg.prompt_update_notice && (cfg.send_prompt || '').trim() !== DEFAULT_SEND_PROMPT.trim();

export default {
  id: 'send', title: '보내기', subtitle: '내가 쓴 말을 번역해서 보내기',
  cards: [
    { title: '보내기', note: '단축키를 누르면 입력칸이 열립니다. 쓴 말을 번역해서 클립보드에 넣고, 채팅창에 붙여 넣으면 됩니다. 입력칸 앞의 작은 칸에는 /w 이름 같은 말 상대를 적을 수 있습니다.', rows: [
      { key: 'send_enabled', type: 'check', label: '보내기 사용', keywords: '번역 입력 채팅' },
      { key: 'send_hotkey', type: 'hotkey', label: '단축키', keywords: '핫키 hotkey shift enter', note: 'Ctrl, Alt, Shift 중 하나 이상과 키를 고릅니다.' },
      { key: 'send_lang', type: 'combo', list: LANGS, label: '보내는 언어', placeholder: 'Português, ar 처럼', keywords: '영어 상대 언어 번역할 언어 목표',
        note: '내가 쓴 말을 이 언어로 바꿔 보냅니다. 목록에 없으면 "직접 입력"에 언어 이름이나 구글 언어 코드를 쓰세요.' },
      { key: 'send_route', type: 'select', label: '번역 방식', keywords: '구글 ai 서버 라우트',
        options: [['default', '번역 탭의 방식 따름'], ['google_free', '구글 (무료)'], ['google', '구글 (API 키)'], ['openai', 'AI 서버'], ['custom', '직접 설정한 서버']] },
      { key: 'send_show_log', type: 'check', label: '보낸 말 표시', keywords: '로그 ↗', note: '끄면 게임에서 돌아온 내 채팅 줄로만 보입니다.' },
      { key: 'send_autopaste', type: 'check', label: '자동 붙여넣기', keywords: '붙여넣기 paste',
        note: '끄면 번역이 끝난 뒤 직접 Ctrl+V를 누릅니다. 켜면 게임의 채팅 입력칸이 열려 있을 때 프로그램이 대신 눌러 줍니다.' },
    ] },
    { title: 'AI 프롬프트', note: 'AI 서버나 직접 설정한 서버(LLM)로 번역할 때만 쓰입니다.', rows: [
      { key: 'send_extra_prompt', type: 'textarea', rows: 3, label: '추가 지시', keywords: '말투 스타일',
        note: '기본 프롬프트 끝에 덧붙습니다. 비워 두면 쓰지 않습니다. 영어로 쓰기를 권합니다.' },
      { type: 'examples', target: 'send_extra_prompt', label: '예시 (눌러서 위 칸에 넣기)', keywords: '예문 말투 해적 반말 존댓말',
        items: [['자연스럽게', DEFAULT_SEND_EXTRA_PROMPT], ['존댓말로', 'Write in a polite, formal tone, like talking to a stranger.'],
          ['반말로 짧게', 'Write casually and keep it short.'], ['해적 말투로', 'Always write the message in the style of a pirate.']] },
      { key: 'send_prompt', type: 'textarea', rows: 14, label: '기본 프롬프트', keywords: '지시 system 프롬프트',
        note: '{send_lang}은 위에서 고른 언어로 바뀝니다. 잘 모르면 건드리지 마세요. "기본값"으로 되돌릴 수 있습니다.' },
      { type: 'notice', label: '', show: different,
        text: '지금 프롬프트는 프로그램에 들어 있는 최신 기본 프롬프트와 다릅니다. 직접 고치신 게 아니라면 "기본값"으로 되돌려 최신 버전을 받는 것을 권장합니다. (알림은 단어장·프롬프트 탭에서 끌 수 있습니다)' },
    ] },
  ],
  dot: different,
};
