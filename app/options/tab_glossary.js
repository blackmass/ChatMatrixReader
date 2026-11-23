// 단어장·프롬프트: the glossary (a text file, edited here) and what the AI is told. (The prompt for sending is in the 보내기 tab.)
import { notKorean, LANG_WARNING } from './tab_translation.js';
import { files } from '../fs.js';
import { GLOSSARY_STYLES, DEFAULT_NAME, SAMPLE_NAME } from '../core/glossary.js';
import { DEFAULT_PROMPT, DEFAULT_EXTRA_PROMPT } from '../core/prompts.js';

export default {
  id: 'glossary', title: '단어장·프롬프트', test: true, subtitle: '단어장과 AI에게 주는 지시',
  cards: [
    { title: '단어장', rows: [
      { type: 'notice', label: '', show: notKorean, text: LANG_WARNING },
      { key: 'glossary_file', type: 'text', label: '단어장 파일 이름', placeholder: DEFAULT_NAME, keywords: '파일 glossary', note: '프로그램 폴더 안의 파일 이름입니다. 파일이 없으면 저장할 때 만들어집니다.' },
      { type: 'file', label: '내용', keywords: '단어 뜻 약어 편집', files, sample: SAMPLE_NAME, rows: 18, path: cfg => (cfg.glossary_file || '').trim() || DEFAULT_NAME,
        note: '한 줄에 "단어=뜻". 저장하면 바로 반영됩니다. 자세한 쓰는 법은 파일 맨 위의 설명을 보세요.' },
      { key: 'glossary_google', type: 'check', label: '구글에도 단어장', keywords: '구글',
        note: '구글은 문맥을 판단하지 못해서, 뜻이 하나뿐인 단어만 적용됩니다.' },
      { key: 'glossary_mode', type: 'select', label: '단어장 전달 방식', keywords: 'ai 전체 목록 혼합 토큰',
        options: [['full', '전체'], ['list', '선별'], ['mixed', '복합']],
        hints: { full: '단어장 전체를 프롬프트에 넣습니다. (기본) 단어장이 100줄을 넘으면 AI 서버가 한 번에 읽을 수 있는 양(컨텍스트)을 넘길 수 있으니, 이 설정을 "선별" 또는 "복합"으로 바꾸세요.',
          list: '문장에 나온 단어의 항목만 골라 문장 앞에 붙입니다. 큰 단어장이나 작은 모델에 유리합니다.',
          mixed: '뜻이 하나면 단어 뒤 괄호에, 뜻이 여럿이거나 메모가 있으면 앞에 목록으로 붙입니다. (실험)' } },
      { key: 'glossary_style', type: 'select', label: '단어를 바꾸는 모양', keywords: '괄호 치환', options: Object.entries(GLOSSARY_STYLES) },
    ] },
    { title: 'AI 프롬프트', note: 'AI 서버나 직접 설정한 서버(LLM)로 번역할 때 AI에게 주는 지시입니다. 구글 번역에는 쓰이지 않습니다.', rows: [
      { key: 'extra_prompt', type: 'textarea', rows: 3, label: '추가 지시', keywords: '말투 스타일 style',
        note: '아래 기본 프롬프트 끝에 덧붙습니다. 말투 같은 것을 여기에 적으면, 기본 프롬프트가 새로워져도 그대로 남습니다. 비워 두면 쓰지 않습니다. 모델이 잘 따르도록 영어로 쓰기를 권합니다. 번역이 이상해지면 비워 보세요.' },
      { type: 'examples', target: 'extra_prompt', label: '예시 (눌러서 위 칸에 넣기)', keywords: '예문 말투 해적 반말 존댓말',
        items: [['자연스럽게', DEFAULT_EXTRA_PROMPT], ['해적 말투로', 'Always write the translated dialogue in the style of a pirate.'],
          ['반말로 짧게', 'Use a casual, informal tone and keep sentences short.'], ['존댓말로', 'Always use polite, formal speech.']] },
      { key: 'prompt', type: 'textarea', rows: 18, label: '기본 프롬프트', keywords: '지시 system 프롬프트',
        note: '{target_lang}은 번역할 언어, {{Glossary.txt}}는 그 파일의 내용, {{extra_prompt}}는 위의 추가 지시로 바뀝니다. 잘 모르면 건드리지 마세요. "기본값"으로 되돌릴 수 있습니다.' },
      { type: 'notice', label: '', show: cfg => cfg.prompt_update_notice && (cfg.prompt || '').trim() !== DEFAULT_PROMPT.trim(),
        text: '지금 프롬프트는 프로그램에 들어 있는 최신 기본 프롬프트와 다릅니다. 기본 프롬프트는 계속 개선되고 있어서, 직접 고치신 게 아니라면 "기본값"으로 되돌려 최신 버전을 받는 것을 권장합니다.' },
      { key: 'prompt_update_notice', type: 'check', label: '프롬프트 알림', keywords: '알림 업데이트',
        note: '프롬프트가 최신 기본과 다르면 시작할 때 알려 줍니다. 직접 고친 프롬프트를 쓰면 꺼 두세요.' },
    ] },
  ],
  dot: cfg => cfg.prompt_update_notice && (cfg.prompt || '').trim() !== DEFAULT_PROMPT.trim(),     // a dot on the tab in the side menu
};
