// 미니 브라우저: the windows of the mini browser (a page of the web in a small window over the game), its bookmarks, how a web window is drawn, and the web windows the plugins open.
// The data: config `browser_windows` and `bookmarks` (core/browsers.js). Window 1 is the default window (always there); the picker above the cards chooses the window the rows show.
import { tr } from '../core/i18n.js';
import * as B from '../core/browsers.js';
import { nameFor } from '../winname.js';
import * as settings from '../settings.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const btn = (text, cls = '') => el('button', cls, text);

// the window the rows show: 'b<number>' = a browser window, 'w<number>' = a web window of a plugin (its entry in the list of windows); `page`: 'settings' or 'bookmarks'
let current = 'b' + B.DEFAULT_ID, page = 'settings';
const isBrowser = () => current[0] === 'b';
const curNum = () => Number(current.slice(1));
const list = cfg => cfg.browser_windows || [];
const cur = cfg => list(cfg).find(b => b.id === curNum()) || B.defaultBrowser(curNum());          // (a window the settings do not have, e.g. in the copy from when the options opened: how a new one is)
// a row of the chosen window: read from and written to its entry in `browser_windows`
const mine = (key, dflt, extra = {}) => ({
  key: 'browser_' + key, def: dflt, get: cfg => cur(cfg)[key], patch: (cfg, v) => ({ browser_windows: list(cfg).map(b => (b.id === cur(cfg).id ? { ...b, [key]: v } : b)) }), ...extra,
});
const hasWindow = () => true;
// a row of the chosen web window of a plugin: its entry in the list of windows
const webConf = cfg => (cfg.child_windows || []).find(c => c.id === curNum()) || {};
const webRow = (key, dflt, extra = {}, change = v => ({ [key]: v })) => ({
  key: 'webwin_' + key, def: dflt, get: cfg => webConf(cfg)[key] ?? dflt,
  patch: (cfg, v) => ({ child_windows: (cfg.child_windows || []).map(c => (c.id === curNum() ? { ...c, ...change(v) } : c)) }), ...extra,
});

// what applies to every web window: how it is drawn
const commonCard =
    { title: '모든 웹창 공통', rows: [
      { key: 'web_render', type: 'select', label: '그리기 방식', keywords: '미니 브라우저 웹창 gpu cpu 그래픽카드 프로세서 렌더링 끊김 버벅 주사율 하드웨어 가속',
        options: [['auto', '자동 (그래픽카드가 있으면 그래픽카드)'], ['cpu', '프로세서(CPU)'], ['gpu', '그래픽카드(GPU)']],
        note: '미니 브라우저(웹창)를 무엇으로 그릴지 정합니다. 모니터 주사율 설정에 따라 웹창이 떠 있는 동안 게임이 끊기는 컴퓨터가 있습니다. 그럴 때는 "프로세서"로 바꾸세요. 작은 모바일 창은 프로세서로 그려도 부담이 크지 않습니다. 이미 열려 있는 웹창은 닫았다 다시 열어야 바뀝니다. 플러그인이 여는 웹창에도 같이 적용됩니다.' },
    ] };

// the chosen browser window
const browserCard =
    { title: '브라우저 창', rows: [
      mine('name', '', { type: 'text', label: '이름', placeholder: '기본 이름', keywords: '브라우저 창 이름', show: hasWindow,
        note: '위의 목록과 번역창의 우클릭 메뉴에 이 이름이 보입니다. 비워 두면 기본 이름(첫 창은 모바일, 나머지는 브라우저 번호)을 씁니다.' }),
      mine('mode', 'mobile', { type: 'select', label: '화면', keywords: '모바일 pc 데스크톱 컴퓨터 화면 에이전트 user agent', show: hasWindow,
        options: [['mobile', '모바일 화면'], ['pc', 'PC 화면']],
        hints: { mobile: '폰의 화면으로 보여 줍니다. 작은 창에 맞습니다.', pc: '컴퓨터의 화면으로 보여 줍니다. 모바일 화면이 없는 사이트나 넓게 봐야 하는 영상에 맞고, 창을 크게 하세요.' } }),
      mine('start_kind', 'url', { type: 'select', label: '열 때 보이는 페이지', keywords: '시작 페이지 홈 처음 마지막 주소', show: hasWindow,
        options: [['url', '정한 주소'], ['last', '마지막에 본 주소']],
        hints: { url: '창을 열 때마다 아래에 적은 주소로 시작합니다.', last: '이 창에서 마지막으로 본 주소로 시작합니다. 아직 본 적이 없으면 아래 주소로 시작합니다.' } }),
      mine('start_url', B.START_URL, { type: 'text', label: '시작 주소', wide: true, placeholder: B.START_URL, keywords: '시작 페이지 홈 주소 url', show: hasWindow,
        validate: v => (v === '' || B.isWebUrl(v) ? '' : tr('http나 https로 시작하는 주소를 쓰세요')),
        patch: (cfg, v) => ({ browser_windows: list(cfg).map(b => (b.id === cur(cfg).id ? { ...b, start_url: v.trim() || B.START_URL } : b)) }),
        note: 'http나 https로 시작하는 주소입니다. 비우면 구글로 시작합니다.' }),
      mine('persist', false, { type: 'check', label: '로그인 유지', keywords: '쿠키 로그인 저장 세션 계정', show: hasWindow,
        note: ['켜면 이 창에서 로그인한 정보(쿠키)를 프로그램 폴더에 보관해서 다음에 열어도 로그인이 유지됩니다.', '끄면(기본) 창을 닫을 때마다 모두 잊습니다. 창마다 따로 보관됩니다.'] }),
      { type: 'button', label: '로그인 정보', button: '로그인 정보 지우기', keywords: '쿠키 로그인 지우기 삭제 세션 초기화',
        note: '이 창이 보관한 로그인 정보(쿠키)를 지웁니다. 창이 열려 있으면 그 창의 것을 지우고, 닫혀 있으면 보관 폴더를 지웁니다.',
        action: () => emit('browser-command', { cmd: 'clear', id: curNum() }) },
      { key: 'browser_topmost', type: 'check', label: '항상 맨 위에', keywords: '최상위 topmost 위에 표시', show: hasWindow, def: true,
        get: cfg => cur(cfg).topmost, patch: (cfg, v) => ({ browser_windows: list(cfg).map(b => (b.id === cur(cfg).id ? { ...b, topmost: v, topmost_wow_only: v ? false : b.topmost_wow_only } : b)) }) },
      { key: 'browser_topmost_wow_only', type: 'check', label: '와우 위에만', keywords: '게임 위 topmost 다른 창 뒤', show: hasWindow, def: false,
        note: '와우 바로 위에만 놓이고, 다른 프로그램 창이 와우를 덮으면 이 창도 같이 가려집니다. 켜면 "항상 맨 위에"는 꺼집니다.',
        get: cfg => cur(cfg).topmost_wow_only, patch: (cfg, v) => ({ browser_windows: list(cfg).map(b => (b.id === cur(cfg).id ? { ...b, topmost_wow_only: v, topmost: v ? false : b.topmost } : b)) }) },
      mine('idle_alpha', 1, { type: 'percent', min: 0.2, label: '마우스가 벗어나면 진하기', keywords: '투명도 불투명 흐리게 반투명 마우스 벗어나면 fade', show: hasWindow,
        note: '마우스가 창 위에 있을 때는 늘 선명하고, 벗어나면 잠시 뒤 이 진하기로 흐려집니다. 100%는 흐려지지 않습니다.' }),
      mine('lock_window', false, { type: 'check', label: '창 고정', keywords: '이동 크기 조절 잠금 드래그 고정 lock', show: hasWindow,
        note: '마우스로 창을 옮기거나 크기를 바꿀 수 없게 합니다.' }),
    ] };

// the chosen web window of a plugin: only what the program decides (the addresses it may go to are the plugin's: Options > Plugins)
const webCard =
    { title: '플러그인 웹창', rows: [
      webRow('open_mode', 'never', { type: 'select', label: '열리는 때', keywords: '열기 닫기 항상 플러그인 웹창',
        options: [['always', '프로그램을 켤 때 항상'], ['voice', '음성 인식을 켤 때만'], ['never', '닫아 둠 (직접 열 때만)']],
        hints: { always: '프로그램을 켤 때 열립니다.', voice: '음성인식을 켜면 열리고 끄면 닫힙니다.', never: '플러그인이 열 때만 열립니다.' } }),
      webRow('topmost', true, { type: 'check', label: '항상 맨 위에', keywords: '최상위 topmost 위에 표시' }, v => ({ topmost: v, ...(v ? { topmost_wow_only: false } : {}) })),
      webRow('topmost_wow_only', false, { type: 'check', label: '와우 위에만', keywords: '게임 위 topmost 다른 창 뒤',
        note: '와우 바로 위에만 놓이고, 다른 프로그램 창이 와우를 덮으면 이 창도 같이 가려집니다. 켜면 "항상 맨 위에"는 꺼집니다.' }, v => ({ topmost_wow_only: v, ...(v ? { topmost: false } : {}) })),
      webRow('lock_window', false, { type: 'check', label: '창 고정', keywords: '이동 크기 조절 잠금 드래그 고정 lock', note: '마우스로 창을 옮기거나 크기를 바꿀 수 없게 합니다.' }),
    ] };

// the bookmarks (the other page of this tab)
const bookmarkCard =
    { title: '즐겨찾기', rows: [
      { type: 'custom', block: true, label: '', keywords: '즐겨찾기 북마크 bookmark 주소 목록 추가 삭제', build: ctx => bookmarksPanel(ctx) },
    ] };

const tab = {
  id: 'browser', title: '미니 브라우저', subtitle: '공략이나 영상 같은 웹 페이지를 게임 위에 작은 창으로 띄워 봅니다',
  cards: [browserCard, webCard, commonCard, bookmarkCard],                  // (all of them: the search and the list of what was changed look at these)
  // what is shown now: the page chosen above, and for the page of the settings the kind of window that is chosen
  visibleCards: () => (page === 'bookmarks' ? [bookmarkCard] : [isBrowser() ? browserCard : webCard, commonCard]),

  // above the cards: the two pages of the tab, and (settings) the picker of the window. env = { cfg(), sel(), select(id) }
  toolbar(env) {
    const wrap = el('div', 'bt');
    const pages = el('div', 'subtabs'), pSettings = btn('미니 브라우저 설정'), pBook = btn('즐겨찾기 설정');
    pages.append(pSettings, pBook);
    const bar = el('div', 'wintool');
    const pick = el('select'), add = btn('새 창'), del = btn('삭제'), toggle = btn('열기'), note = el('span', 'winstate');
    bar.append(pick, note, toggle, add, del);
    try { const k = localStorage.getItem('cmr-browser-sel'); if (k) { localStorage.removeItem('cmr-browser-sel'); current = k; page = 'settings'; } } catch { /* none */ }      // ("이 창의 설정" in the menu of the bar of a window)
    let opened = new Set();
    let off = null;
    listen('web-state', ev => {
      if (!wrap.isConnected) { if (off) off(); return; }                      // (the page was drawn again: this picker is gone; it must not draw anything)
      if (ev.payload.source === 'browser') { opened = new Set((ev.payload.windows || []).map(w => w.win)); refresh(); }
    }).then(un => { off = un; if (!wrap.isConnected) un(); });
    emit('web-hello', {});
    wrap.append(pages, bar);
    let armed = false, known = new Set(list(env.cfg()).map(b => b.id));
    const request = patch => emit('cfg-patch', { patch });
    const rerender = () => env.select(env.sel());
    pSettings.onclick = () => { page = 'settings'; rerender(); };
    pBook.onclick = () => { page = 'bookmarks'; rerender(); };
    pick.onchange = () => { current = pick.value; armed = false; rerender(); };
    toggle.onclick = () => emit('browser-command', { cmd: opened.has(curNum()) ? 'close' : 'open', id: curNum() });
    add.onclick = () => {
      const l = list(env.cfg());
      if (!B.canAddBrowser(l)) return;
      request({ browser_windows: [...l, B.defaultBrowser(B.nextBrowserId(l))] });
    };
    del.onclick = () => {
      if (!armed) { armed = true; del.textContent = '정말 삭제?'; del.classList.add('on'); setTimeout(() => { armed = false; refresh(); }, 3000); return; }
      armed = false;
      const l = list(env.cfg()), id = curNum();
      current = 'b' + B.DEFAULT_ID; rerender();
      request({ browser_windows: l.filter(b => b.id !== id || id === B.DEFAULT_ID) });
    };
    function refresh() {
      const l = list(env.cfg()), webs = (env.cfg().child_windows || []).filter(c => c.kind === 'web');
      for (const b of l) if (!known.has(b.id)) { known.add(b.id); current = 'b' + b.id; page = 'settings'; rerender(); return; }       // a window was just made: show it
      if (isBrowser() ? !l.some(b => b.id === curNum()) : !webs.some(c => c.id === curNum())) current = 'b' + B.DEFAULT_ID;
      pSettings.classList.toggle('on', page === 'settings'); pBook.classList.toggle('on', page === 'bookmarks');
      bar.hidden = page !== 'settings';
      pick.textContent = '';
      for (const b of l) { const o = el('option', '', `${b.id} · ${B.browserName(l, b.id, tr)}`); o.value = 'b' + b.id; pick.append(o); }
      if (webs.length) {                                                          // (the web windows of the plugins: below ours, after a line, like the windows of the plugins in the tab 창)
        const line = el('option', '', '── ' + tr('플러그인 웹창') + ' ──'); line.disabled = true; pick.append(line);
        for (const c of webs) { const o = el('option', '', `${c.id} · ${nameFor(env.cfg(), c.id)}`); o.value = 'w' + c.id; pick.append(o); }
      }
      pick.value = current;
      add.disabled = !B.canAddBrowser(l);
      add.title = add.disabled ? tr('브라우저 창은 {n}개까지 만들 수 있습니다', { n: B.MAX_BROWSERS }) : '';
      note.textContent = isBrowser() ? (opened.has(curNum()) ? tr('열려 있음') : curNum() === B.DEFAULT_ID ? tr('기본 창 (삭제할 수 없음)') : '') : tr('플러그인이 엽니다');
      toggle.hidden = !isBrowser(); toggle.textContent = opened.has(curNum()) ? '닫기' : '열기';
      del.hidden = !isBrowser() || curNum() === B.DEFAULT_ID;
      if (!armed) { del.textContent = '삭제'; del.classList.remove('on'); }
    }
    return { el: wrap, refresh };
  },
};
export default tab;

// ---- the bookmarks: a list (name, address), moved up and down and taken away; one more is added at the bottom
function bookmarksPanel(ctx) {
  const root = el('div', 'bm');
  const fresh = () => ctx.cfg().bookmarks || [];                    // (what is in the settings now, not what was there when the line was drawn)
  const save = next => { ctx.set({ bookmarks: B.normalizeBookmarks(next) }); draw(); };
  const draw = () => {
    root.textContent = '';
    const items = fresh();
    if (!items.length) root.append(el('p', 'bm-empty', tr('즐겨찾기가 없습니다. 아래에서 추가하거나, 열린 미니 브라우저의 위쪽 막대를 우클릭해서 현재 페이지를 추가하세요.')));
    items.forEach((it, i) => {
      const line = el('div', 'bm-row'), name = el('input'), url = el('input'), up = btn('↑'), down = btn('↓'), rm = btn('✕');
      name.value = it.name; url.value = it.url; name.placeholder = tr('이름'); url.placeholder = 'https://';
      up.disabled = i === 0; down.disabled = i === items.length - 1; up.title = tr('위로'); down.title = tr('아래로'); rm.title = tr('삭제');
      name.onchange = () => save(fresh().map((x, j) => (j === i ? { ...x, name: name.value } : x)));
      url.onchange = () => { if (!B.isWebUrl(url.value.trim())) { url.classList.add('bad'); url.title = tr('http나 https로 시작하는 주소를 쓰세요'); return; } url.classList.remove('bad'); save(fresh().map((x, j) => (j === i ? { ...x, url: url.value.trim() } : x))); };
      const swap = d => { const n = [...fresh()]; [n[i], n[i + d]] = [n[i + d], n[i]]; save(n); };
      up.onclick = () => swap(-1); down.onclick = () => swap(1); rm.onclick = () => save(fresh().filter((_, j) => j !== i));
      line.append(name, url, up, down, rm); root.append(line);
    });
    const add = el('div', 'bm-row bm-add'), name = el('input'), url = el('input'), go = btn('추가');
    name.placeholder = tr('이름 (비우면 사이트 이름)'); url.placeholder = 'https://';
    go.onclick = () => {
      if (!B.isWebUrl(url.value.trim())) { url.classList.add('bad'); url.title = tr('http나 https로 시작하는 주소를 쓰세요'); return; }
      save([...fresh(), { name: name.value, url: url.value.trim() }]);
    };
    url.onkeydown = e => { if (e.key === 'Enter') go.onclick(); };
    add.append(name, url, go); root.append(add);
  };
  draw();
  settings.onChange(() => { if (root.isConnected && !root.contains(document.activeElement)) draw(); });          // (not while a box is being typed in)
  return root;
}
