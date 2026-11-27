// The detailed log (Options > 기록 > 상세 기록): the areas of the program that can write down what they do in logs/debug.log, each one turned on by the user when a problem is looked for. All are off
// by default. The exe writes the lines (main.rs debug_log); the hub tells it which areas are on (hub.js). A new area: one entry here, and `debug_log("<key>", ...)` where the lines are wanted
// (Rust) - the option, the setting and the telling follow by themselves.
// key: a lower case word (digits and _ too); label / note: the text of the option.
export const AREAS = [
  { key: 'order', label: '창 순서', note: '번역창(센터), 블러 창, 웹창이 게임과 앞뒤로 어떻게 놓이는지 기록합니다. 다른 창을 눌렀을 때 창이 깜빡이거나 가려질 때 켜세요 (Windows).' },
  { key: 'blur', label: '블러 효과', note: '번역창 뒤의 블러를 켜고 끌 때의 호출과 그 결과를 기록합니다. 블러가 안 보이거나 깜빡일 때 켜세요.' },
  { key: 'focus', label: '창 포커스', note: '앞에 오는 창이 바뀔 때와, 마우스 왼쪽 버튼을 누르는 순간 커서 아래의 창과 키보드를 받는 창이 무엇인지 기록합니다. 다른 창 위에서 게임을 눌렀는데 게임에 포커스가 안 갈 때 켜세요.' },
  { key: 'mouse', label: '마우스 버튼', note: '웹창에서 마우스 옆 버튼(뒤로·앞으로)을 누른 것, 입력칸을 클릭해 창이 활성화되는 것(Windows), 클릭 관통 창 위의 휠을 누가 받았는지(다른 프로그램의 창이 가렸는지, 영역이 있는지)를 기록합니다. 뒤로 갈 때 게임 조작이 끊기거나 입력칸 클릭 뒤 글자가 안 들어가거나 관통 중 휠이 안 먹거나 다른 프로그램의 휠이 안 먹으면 켜세요.' },
  { key: 'input', label: '보내기 입력줄', note: '보내기 입력줄(보내기 상자)을 열 때 어디에 어떻게 뜨는지와 키보드를 받았는지를 기록합니다. 입력줄이 안 뜨거나 키보드를 못 받을 때 켜세요.' },
  { key: 'main', label: '메인 스레드 지연', note: '창과 트레이 아이콘, 메뉴를 돌리는 메인 스레드가 0.5초마다 응답하는지 재서, 0.1초 이상 늦으면 그 시간을 기록합니다. 트레이 아이콘에서 빙글빙글 도는 커서가 나오거나 메뉴가 늦게 열릴 때 켜고, 마우스가 아이콘에 오고 가는 것과 클릭도 함께 기록합니다.' },
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
