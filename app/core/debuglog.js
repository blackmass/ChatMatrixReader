// The detailed log (Options > 기록 > 상세 기록): the areas of the program that can write down what they do in logs/debug.log, each one turned on by the user when a problem is looked for. All are off
// by default. The exe writes the lines (main.rs debug_log); the hub tells it which areas are on (hub.js). A new area: one entry here, and `debug_log("<key>", ...)` where the lines are wanted
// (Rust) - the option, the setting and the telling follow by themselves.
// key: a lower case word (digits and _ too); label / note: the text of the option.
export const AREAS = [
  { key: 'order', label: '창 순서', note: '번역창(센터), 블러 창, 웹창이 게임과 앞뒤로 어떻게 놓이는지 기록합니다. 다른 창을 눌렀을 때 창이 깜빡이거나 가려질 때 켜세요 (Windows).' },
  { key: 'blur', label: '블러 효과', note: '번역창 뒤의 블러를 켜고 끌 때의 호출과 그 결과를 기록합니다. 블러가 안 보이거나 깜빡일 때 켜세요.' },
  { key: 'focus', label: '창 포커스', note: '앞에 오는 창이 바뀔 때와, 마우스 왼쪽 버튼을 누르는 순간 커서 아래의 창과 키보드를 받는 창이 무엇인지 기록합니다. 다른 창 위에서 게임을 눌렀는데 게임에 포커스가 안 갈 때 켜세요.' },
  { key: 'web', label: '웹창', note: '웹창 페이지와 프로그램 사이의 연결, 확대·축소 요청을 기록합니다. 확대·축소가 가끔 안 될 때 켜세요.' },
];
export const defaults = () => Object.fromEntries(AREAS.map(a => [a.key, false]));
// what a file holds -> { key: true | false } for every area (anything else is dropped; an area that is not named is off)
export function normalize(value) {
  const out = defaults();
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const a of AREAS) out[a.key] = value[a.key] === true;
  return out;
}
// the keys of the areas that are on in these settings
export const enabled = cfg => { const d = normalize(cfg && cfg.debug_log); return AREAS.filter(a => d[a.key]).map(a => a.key); };
