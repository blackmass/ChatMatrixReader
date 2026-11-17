// 예외: what is NOT translated (and what is not even shown). More "leave this out" rules will come here.
import { tr } from '../core/i18n.js';
import { compileSkipRegex } from '../core/translate_rules.js';

export default {
  id: 'exceptions', title: '예외', subtitle: '번역하지 않을 글',
  cards: [
    { title: '번역 제외', rows: [
      { key: 'skip_same_lang', type: 'check', label: '같은 언어는 번역 안 함', keywords: '한국어 같은 언어 건너뛰기',
        note: '이미 목표 언어인 문장은 번역을 요청하지 않습니다. 글자의 종류로 판별합니다: 목표 언어가 한국어면 글자의 절반 이상이 한글, 일본어면 3할 이상이 가나, 중국어면 절반 이상이 한자, 러시아어면 절반 이상이 키릴 문자인 문장. 영어처럼 글자로는 구분이 안 되는 언어는 해당하지 않습니다 (아래 정규식과는 별개입니다). 끄면 한국어 문장도 번역 서버로 보내고, 서버가 같은 문장을 돌려줘도 번역줄로 보여 줍니다.' },
      { key: 'skip_regex', type: 'text', label: '제외 패턴 (정규식)', wide: true, placeholder: '비워 두면 사용 안 함', keywords: '정규식 regex 패턴 제외 필터',
        note: '이 패턴이 한 글자라도 일치하는 문장은 번역하지 않고 원문만 표시합니다. 예 (한글이 있는 문장 제외): [가-힣ㄱ-ㅎㅏ-ㅣ]  (목표 언어를 바꾸면 패턴도 직접 바꿔 주세요.)',
        validate: v => { try { compileSkipRegex(v); return ''; } catch (e) { return tr('정규식이 올바르지 않습니다: {e}', { e: e.message }); } } },
      { key: 'skip_regex_hide', type: 'check', label: '일치하면 숨김', keywords: '숨기기 표시 안 함',
        note: '창에 표시하지 않습니다.', show: cfg => !!(cfg.skip_regex || '').trim() },
    ] },
  ],
};
