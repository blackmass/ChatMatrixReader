// 플러그인: the plugins of the plugins/ folder. A list on the left (a switch for each), the chosen one on the right: who made it, its fingerprint, the permissions it asks for (the user
// allows each one), its options (declared in its plugin.json) and its log. The state comes from the hub (app/plugin_host.js: event 'plugin-state'); what the user does goes back as
// 'plugin-command'. A plugin nobody has decided about yet is shown in a window of its own first (askApprovals), one plugin after the other.
import { tr } from '../core/i18n.js';
import { isMac } from '../platform.js';

const { emit, listen } = window.__TAURI__.event;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const SEL_KEY = 'cmr-plugin-sel';
const invoke = window.__TAURI__.core.invoke;
const BASE = isMac ? 'cmrplug://localhost/' : 'http://cmrplug.localhost/';

let state = [];                                        // the list the hub told
const redraws = new Set();                             // the panels that are drawn now (they draw again when the state changes)
const waiting = new Map();                             // 'cmd|id' -> resolve
let answering = false;                                 // an answer of the approval window is on its way
const decided = new Set();                             // answered, but the hub's state does not say so yet
const queue = { done: 0, total: 0 };                   // the plugins asked about in this round ("2 / 3"): how many are answered, how many there were

listen('plugin-state', ev => {
  state = ev.payload.plugins || [];
  for (const id of [...decided]) if (!state.some(x => x.id === id && x.review)) decided.delete(id);
  if (modal && modal.review && !state.some(x => x.id === modal.id && x.review && x.ok)) closeModal();          // (decided elsewhere, or the plugin is gone)
  for (const f of redraws) f();
  askApprovals();
});
listen('plugin-result', ev => { const k = ev.payload.cmd + '|' + ev.payload.id, r = waiting.get(k); if (r) { waiting.delete(k); r(ev.payload); } });
// the answers of the hub to the calls of the options pages of the plugins (frames in this window): to the frame that asked
const uiFrames = new Map();                            // plugin id -> { frame, post(msg) }
listen('plugin-ui-reply', ev => { const { id, from, seq, ok, value, error } = ev.payload; const u = from === 'opt:' + id ? uiFrames.get(id) : null; if (u) u.post(ok ? { cmr: 1, id: seq, ok: true, value } : { cmr: 1, id: seq, ok: false, error }); });
emit('plugin-hello', {});

// a command to the hub; resolves with its answer (or { error } when none comes)
const ask = (cmd, id, extra = {}) => new Promise(resolve => {
  const k = cmd + '|' + id;
  waiting.set(k, resolve);
  emit('plugin-command', { cmd, id, ...extra });
  setTimeout(() => { if (waiting.get(k) === resolve) { waiting.delete(k); resolve({ error: tr('답이 없습니다') }); } }, 8000);
});

const PERMS = {
  net: () => tr('인터넷 접속'),
  'chat.inject': () => tr('채팅창에 글 넣기'),
  storage: () => tr('자기 저장 공간 쓰기'),
  widgets: () => tr('창에 위젯 올리기'),
  windows: () => tr('플러그인 전용 창 열기'),
  netAny: () => tr('원하는 사이트에 접속 (사이트는 하나씩 허용)'),
  openUrl: () => tr('기본 브라우저로 주소 열기'),
  web: () => tr('웹 페이지를 플러그인 창으로 보기'),
};
const SCOPES = () => [['host', tr('허용한 사이트 안에서만 이동')], ['domain', tr('허용한 사이트의 도메인 전체 (하위 사이트 포함)')]];
const pendingList = () => state.filter(x => x.review && x.ok && !decided.has(x.id)).sort((a, b) => a.id.localeCompare(b.id));
const nameOf = p => (p.manifest && p.manifest.name) || p.id;

// what the plugin asks for: [{ key, label, reason, hosts? }]
const asks = p => {
  const m = p.manifest;
  if (!m) return [];
  const out = [];
  if (m.permissions.netAny) out.push({ key: 'netAny', label: PERMS.netAny(), reason: m.reasons.netAny });
  if (m.permissions.net.length) out.push({ key: 'net', label: PERMS.net(), reason: m.reasons.net, hosts: m.permissions.net });
  if (m.permissions['chat.inject']) out.push({ key: 'chat.inject', label: PERMS['chat.inject'](), reason: m.reasons['chat.inject'] });
  if (m.permissions.storage) out.push({ key: 'storage', label: PERMS.storage(), reason: m.reasons.storage });
  if (m.permissions.widgets) out.push({ key: 'widgets', label: PERMS.widgets(), reason: m.reasons.widgets });
  if (m.permissions.windows) out.push({ key: 'windows', label: PERMS.windows(), reason: m.reasons.windows });
  if (m.permissions.openUrl) out.push({ key: 'openUrl', label: PERMS.openUrl(), reason: m.reasons.openUrl });
  if (m.permissions.web) out.push({ key: 'web', label: PERMS.web(), reason: m.reasons.web, scope: m.permissions.web });
  return out;
};

// ---------------------------------------------------------------- the boxes of the permissions (in the window that asks and on the right of the tab)
// -> { root, granted() }: the checkboxes; `start`: what is checked at first ({ net: [...], 'chat.inject': bool, storage: bool })
function permBoxes(p, start, onChange) {
  const root = el('div', 'pl-perms');
  const boxes = [];
  let scopeSel = null;
  for (const a of asks(p)) {
    const block = el('div', 'pl-perm');
    const head = el('div', 'pl-perm-head');
    if (a.key === 'net') head.append(el('b', '', a.label));
    else {
      const lab = el('label'), box = el('input'); box.type = 'checkbox'; box.checked = !!start[a.key]; box.dataset.key = a.key; box.onchange = () => onChange && onChange();
      lab.append(box, el('b', '', ' ' + a.label)); head.append(lab); boxes.push(box);
    }
    block.append(head);
    if (a.reason) block.append(el('small', 'note', a.reason));
    if (a.scope) {                                     // (web: how far the window may go; the plugin asks for 'host' or 'domain', the user may take 'domain' down to 'host')
      const sel = el('select'); sel.dataset.webScope = '1';
      for (const [v, t] of SCOPES()) if (a.scope === 'domain' || v === 'host') sel.append(Object.assign(el('option', '', t), { value: v }));
      sel.value = start.web === 'host' ? 'host' : a.scope === 'domain' ? 'domain' : 'host';
      sel.onchange = () => onChange && onChange();
      block.append(sel); scopeSel = sel;
    }
    if (a.hosts) for (const h of a.hosts) {
      const lab = el('label', 'pl-host'), box = el('input'); box.type = 'checkbox'; box.checked = (start.net || []).includes(h); box.dataset.host = h; box.onchange = () => onChange && onChange();
      lab.append(box, el('code', '', ' ' + h)); block.append(lab); boxes.push(box);
    }
    root.append(block);
  }
  if (!asks(p).length) root.append(el('small', 'note', tr('이 플러그인은 특별한 권한을 요구하지 않습니다.')));
  return { root, granted: () => ({ net: boxes.filter(b => b.dataset.host && b.checked).map(b => b.dataset.host), 'chat.inject': !!boxes.find(b => b.dataset.key === 'chat.inject' && b.checked), storage: !!boxes.find(b => b.dataset.key === 'storage' && b.checked), netAny: !!boxes.find(b => b.dataset.key === 'netAny' && b.checked), openUrl: !!boxes.find(b => b.dataset.key === 'openUrl' && b.checked), widgets: !!boxes.find(b => b.dataset.key === 'widgets' && b.checked), windows: !!boxes.find(b => b.dataset.key === 'windows' && b.checked), web: boxes.find(b => b.dataset.key === 'web' && b.checked) && scopeSel ? scopeSel.value : '' }) };
}

// ---------------------------------------------------------------- the window that asks (a plugin nobody decided about yet)
let modal = null;                                      // { id, root } of the one shown
function closeModal() { if (modal) { modal.root.remove(); modal = null; } }

// opts.review: the first meeting with the plugin (the "not now" answer is remembered); else it is the user turning on a plugin that has permissions not allowed yet
function showApproval(p, opts = {}) {
  closeModal();
  const root = el('div', 'pl-modal'), card = el('div', 'pl-card');
  queue.total = Math.max(queue.total, queue.done + pendingList().length);
  const total = queue.total, idx = queue.done;
  card.append(el('h3', '', opts.review ? tr('새 플러그인: {name}', { name: nameOf(p) }) : tr('플러그인 켜기: {name}', { name: nameOf(p) })));
  if (opts.review && total > 1) card.append(el('small', 'note', tr('{n} / {total}번째 플러그인', { n: idx + 1, total })));
  const m = p.manifest;
  card.append(el('small', 'note', [m.author ? tr('만든 이: {a}', { a: m.author }) : '', tr('버전 {v}', { v: m.version })].filter(Boolean).join(' · ')));
  if (m.description) card.append(el('p', 'pl-desc', m.description));
  card.append(el('p', 'pl-ask', tr('이 플러그인이 요구하는 권한입니다. 허용할 것을 고르세요:')));
  const start = { net: m.permissions.net, 'chat.inject': m.permissions['chat.inject'], storage: m.permissions.storage, widgets: m.permissions.widgets, windows: m.permissions.windows, netAny: m.permissions.netAny, openUrl: m.permissions.openUrl, web: m.permissions.web };      // (everything it asks is checked at first, the user may take some away)
  const boxes = permBoxes(p, start);
  card.append(boxes.root);
  card.append(el('small', 'note pl-warn', tr('플러그인은 격리된 곳에서 실행되고 허용한 권한만 쓸 수 있습니다. 믿을 수 있는 곳에서 받은 플러그인인지 확인하세요. 권한은 나중에 이 탭에서 바꿀 수 있습니다.')));
  const row = el('div', 'pl-buttons');
  const yes = el('button', 'btn', tr('허용하고 켜기')), no = el('button', 'btn', opts.review ? tr('켜지 않음') : tr('취소'));
  yes.onclick = async () => {
    answering = true; closeModal();
    if (opts.review) { queue.done++; decided.add(p.id); await ask('review', p.id, { granted: boxes.granted(), enable: true }); }
    else { await ask('grant', p.id, { granted: boxes.granted() }); await ask('enable', p.id); }
    answering = false; askApprovals();
  };
  no.onclick = async () => {
    answering = true; closeModal();
    if (opts.review) { queue.done++; decided.add(p.id); await ask('review', p.id, { granted: {}, enable: false }); }
    answering = false; askApprovals();
  };
  row.append(yes, no);
  card.append(row);
  root.append(card);
  document.body.append(root);
  modal = { id: p.id, root, review: !!opts.review };
  yes.focus();
}

// plugins nobody decided about yet are shown one after the other (the options window has been opened for them by the hub)
function askApprovals() {
  if (answering || modal) return;
  const next = pendingList()[0];
  if (!next) { queue.done = 0; queue.total = 0; return; }
  document.dispatchEvent(new CustomEvent('cmr-show-tab', { detail: 'plugins' }));
  showApproval(next, { review: true });
}

// ---------------------------------------------------------------- the tab
function panel() {
  const root = el('div', 'wm'), listBox = el('div', 'wl'), detail = el('div', 'wd pl-detail'), top = el('div', 'pl-top'), ui = el('div', 'pl-ui');
  detail.append(top, ui);
  root.append(listBox, detail);
  let uiFor = '', uiOptions = '';                                  // the plugin whose options page is in `ui`, and the options it was last told
  let sel = ''; try { sel = localStorage.getItem(SEL_KEY) || ''; } catch { /* the first one */ }
  let hashInfo = { id: '', hash: '', files: [], open: false }, logText = { id: '', text: '' };

  const choose = id => { sel = id; try { localStorage.setItem(SEL_KEY, id); } catch { /* not kept */ } hashInfo = { id: '', hash: '', files: [], open: false }; draw(); };

  const turn = async (p, on) => {
    if (on && p.missing.length) { showApproval(p, { review: false }); return; }
    await ask(on ? 'enable' : 'disable', p.id);
  };

  function drawList() {
    listBox.textContent = '';
    const bar = el('div', 'pl-listbar');
    const scan = el('button', 'btn', tr('목록 새로 읽기')); scan.onclick = () => ask('rescan', '');
    bar.append(scan);
    listBox.append(bar);
    if (!state.length) listBox.append(el('small', 'note pl-empty', tr('plugins 폴더에 플러그인이 없습니다. 플러그인을 폴더째 넣고 "목록 새로 읽기"를 누르세요.')));
    for (const p of state) {
      const row = el('div', 'wl-item' + (p.ok ? '' : ' orphan') + (p.id === sel ? ' sel' : '')); row.tabIndex = 0; row.dataset.id = p.id;
      const sw = el('label', 'switch small'), box = el('input'); box.type = 'checkbox'; box.checked = p.enabled && p.ok; box.disabled = !p.ok;
      sw.onclick = e => e.stopPropagation();
      box.onchange = () => { box.checked = p.enabled && p.ok; turn(p, !(p.enabled && p.ok)); };        // (the switch shows what IS: the answer of the hub moves it)
      sw.append(box, el('span', 'knob'));
      const tags = el('span', 'wl-tags');
      if (!p.ok) tags.append(el('small', 'wl-badge off', tr('오류')));
      else if (p.running) tags.append(el('small', 'wl-badge', tr('실행 중')));
      else if (p.missing.length && p.enabled) tags.append(el('small', 'wl-badge off', tr('권한 필요')));
      row.append(sw, el('span', 'wl-name', nameOf(p)), tags);
      row.onclick = () => choose(p.id);
      row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(p.id); } };
      listBox.append(row);
    }
  }

  // The options page of a plugin (plugin.json "optionsPage"): a sandboxed frame at the address of the plugin, below the rest. It stays where it is while the rest is drawn again
  // (a frame that is moved or made again would start over); it is made again only for another plugin.
  async function syncUi(p) {
    const page = p && p.ok && p.manifest.optionsPage;
    const want = page ? p.id : '';
    if (want !== uiFor) {
      const old = uiFor && uiFrames.get(uiFor);
      if (old) { old.stop(); uiFrames.delete(uiFor); }
      ui.textContent = ''; uiFor = want; uiOptions = '';
      if (!want) return;
      const token = await invoke('plugin_token', { id: p.id }).catch(() => '');
      if (uiFor !== want || !token) return;
      ui.append(el('hr', 'pl-line'), el('h4', 'pl-h', tr('플러그인 설정')));
      const frame = el('iframe', 'pl-frame');
      frame.setAttribute('sandbox', 'allow-scripts');                // (no same-origin: the page has no way to this window or to the exe)
      frame.dataset.plugin = p.id; frame.style.height = '120px';
      const post = msg => { try { frame.contentWindow.postMessage(msg, '*'); } catch { /* gone */ } };
      const onMessage = e => {
        if (e.source !== frame.contentWindow) return;
        const m = e.data;
        if (!m || m.cmr !== 1) return;
        if (m.event === 'hello') { const cur = state.find(x => x.id === want); if (cur) { uiOptions = JSON.stringify(cur.options); post({ cmr: 1, event: 'options', value: cur.options }); } return; }
        if (m.event === 'height') { const h = Math.max(40, Math.min(1500, Number(m.value) || 0)); frame.style.height = h + 'px'; return; }
        if (typeof m.id === 'number' && typeof m.method === 'string') emit('plugin-ui', { id: want, from: 'opt:' + want, seq: m.id, method: m.method, args: m.args });
      };
      window.addEventListener('message', onMessage);
      uiFrames.set(want, { frame, post, stop: () => { window.removeEventListener('message', onMessage); frame.remove(); } });
      frame.src = BASE + token + '/' + p.manifest.optionsPage;
      ui.append(frame);
    } else if (want) {                                               // the same plugin: only what changed is told
      const cur = JSON.stringify(p.options), u = uiFrames.get(want);
      if (u && cur !== uiOptions) { uiOptions = cur; u.post({ cmr: 1, event: 'options', value: p.options }); }
    }
  }

  function drawDetail() {
    const detail = top;
    detail.textContent = '';
    const p = state.find(x => x.id === sel) || state[0];
    syncUi(p);
    if (!p) { detail.append(el('small', 'note', tr('왼쪽에서 플러그인을 고르세요.'))); return; }
    sel = p.id;
    const head = el('div', 'pl-head');
    const title = el('div', 'pl-title');
    title.append(el('b', '', nameOf(p)));
    if (p.manifest) title.append(el('small', 'note', [p.manifest.author, 'v' + p.manifest.version].filter(Boolean).join(' · ')));
    head.append(title);
    // the fingerprint (the SHA-256 of all the files): on the right; a click shows the files
    const fp = el('button', 'pl-fp', tr('지문 확인'));
    fp.title = tr('플러그인 폴더의 모든 파일의 SHA-256입니다. 배포하는 쪽이 알려 준 값과 비교해 보세요.');
    fp.onclick = async () => {
      if (hashInfo.id === p.id && hashInfo.hash) { hashInfo.open = !hashInfo.open; drawDetail(); return; }
      const r = await ask('hash', p.id);
      hashInfo = { id: p.id, hash: r.error ? '' : r.hash, files: r.files || [], open: true, error: r.error || '' };
      drawDetail();
    };
    if (hashInfo.id === p.id && hashInfo.hash) { fp.textContent = hashInfo.hash.slice(0, 16) + '…'; fp.classList.add('known'); }
    head.append(fp);
    detail.append(head);
    if (hashInfo.id === p.id && hashInfo.open) {
      const box = el('div', 'pl-files');
      if (hashInfo.error) box.append(el('small', 'err', hashInfo.error));
      else {
        box.append(el('code', 'pl-hash', hashInfo.hash));
        for (const f of hashInfo.files) box.append(el('div', 'pl-file', `${f.sha256.slice(0, 12)}  ${f.path}  (${f.size} B)`));
      }
      detail.append(box);
    }
    if (p.manifest && p.manifest.description) detail.append(el('p', 'pl-desc', p.manifest.description));
    for (const e of p.errors) detail.append(el('small', 'err', '✖ ' + e));
    for (const w of p.warnings) detail.append(el('small', 'note pl-warning', '⚠ ' + w));
    if (!p.ok) return;
    if (p.lastError) detail.append(el('small', 'err', '✖ ' + p.lastError));

    // on / off
    const run = el('div', 'pl-run');
    const sw = el('label', 'switch'), box = el('input'); box.type = 'checkbox'; box.checked = p.enabled;
    box.onchange = () => { box.checked = p.enabled; turn(p, !p.enabled); };
    sw.append(box, el('span', 'knob'));
    run.append(sw, el('span', '', p.running ? tr('실행 중') : p.enabled ? tr('켜져 있지만 실행하지 않음') : tr('꺼져 있음')));
    detail.append(run);

    // permissions
    detail.append(el('h4', 'pl-h', tr('권한')));
    const start = { net: p.granted.net || [], 'chat.inject': !!p.granted['chat.inject'], storage: !!p.granted.storage, widgets: !!p.granted.widgets, windows: !!p.granted.windows, netAny: !!p.granted.netAny, openUrl: !!p.granted.openUrl, web: p.granted.web || '' };
    const boxes = permBoxes(p, start, () => ask('grant', p.id, { granted: boxes.granted() }));
    detail.append(boxes.root);
    // netAny: the hosts the user allows one by one, and the ones the plugin has asked for and wait for an answer
    if (p.manifest.permissions.netAny && p.granted.netAny) {
      detail.append(el('h4', 'pl-h', tr('허용한 사이트')));
      const mine = (p.granted.net || []).filter(h => !p.manifest.permissions.net.includes(h));
      const box = el('div', 'pl-hosts');
      if (!mine.length) box.append(el('small', 'note', tr('아직 허용한 사이트가 없습니다.')));
      for (const h of mine) {
        const row = el('div', 'pl-hostrow'), rm = el('button', 'btn', tr('제거'));
        rm.onclick = () => ask('removeHost', p.id, { host: h });
        row.append(el('code', '', h), rm); box.append(row);
      }
      detail.append(box);
      for (const h of p.requested || []) {
        const row = el('div', 'pl-hostrow pl-request');
        const yes = el('button', 'btn', tr('허용')), no = el('button', 'btn', tr('거부'));
        yes.onclick = () => ask('grantHost', p.id, { host: h }); no.onclick = () => ask('denyHost', p.id, { host: h });
        row.append(el('span', '', tr('플러그인이 접속을 요청했습니다:') + ' '), el('code', '', h), yes, no); detail.append(row);
      }
      const add = el('div', 'pl-hostadd'), inp = el('input'), addBtn = el('button', 'btn', tr('직접 추가'));
      inp.type = 'text'; inp.placeholder = 'example.com'; inp.dataset.hostAdd = '1';
      addBtn.onclick = async () => { const r = await ask('grantHost', p.id, { host: inp.value.trim() }); if (r.error) { inp.classList.add('bad'); inp.title = r.error; } else inp.value = ''; };
      add.append(inp, addBtn); detail.append(add);
    }
    // the web window: what the user chose for it (kept per plugin)
    if (p.manifest.permissions.web && p.granted.web) {
      detail.append(el('h4', 'pl-h', tr('웹 창')));
      detail.append(el('small', 'note', tr('항상 위, 클릭 통과 같은 창 설정은 옵션 > 창 에서 이 플러그인의 웹 창을 골라 정합니다.')));
      const rows = [['cookies', tr('로그인 정보(쿠키) 유지 — 켜면 이 플러그인 전용으로 저장됩니다')]];
      for (const [k, t] of rows) {
        const lab = el('label', 'pl-webopt'), cb = el('input'); cb.type = 'checkbox'; cb.checked = !!(p.web && p.web[k]); cb.dataset.web = k;
        cb.onchange = () => ask('web', p.id, { key: k, value: cb.checked });
        lab.append(cb, el('span', '', ' ' + t)); detail.append(lab);
      }
      const clr = el('button', 'btn', tr('저장된 로그인 정보 지우기')); clr.disabled = !p.webOpen; clr.title = p.webOpen ? '' : tr('웹 창이 열려 있을 때 지울 수 있습니다');
      clr.onclick = async () => { const r = await ask('webClear', p.id, {}); clr.textContent = r && r.error ? tr('지우지 못했습니다') : tr('지웠습니다'); };
      detail.append(clr);
    }
    if (p.missing.length) detail.append(el('small', 'note pl-missing', tr('요구하는 권한 중 허용하지 않은 것이 있습니다. 허용하지 않은 것은 쓸 수 없습니다.')));

    // options (declared in plugin.json)
    const opts = p.manifest.options;
    if (opts.length) {
      detail.append(el('hr', 'pl-line'), el('h4', 'pl-h', tr('옵션')));
      for (const d of opts) {
        const row = el('div', 'pl-opt'), lab = el('label', '', d.label);
        let input;
        if (d.type === 'check') { input = el('input'); input.type = 'checkbox'; input.checked = !!p.options[d.key]; input.onchange = () => ask('option', p.id, { key: d.key, value: input.checked }); lab.prepend(input, document.createTextNode(' ')); row.append(lab); }
        else {
          row.append(lab);
          if (d.type === 'select') { input = el('select'); for (const c of d.choices) { const o = el('option', '', c.label); o.value = c.value; input.append(o); } input.value = p.options[d.key]; input.onchange = () => ask('option', p.id, { key: d.key, value: input.value }); }
          else { input = el('input'); input.type = d.type === 'number' ? 'number' : 'text'; input.value = p.options[d.key] ?? ''; if (d.min !== undefined) input.min = d.min; if (d.max !== undefined) input.max = d.max;
            input.onchange = () => ask('option', p.id, { key: d.key, value: d.type === 'number' ? Number(input.value) : input.value }); }
          row.append(input);
        }
        if (d.note) row.append(el('small', 'note', d.note));
        detail.append(row);
      }
    }

    // the log
    detail.append(el('hr', 'pl-line'));
    const logHead = el('div', 'pl-loghead'), logBtn = el('button', 'btn', tr('로그 보기'));
    const view = el('textarea', 'licview'); view.readOnly = true; view.rows = 8; view.spellcheck = false; view.hidden = logText.id !== p.id;
    if (logText.id === p.id) view.value = logText.text;
    logBtn.onclick = async () => { const r = await ask('logs', p.id); logText = { id: p.id, text: (r.lines || []).join('\n') || tr('(로그가 없습니다)') }; view.hidden = false; view.value = logText.text; view.scrollTop = view.scrollHeight; };
    logHead.append(el('h4', 'pl-h', tr('로그')), logBtn);
    detail.append(logHead, view);
  }

  function draw() {
    // while the user is typing in the right part it is not drawn again under their hands
    const ae = document.activeElement;                                              // (a switch or a box that was just clicked has the focus too: it must be drawn again to show the new state)
    const typing = top.contains(ae) && (ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || (ae.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(ae.type)));
    drawList();
    if (!typing) drawDetail();
  }
  redraws.add(draw);
  draw();
  const observer = new MutationObserver(() => { if (!root.isConnected) { redraws.delete(draw); observer.disconnect(); const old = uiFor && uiFrames.get(uiFor); if (old) { old.stop(); uiFrames.delete(uiFor); uiFor = ''; } } });
  observer.observe(document.body, { childList: true, subtree: true });
  return root;
}

export default {
  id: 'plugins', title: '플러그인', subtitle: 'plugins 폴더의 플러그인을 켜고, 허용할 권한을 고릅니다',
  dot: () => state.some(p => p.review && p.ok),
  cards: [
    { title: '플러그인 목록', rows: [
      { type: 'custom', block: true, key: 'plugins_panel', label: '', keywords: '플러그인 plugin 권한 허용 확장 폴더', build: () => panel() },
    ] },
  ],
};
