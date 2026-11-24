// 단어장·프롬프트: the glossary (a text file, edited here) and what the AI is told. (The prompt for sending is in the 보내기 tab.)
import { notKorean, LANG_WARNING } from './tab_translation.js';
import { files } from '../fs.js';
import { GLOSSARY_STYLES, DEFAULT_NAME, SAMPLE_NAME } from '../core/glossary.js';
import { DEFAULT_PROMPT, DEFAULT_EXTRA_PROMPT } from '../core/prompts.js';
import { OWN_KEYS, glossaryInPrompt } from '../core/translate_rules.js';
import { aiMode } from '../core/upkeep.js';
import { tr } from '../core/i18n.js';

// What a translation method may have of its own (core/translate_rules.js withMethod): the pages of the buttons above the cards. `page`: 'base' = the settings every method shares.
let page = 'base';
const NAMES = { google: '구글', openai: 'AI 서버', custom: '직접 설정한 서버' };
const TITLES = { google: ['구글 · 단어장'], openai: ['AI 서버 · 단어장', 'AI 서버 · AI 프롬프트'], custom: ['직접 설정한 서버 · 단어장', '직접 설정한 서버 · AI 프롬프트'] };          // (whole texts: each one is translated as it is)
const ownOf = (cfg, m) => (cfg.by_method || {})[m] || null;
const valOf = (cfg, m, key) => { const o = ownOf(cfg, m); return o && Object.hasOwn(o, key) ? o[key] : cfg[key]; };
const copyOf = cfg => Object.fromEntries(OWN_KEYS.map(k => [k, cfg[k]]));                           // (what a method starts with when it stops following: the shared settings)
// Is the glossary that is set the one the prompt has? (the options say so when not: the translation works either way) -> null | { file, names }
// m = null: the shared settings (when an AI translates with them); else the settings of that method (only an AI has a prompt)
function mismatch(cfg, m) {
  if (m === null ? aiMode(cfg) === null : (!ownOf(cfg, m) || m === 'google' || (m === 'custom' && !(cfg.custom_body || '').includes('{system}')))) return null;
  const v = key => (m === null ? cfg[key] : valOf(cfg, m, key)), file = (String(v('glossary_file') || '').trim()) || DEFAULT_NAME;
  const r = glossaryInPrompt(v('prompt'), file, v('glossary_mode') || 'full', DEFAULT_NAME);
  return r ? { file, names: r.names } : null;
}
const fileNotice = m => ({ type: 'notice', label: '', show: cfg => !!mismatch(cfg, m), textOf: cfg => {
  const x = mismatch(cfg, m);
  return !x ? '' : x.names.length ? { text: "단어장 '{file}'이(가) 프롬프트에 들어 있지 않습니다. 프롬프트에는 '{names}'가 들어 있습니다. 같은 이름으로 맞춰 주세요. (번역은 지금 상태로도 됩니다.)", vars: { file: x.file, names: x.names.join(', ') } }
    : { text: "단어장 '{file}'이(가) 프롬프트에 들어 있지 않습니다. 프롬프트에 단어장 자리({{파일이름}})가 없습니다. (번역은 지금 상태로도 됩니다.)", vars: { file: x.file } };
} });
const promptNotice = m => ({ type: 'notice', label: '', show: cfg => !!mismatch(cfg, m), textOf: cfg => {
  const x = mismatch(cfg, m);
  return !x ? '' : x.names.length ? { text: "이 프롬프트에는 위에 적은 단어장 '{file}'이(가) 들어 있지 않습니다. 들어 있는 것: '{names}'.", vars: { file: x.file, names: x.names.join(', ') } }
    : { text: "이 프롬프트에는 단어장 자리({{파일이름}})가 없어서 단어장 '{file}'이(가) 쓰이지 않습니다.", vars: { file: x.file } };
} });
const DEFAULTS = { glossary_file: DEFAULT_NAME, glossary_google: true, glossary_mode: 'full', glossary_style: 'paren', extra_prompt: DEFAULT_EXTRA_PROMPT, prompt: DEFAULT_PROMPT };
// a row of one method: read from and written to its entry in `by_method` (shown only while the method has settings of its own)
const mrow = (m, key, spec) => ({
  key: `bm_${m}_${key}`, def: DEFAULTS[key], get: cfg => valOf(cfg, m, key), show: cfg => !!ownOf(cfg, m),
  patch: (cfg, v) => ({ by_method: { ...(cfg.by_method || {}), [m]: { ...(ownOf(cfg, m) || copyOf(cfg)), [key]: v } } }), ...spec,
});
const FOLLOW_NOTE = '켜 두면 이 방식은 "기본 방식"의 단어장과 프롬프트를 그대로 씁니다. 끄면 지금의 기본 방식 설정을 복사해서 이 방식만의 설정으로 쓰고, 그 뒤로는 기본 방식을 바꿔도 따라가지 않습니다. 같은 단어장 파일 이름을 그대로 두면 파일은 같이 씁니다.';
const GLOSSARY_NOTE = '프로그램 폴더 안의 파일 이름입니다. 파일이 없으면 만들어지고, 처음 내용은 샘플입니다. 기본 방식과 다른 이름을 쓰면 이 방식만의 단어장이 됩니다.';
const MODE_ROW = {
  type: 'select', label: '단어장 전달 방식', keywords: 'ai 전체 목록 혼합 토큰', options: [['full', '전체'], ['list', '선별'], ['mixed', '복합']],
  hints: { full: '단어장 전체를 프롬프트에 넣습니다. 단어장이 100줄을 넘으면 "선별" 또는 "복합"을 권합니다.', list: '문장에 나온 단어의 항목만 골라 문장 앞에 붙입니다.', mixed: '뜻이 하나면 단어 뒤 괄호에, 뜻이 여럿이거나 메모가 있으면 앞에 목록으로 붙입니다. (실험)' },
};
function methodCards(m) {
  const tag = NAMES[m], ai = m !== 'google', [t1, t2] = TITLES[m];
  const extraRow = mrow(m, 'extra_prompt', { type: 'textarea', rows: 3, label: '추가 지시', keywords: '말투 스타일 style', note: '아래 기본 프롬프트 끝에 덧붙습니다. 비워 두면 쓰지 않습니다.' });
  const cards = [{ title: t1, method: m, rows: [
    { key: `bm_${m}_follow`, type: 'check', label: '기본 방식의 설정을 따름', keywords: '단어장 프롬프트 따로 별도 ' + tag, def: true, note: FOLLOW_NOTE,
      get: cfg => !ownOf(cfg, m),
      patch: (cfg, v) => { const bm = { ...(cfg.by_method || {}) }; if (v) delete bm[m]; else bm[m] = copyOf(cfg); return { by_method: bm }; } },
    mrow(m, 'glossary_file', { type: 'text', label: '단어장 파일 이름', placeholder: DEFAULT_NAME, keywords: '파일 glossary 단어장 ' + tag, note: GLOSSARY_NOTE, flag: cfg => !!mismatch(cfg, m) }),
    ...(ai ? [fileNotice(m)] : []),
    { type: 'file', label: '내용', keywords: '단어 뜻 약어 편집', files, sample: SAMPLE_NAME, rows: 18, show: cfg => !!ownOf(cfg, m), path: cfg => String(valOf(cfg, m, 'glossary_file') || '').trim() || DEFAULT_NAME,
      note: '한 줄에 "단어=뜻". 저장하면 바로 반영됩니다.' },
    ...(m === 'openai' ? [] : [mrow(m, 'glossary_google', { type: 'check', label: m === 'google' ? '구글에도 단어장' : 'AI가 아닌 서버에도 단어장', keywords: '구글 일반 번역기',
      note: '문맥을 판단하지 못하는 번역기는 뜻이 하나뿐인 단어만 적용됩니다.' })]),
    ...(ai ? [mrow(m, 'glossary_mode', MODE_ROW)] : []),
    ...(m === 'openai' ? [] : [mrow(m, 'glossary_style', { type: 'select', label: '단어를 바꾸는 모양', keywords: '괄호 치환', options: Object.entries(GLOSSARY_STYLES) })]),
  ] }];
  if (ai) cards.push({ title: t2, method: m, rows: [
    extraRow,
    { type: 'examples', label: '예시 (눌러서 위 칸에 넣기)', keywords: '예문 말투 해적 반말 존댓말', show: cfg => !!ownOf(cfg, m), pick: (ctx, text) => ctx.put(extraRow, text),
      items: [['자연스럽게', DEFAULT_EXTRA_PROMPT], ['해적 말투로', 'Always write the translated dialogue in the style of a pirate.'],
        ['반말로 짧게', 'Use a casual, informal tone and keep sentences short.'], ['존댓말로', 'Always use polite, formal speech.']] },
    promptNotice(m),
    mrow(m, 'prompt', { type: 'textarea', rows: 18, label: '기본 프롬프트', keywords: '지시 system 프롬프트', flag: cfg => !!mismatch(cfg, m),
      note: '{target_lang}은 번역할 언어, {{파일이름}}은 그 파일의 내용, {{extra_prompt}}는 위의 추가 지시로 바뀝니다. 이 방식의 단어장을 쓰려면 프롬프트 안의 파일 이름도 같은 이름으로 바꾸세요. "기본값"으로 되돌릴 수 있습니다.' }),
  ] });
  return cards;
}
const METHODS = ['google', 'openai', 'custom'];
const methodAll = METHODS.flatMap(methodCards);
const methodOf = p => methodAll.filter(c => c.method === p);

const baseCards = [
    { title: '단어장', note: '여기는 모든 번역 방식이 같이 쓰는 "기본 방식"입니다. 구글, AI 서버, 직접 설정한 서버에 따로 쓰려면 위의 버튼에서 고르세요.', rows: [
      { type: 'notice', label: '', show: notKorean, text: LANG_WARNING },
      { key: 'glossary_file', type: 'text', label: '단어장 파일 이름', placeholder: DEFAULT_NAME, keywords: '파일 glossary', flag: cfg => !!mismatch(cfg, null), note: '프로그램 폴더 안의 파일 이름입니다. 파일이 없으면 저장할 때 만들어집니다.' },
      fileNotice(null),
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
      promptNotice(null),
      { key: 'prompt', type: 'textarea', rows: 18, label: '기본 프롬프트', keywords: '지시 system 프롬프트', flag: cfg => !!mismatch(cfg, null),
        note: '{target_lang}은 번역할 언어, {{Glossary.txt}}는 그 파일의 내용, {{extra_prompt}}는 위의 추가 지시로 바뀝니다. 잘 모르면 건드리지 마세요. "기본값"으로 되돌릴 수 있습니다.' },
      { type: 'notice', label: '', show: cfg => cfg.prompt_update_notice && (cfg.prompt || '').trim() !== DEFAULT_PROMPT.trim(),
        text: '지금 프롬프트는 프로그램에 들어 있는 최신 기본 프롬프트와 다릅니다. 기본 프롬프트는 계속 개선되고 있어서, 직접 고치신 게 아니라면 "기본값"으로 되돌려 최신 버전을 받는 것을 권장합니다.' },
      { key: 'prompt_update_notice', type: 'check', label: '프롬프트 알림', keywords: '알림 업데이트',
        note: '프롬프트가 최신 기본과 다르면 시작할 때 알려 줍니다. 직접 고친 프롬프트를 쓰면 꺼 두세요.' },
    ] },
];

export default {
  id: 'glossary', title: '단어장·프롬프트', test: true, subtitle: '단어장과 AI에게 주는 지시',
  cards: [...baseCards, ...methodAll],                           // (all of them: the search and the list of what was changed look at these)
  visibleCards: () => (page === 'base' ? baseCards : methodOf(page)),
  testMethod: () => (page === 'base' ? 'shared' : page),                       // (the test box translates with the page that is open: options.js, hub.js rpc-test)
  // above the cards: the page of each method. A method with settings of its own has a dot.
  toolbar(env) {
    const wrap = document.createElement('div'); wrap.className = 'subtabs';
    const buttons = [['base', '기본 방식'], ...METHODS.map(m => [m, NAMES[m]])].map(([id, name]) => {
      const b = document.createElement('button'); b.textContent = tr(name);
      b.onclick = () => { page = id; env.select(env.sel()); };
      wrap.append(b); return [id, name, b];
    });
    const refresh = () => { for (const [id, name, b] of buttons) { b.classList.toggle('on', page === id); const own = id !== 'base' && ownOf(env.cfg(), id); b.textContent = tr(name) + (own ? ' ●' : ''); b.title = own ? tr('이 방식만의 설정을 씁니다') : ''; } };
    refresh();
    return { el: wrap, refresh };
  },
  dot: cfg => cfg.prompt_update_notice && (cfg.prompt || '').trim() !== DEFAULT_PROMPT.trim(),     // a dot on the tab in the side menu
};
