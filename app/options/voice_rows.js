// The live parts of the 음성인식 tab: the state with its on / off button, what is installed with the install buttons, and what the engine uses
// of the computer. The hub tells the state ('voice-state', see voice_host.js); this page only shows it and asks.
import { tr } from '../core/i18n.js';
import { stateWhy, statusText } from '../core/voice_text.js';
import { BUILTIN } from '../core/voice_catalog.js';
import { captureText } from '../core/voice_target.js';
import { ratioText } from '../core/voice_bench.js';
import { RELEASES_URL } from '../core/version.js';

const { emit, listen } = window.__TAURI__.event;
const invoke = window.__TAURI__.core.invoke;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

let state = null;
const subs = new Set();
listen('voice-state', ev => { state = ev.payload; subs.forEach(f => f()); });
emit('voice-hello', {});
// a part on screen follows the state while it is on screen (a part of an earlier view is dropped)
const follow = (node, draw) => { const f = () => { if (!node.isConnected && node.dataset.seen) { subs.delete(f); return; } if (node.isConnected) node.dataset.seen = '1'; draw(); }; subs.add(f); draw(); };

// the loudness readings (about 10 a second, from the hub: voice_host.js 'voice-level'): they do not go through the state, so they redraw only the bar
const levelSubs = new Set();
listen('voice-level', ev => levelSubs.forEach(f => f(ev.payload || {})));

const ENGINE_NAME = { cpu: 'CPU', vulkan: 'Vulkan', cuda: 'CUDA' };
const DEVICE_NAME = { cpu: 'CPU', gpu: 'GPU' };

export const why = stateWhy;

// ---- the state and the button: what it is now, and what the button will do. Under it: how the sound is received, what waits for a restart, the loudness
const PENDING_NAME = { model: '모델', device: '계산 장치', engine: '음성인식 방식' };
const toDb = v => 20 * Math.log10(Math.max(v, 1e-6));
const DB_MIN = -70;                                          // the left end of the bar (the right end is 0 dB)
const pctOf = db => Math.max(0, Math.min(1, (db - DB_MIN) / -DB_MIN)) * 100;

export function statusRow() {
  const wrap = el('div', 'vstatus'), dot = el('span', 'vdot'), text = el('span', 'vtext'), btn = el('button', 'btn vtoggle'), cap = el('div', 'vcap');
  const pend = el('div', 'vpending'), pendText = el('span'), pendBtn = el('button', 'btn small', tr('지금 다시 시작'));
  const bar = el('div', 'vlevel'), track = el('div', 'vtrack'), fill = el('div', 'vfill'), tick = el('div', 'vtick'), speech = el('span', 'vspeech', tr('말 감지')), num = el('span', 'vdb'), gate = el('span', 'vgate');
  const texts = el('div', 'vtexts');
  track.append(fill, tick); bar.append(track, speech, num, gate);
  pend.append(pendText, pendBtn); pend.hidden = true;
  wrap.append(dot, text, btn, cap, pend, bar, texts);
  btn.onclick = () => emit('voice-toggle', {});
  pendBtn.onclick = () => emit('voice-restart', {});
  let shown = null;                                          // the state of the last drawing (the loudness readings need to know whether it is on)
  let lastEngine = -1e9;
  const onLevel = l => {
    if (!wrap.isConnected && wrap.dataset.seen) { levelSubs.delete(onLevel); return; }
    if (!shown || shown.state !== 'on') return;
    let db, thr = null, speaking = null;
    if (l.source === 'engine') { lastEngine = performance.now(); db = l.db; thr = l.thr; speaking = !!l.speech; }
    else {
      if (shown.capture && shown.capture.mode === 'device') { gate.textContent = l.gate ? tr('통과 중') : tr('막는 중'); gate.classList.toggle('on', !!l.gate); }
      if (performance.now() - lastEngine < 1500) return;     // (the engine's own reading is the better one while it comes)
      db = toDb(l.peak ?? l.level ?? 0);
    }
    if (typeof db !== 'number' || !Number.isFinite(db)) return;
    fill.style.width = pctOf(db) + '%';
    fill.classList.toggle('speech', speaking === true);
    tick.hidden = thr === null; if (thr !== null) tick.style.left = pctOf(thr) + '%';
    speech.classList.toggle('on', speaking === true); speech.hidden = speaking === null;
    num.textContent = Math.round(db) + ' dB';
  };
  levelSubs.add(onLevel);
  const sentenceLine = () => {
    const t = shown && shown.texts;
    if (!t || !t.count) return tr('아직 인식된 글이 없습니다');
    return tr('인식된 글 {n}개 · 마지막 글은 {sec}초 전', { n: t.count, sec: Math.max(0, Math.round((Date.now() - t.last) / 1000)) });
  };
  const timer = setInterval(() => { if (!wrap.isConnected && wrap.dataset.seen) { clearInterval(timer); return; } if (shown && shown.state === 'on') texts.textContent = sentenceLine(); }, 1000);
  follow(wrap, () => {
    const s = state || { state: 'off' };
    shown = s;
    const busy = s.state === 'starting' || s.state === 'stopping', running = s.state === 'on' || s.state === 'starting';
    wrap.dataset.state = s.state;
    text.textContent = statusText(s, tr);
    btn.textContent = running ? tr('끄기') : tr('켜기');
    btn.classList.toggle('on', s.state === 'on');
    btn.disabled = busy;
    // how the sound is received now, and a warning when none comes
    cap.textContent = running ? [captureText(s.capture, tr), s.warn ? '⚠ ' + s.warn : ''].filter(Boolean).join('   ') : '';
    cap.hidden = !cap.textContent;
    cap.dataset.warn = s.warn ? '1' : '';
    // what the options changed that only a restart applies
    const waiting = running && Array.isArray(s.pending) ? s.pending : [];
    pend.hidden = !waiting.length;
    pendText.textContent = waiting.length ? '⚠ ' + tr('바뀐 설정은 다시 시작해야 적용됩니다') + ': ' + waiting.map(k => tr(PENDING_NAME[k] || k)).join(', ') : '';
    pendBtn.disabled = busy;
    // the loudness bar and the sentences: only while it is on
    bar.hidden = s.state !== 'on'; texts.hidden = s.state !== 'on';
    if (s.state !== 'on') { fill.style.width = '0'; num.textContent = ''; } else texts.textContent = sentenceLine();
    gate.hidden = !(s.capture && s.capture.mode === 'device');
  });
  return wrap;
}

// ---- where the engine and the models come from (the only things this program downloads): the places are listed with a button that opens each one
// (the exe opens only addresses it knows: open_url in main.rs)
export const SOURCES = [
  { what: '모델 파일을 받는 곳', url: 'https://huggingface.co/ggerganov/whisper.cpp', text: 'Hugging Face · ggerganov/whisper.cpp (whisper.cpp 제작자의 공식 모델 저장소)' },
  { what: '음성인식 엔진을 받는 곳', url: RELEASES_URL, text: '이 프로그램의 GitHub 릴리스 (엔진 파일과 SHA-256)' },
  { what: '엔진의 원본 (MIT)', url: 'https://github.com/ggml-org/whisper.cpp', text: 'whisper.cpp · 엔진은 이 프로젝트를 바탕으로 만들었습니다' },
  { what: '모델의 원본 (MIT)', url: 'https://github.com/openai/whisper', text: 'OpenAI Whisper · 모델 자체를 만든 곳' },
];
export function sourcesRow() {
  const wrap = el('div', 'vsources');
  for (const s of SOURCES) {
    const line = el('div', 'vsource'), b = el('button', 'btn small', tr('열기'));
    b.onclick = () => invoke('open_url', { url: s.url }).catch(() => {});
    const t = el('div', 'vsrctext'); t.append(el('b', '', tr(s.what)), el('div', '', tr(s.text)), el('small', 'note', s.url));
    line.append(t, b); wrap.append(line);
  }
  return wrap;
}

// ---- what is installed, and the buttons that add to it or take it away
export function installRow() {
  const wrap = el('div', 'vinstall'), lines = el('div', 'vlines'), btns = el('div', 'vbtns'), msg = el('small', 'note vmsg');
  wrap.append(lines, btns, msg);
  const button = (label, what) => { const b = el('button', 'btn small', label); b.onclick = () => emit('voice-install', { what }); return b; };
  let armed = false;
  follow(wrap, () => {
    const inst = (state && state.installed) || { engines: [], models: [] };
    const have = inst.engines.length > 0;
    lines.replaceChildren(
      el('div', have ? 'vok' : 'vnone', have ? tr('설치됨') : tr('설치되지 않음')),
      el('div', '', tr('엔진') + ': ' + (inst.engines.map(e => ENGINE_NAME[e]).join(', ') || '-')),
      el('div', '', tr('모델') + ': ' + (inst.models.join(', ') || '-')));
    btns.replaceChildren();
    const busy = !!(state && state.busy);
    const add = (label, what) => { const b = button(label, what); b.disabled = busy; btns.append(b); };
    if (!inst.engines.includes('cpu')) add(tr('설치 (CPU)'), 'cpu');
    if (!inst.engines.includes('vulkan')) add(tr('Vulkan 추가 (GPU)'), 'vulkan');
    if (!inst.engines.includes('cuda')) { const b = el('button', 'btn small', tr('CUDA 추가 (NVIDIA) · 예정')); b.disabled = true; b.title = tr('아직 만들지 않았습니다. Vulkan이 NVIDIA 그래픽카드에서도 동작합니다.'); btns.append(b); }
    const want = state && state.wantModel;
    if (have && want && !inst.models.includes(want)) add(tr('모델 받기 ({model})', { model: want }), 'model');
    if (busy) { const c = el('button', 'btn small', tr('취소')); c.onclick = () => emit('voice-cancel', {}); btns.append(c); }
    if ((have || inst.models.length) && !busy) {
      const del = el('button', 'btn small vdel', armed ? tr('정말 삭제') : tr('삭제'));
      del.classList.toggle('on', armed);
      del.onclick = () => { if (!armed) { armed = true; del.textContent = tr('정말 삭제'); del.classList.add('on'); setTimeout(() => { armed = false; if (del.isConnected) { del.textContent = tr('삭제'); del.classList.remove('on'); } }, 3000); return; } armed = false; emit('voice-remove', {}); };
      btns.append(del);
    }
    const task = state && state.task;
    msg.textContent = task === 'no_installer' ? tr('이 빌드에는 설치 기능이 아직 없습니다. 다음 빌드에서 연결됩니다.') : task || '';
    msg.hidden = !msg.textContent;
  });
  return wrap;
}

// ---- the models: which are on the disk and which are not, a button to get / delete each one, and the speed of each (measured while it runs, and by the
// speed test with one fixed sound file). The test needs the recognition to be off: it runs the models one after another.
const fmtMb = n => (n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : n + ' MB');
const sec = v => (typeof v === 'number' ? v.toFixed(1) + ' ' + tr('초') : '-');
// the cell of the speed test: the ratio and the time of the timed run, and below it the time the model took to load (it is not part of the speed)
function benchCell(bn, fail) {
  const td = el('td');
  if (!bn) { td.textContent = fail ? '✗ ' + fail : '-'; return td; }
  td.append(document.createTextNode((bn.bench.ratio > 1 ? '⚠ ' : '') + ratioText(bn.bench.ratio) + ' · ' + sec(bn.bench.ms / 1000)));
  if (typeof bn.bench.load_ms === 'number') td.append(el('br'), el('small', 'note', tr('불러오기') + ' ' + sec(bn.bench.load_ms / 1000)));
  td.title = bn.bench.ratio > 1 ? tr('말하는 속도를 따라가지 못합니다 (시험 배율이 1을 넘음)') : '';
  return td;
}
export function modelsRow() {
  const wrap = el('div', 'vmodels'), table = el('table', 'perf vmtable'), head = el('thead'), body = el('tbody'), tools = el('div', 'vbench'), out = el('div', 'vbenchout'), msg = el('small', 'note vmsg');
  head.append(...[tr('모델'), tr('크기'), tr('상태'), tr('실제 사용 배율'), tr('시험 배율 (측정 / 불러오기)'), ''].map(t => el('th', '', t)));
  table.append(head, body);
  const fileSel = el('select', 'vbfile'), runBtn = el('button', 'btn small', tr('선택한 모델 속도 시험')), cancelBtn = el('button', 'btn small', tr('시험 취소')), clearBtn = el('button', 'btn small', tr('속도 기록 지우기')), refreshBtn = el('button', 'btn small', tr('파일 목록 새로 고침'));
  const how = el('small', 'note', tr('시험용 소리 파일(.wav)을 프로그램 폴더의 extensions/stt/bench 에 넣고 "파일 목록 새로 고침"을 누르세요. 모든 모델이 같은 파일로 시험되어 서로 비교할 수 있습니다. 말하는 소리가 10~30초쯤 들어 있는 16 kHz 모노 파일이 좋습니다. 시험은 모델 불러오기, 워밍업 1회, 측정 1회 순서로 하고, 배율은 마지막 측정만 잰 값입니다 (불러오는 시간은 따로 보여 줍니다). 큰 모델을 CPU로 시험하면 몇 분이 걸릴 수 있습니다.'));
  const status = el('small', 'note vbtask');
  tools.append(fileSel, refreshBtn, runBtn, cancelBtn, clearBtn);
  wrap.append(table, how, tools, status, out, msg);
  const picked = new Set();                 // models ticked for the test (kept while the page is open)
  try { JSON.parse(localStorage.getItem('cmr-bench-picked') || '[]').forEach(n => picked.add(n)); } catch { /* none */ }
  const savePicked = () => { try { localStorage.setItem('cmr-bench-picked', JSON.stringify([...picked])); } catch { /* ignore */ } };
  let file = ''; try { file = localStorage.getItem('cmr-bench-file') || ''; } catch { /* ignore */ }
  fileSel.onchange = () => { file = fileSel.value; try { localStorage.setItem('cmr-bench-file', file); } catch { /* ignore */ } };
  refreshBtn.onclick = () => emit('voice-bench-files', {});
  runBtn.onclick = () => emit('voice-bench', { models: [...picked], file: fileSel.value });
  cancelBtn.onclick = () => emit('voice-bench-cancel', {});
  clearBtn.onclick = () => emit('voice-perf-clear', {});
  emit('voice-bench-files', {});
  const device = s => (s.device === 'gpu' ? 'gpu' : s.device === 'cpu' ? 'cpu' : (s.installed.engines.includes('cuda') || s.installed.engines.includes('vulkan') ? 'gpu' : 'cpu'));
  const syncRun = () => {        // the test button: something ticked that is on the disk, a file, nothing else running
    const s = state || {}, inst = s.installed || { models: [] };
    runBtn.disabled = !!s.busy || !!s.benchTask || s.state === 'on' || s.state === 'starting' || !(s.benchFiles || []).length || ![...picked].some(n => inst.models.includes(n));
  };
  follow(wrap, () => {
    const s = state || { installed: { engines: [], models: [] }, perf: [], benchFiles: [], benchFail: {} };
    const inst = s.installed || { engines: [], models: [] }, busy = !!s.busy, testing = !!s.benchTask, on = s.state === 'on' || s.state === 'starting';
    const names = [...Object.keys(BUILTIN.models), ...inst.models.filter(n => !(n in BUILTIN.models))];
    const perf = s.perf || [];
    const pick = (n, kind) => { const rows = perf.filter(p => p.model === n && p[kind]); return rows.length ? rows[rows.length - 1] : null; };      // (the newest device wins)
    body.replaceChildren(...names.map(n => {
      const have = inst.models.includes(n), r = el('tr'), live = pick(n, 'live'), bn = pick(n, 'bench'), use = n === s.model && on;
      const box = el('input'); box.type = 'checkbox'; box.disabled = !have || testing || busy; box.checked = have && picked.has(n);
      box.onchange = () => { if (box.checked) picked.add(n); else picked.delete(n); savePicked(); syncRun(); };
      const name = el('td'); const lab = el('label'); lab.append(box, ' ' + n); name.append(lab);
      const btn = el('td');
      const b = el('button', 'btn small', have ? tr('삭제') : tr('받기'));
      b.disabled = busy || testing || (have && use);
      let armed = false;
      b.onclick = () => {
        if (!have) { emit('voice-model-install', { name: n }); return; }
        if (!armed) { armed = true; b.textContent = tr('정말 삭제'); b.classList.add('on'); setTimeout(() => { armed = false; if (b.isConnected) { b.textContent = tr('삭제'); b.classList.remove('on'); } }, 3000); return; }
        emit('voice-model-remove', { name: n });
      };
      btn.append(b);
      const st = el('td', have ? 'vok' : 'vnone', have ? tr('설치됨') + (use ? ' · ' + tr('사용 중') : '') : tr('없음'));
      r.append(name, el('td', '', (BUILTIN.models[n] || {}).mb ? fmtMb(BUILTIN.models[n].mb) : '-'), st,
        el('td', '', live ? ratioText(live.live.ratio) + ' (' + live.live.n + ')' : '-'),
        benchCell(bn, s.benchFail && s.benchFail[n]), btn);
      return r;
    }));
    // the sound files of the test
    const list = s.benchFiles || [];
    fileSel.replaceChildren(...(list.length ? list : ['']).map(f => { const o = el('option', '', f || tr('(파일 없음)')); o.value = f; return o; }));
    if (list.includes(file)) fileSel.value = file;
    syncRun();
    cancelBtn.hidden = !testing; clearBtn.disabled = testing || !perf.length; refreshBtn.disabled = testing;
    status.textContent = testing ? tr('속도 시험') + ': ' + (s.benchTask === '…' ? '' : s.benchTask) : on ? tr('속도 시험은 음성인식을 끈 뒤에 할 수 있습니다.') : '';
    // what each model heard in the test: the accuracy can be compared by eye
    out.replaceChildren(...perf.filter(p => p.bench && p.bench.text).map(p => {
      const d = el('div', 'vheard'); d.append(el('b', '', p.model + (p.device === 'gpu' ? ' (GPU)' : ' (CPU)') + ': '), document.createTextNode(p.bench.text)); return d;
    }));
    const behind = perf.some(p => p.bench && p.bench.ratio > 1);
    const slow = s.advice === 'slow' && s.model ? tr('{model}: 말하는 속도를 따라가지 못하고 있습니다 (실제 사용 배율이 1을 넘음). 더 작은 모델을 써 보세요.', { model: s.model }) : '';
    msg.textContent = slow || (s.task && s.task !== 'no_installer' ? s.task : behind ? tr('시험 배율이 1을 넘는 모델은 그 장치에서 말하는 속도를 따라가지 못합니다. 더 작은 모델을 쓰거나 GPU(Vulkan) 엔진을 쓰세요.') : '');
    msg.hidden = !msg.textContent;
  });
  return wrap;
}

// ---- what the engine uses of the computer (told by the engine while it runs)
export function statsRow() {
  const wrap = el('div', 'perfwrap'), table = el('table', 'perf vstats'), body = el('tbody');
  table.append(body); wrap.append(table);
  const pct = v => (typeof v === 'number' ? v.toFixed(0) + ' %' : '-');
  const mb = v => (typeof v === 'number' ? (v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v.toFixed(0) + ' MB') : '-');
  follow(wrap, () => {
    const s = state || {}, st = (s.state === 'on' && s.stats) || {};
    const rows = [[tr('지금 쓰는 장치'), s.state === 'on' ? (DEVICE_NAME[s.device] || '-') : tr('꺼져 있음')],
      [tr('CPU 점유율'), pct(st.cpu)], [tr('RAM 사용량'), mb(st.ram)], [tr('GPU 점유율'), pct(st.gpu), st.gpu_why], [tr('VRAM 사용량'), mb(st.vram), st.vram_why]];
    // (a number the engine could not read: "-" and, small, why it says it could not - the system's error code)
    body.replaceChildren(...rows.map(([k, v, why]) => { const r = el('tr'), td = el('td', '', v); if (why && v === '-') td.append(' ', el('small', 'note', '(' + why + ')')); r.append(el('td', '', k), td); return r; }));
  });
  return wrap;
}

// ---- the program picker. 'audio_apps' (exe) -> one entry per sound session: { pid, ppid, exe, role, sub, device, default, state, active, peak }.
// Chromium programs (Discord, Chrome ...) split into helper processes with different jobs, so the list is per program AND job AND device:
//   role 'renderer' = the program's pages (Discord: the voice chat), role 'utility' + sub 'AudioService' = media / web sound, 'main' = the program itself.
// The picked value is 'exe' (every sound of the program) or 'exe|role|sub' (one job only). A program missing from the list can still be typed.
import * as settings from '../settings.js';

const keyOf = a => (a.role && a.role !== 'main' ? [a.exe, a.role, a.sub || ''].join('|') : a.exe);
const jobName = a => (a.role === 'renderer' ? tr('렌더러') : a.role === 'utility' ? (a.sub || tr('유틸리티')) : a.role === 'main' || !a.role ? '' : a.role);

// sessions -> entries, one per program/job/device, with the loudest peak and the pids behind it
export function group(rows) {
  const map = new Map();
  for (const a of rows || []) {
    if (!a.exe || a.system) continue;
    const key = keyOf(a) + '@' + (a.device || '');
    let g = map.get(key);
    if (!g) { g = { key: keyOf(a), exe: a.exe, role: a.role, sub: a.sub, device: a.device, pids: [], peak: 0, active: false }; map.set(key, g); }
    g.pids.push(a.pid); g.peak = Math.max(g.peak, a.peak || 0); g.active = g.active || !!a.active;
  }
  // a fixed order (not by loudness): the list must hold still so that an entry can be clicked
  return [...map.values()].sort((x, y) => x.exe.localeCompare(y.exe) || (x.role || '').localeCompare(y.role || '') || (x.device || '').localeCompare(y.device || '') || x.pids[0] - y.pids[0]);
}
export const labelOf = g => [g.exe, jobName(g), g.device].filter(Boolean).join(' · ');
const fullLabel = g => labelOf(g) + ' · pid ' + g.pids.join(',');

export function appPickerRow() {
  const wrap = el('div', 'vpicker'), sel = el('select'), own = el('input', 'wide'), msg = el('small', 'note');
  const live = el('div', 'vsess'), probeBtn = el('button', 'btn small', tr('소리 확인 (4초)')), devBtn = el('button', 'btn small', tr('장치 소리 확인 (4초)')), fullBtn = el('button', 'btn small', tr('조합 전체 시험')), probeOut = el('pre', 'vprobe');
  own.type = 'text'; own.spellcheck = false; own.placeholder = tr('목록에 없으면 프로그램 파일 이름 (예: chrome.exe)');
  probeOut.hidden = true;
  const box = el('div', 'vlive'); const btns = el('div', 'vbtncol'); btns.append(probeBtn, devBtn, fullBtn); box.append(live, btns);
  wrap.append(sel, own, box, probeOut, msg);
  let list = [], shownKeys = '';
  const draw = () => {
    const cur = settings.cfg().voice_app || '';
    const keys = list.map(g => g.key + '@' + g.device + '#' + g.pids.join(',')).join('\n') + '#' + cur;
    if (keys !== shownKeys) {            // the drop-down is rebuilt only when its content changes (a rebuild closes an open list)
      shownKeys = keys;
      sel.replaceChildren();
      const blank = el('option', '', tr('(고르지 않음)')); blank.value = ''; sel.append(blank);
      const seen = new Set();
      for (const g of list) { seen.add(g.key); const o = el('option', '', fullLabel(g)); o.value = g.key; sel.append(o); }
      if (cur && !seen.has(cur)) { const o = el('option', '', cur + ' (' + tr('목록에 없음') + ')'); o.value = cur; sel.append(o); }
      sel.value = cur;
      if (document.activeElement !== own) own.value = seen.has(cur) ? '' : cur;
    }
    live.replaceChildren(...list.map(g => {
      const r = el('div', 'vsrow'), bar = el('span', 'vbar'), fill = el('i');
      fill.style.width = Math.min(100, Math.round(Math.sqrt(g.peak) * 100)) + '%'; bar.append(fill);
      const t = el('span', 'vsname', fullLabel(g)); t.title = fullLabel(g);
      r.classList.toggle('active', g.active); r.append(t, bar); return r;
    }));
  };
  let busy = false;
  const load = async () => {
    if (busy) return; busy = true;
    try {
      list = group((await invoke('audio_apps')) || []);
      msg.textContent = list.length ? '' : tr('지금 소리 세션이 있는 프로그램이 없습니다. 소리를 낸 뒤 기다려 보세요.');
    } catch { list = []; msg.textContent = tr('이 빌드에는 프로그램 목록을 읽는 기능이 아직 없습니다. 위 칸에 파일 이름을 직접 적을 수 있습니다.'); stop(); }
    busy = false; draw();
  };
  // refresh twice a second, only while this part is on screen and the window is visible
  let timer = 0;
  const stop = () => { clearInterval(timer); timer = 0; };
  const tick = () => { if (!wrap.isConnected && wrap.dataset.seen) { stop(); off(); return; } if (wrap.isConnected) wrap.dataset.seen = '1'; if (wrap.offsetParent !== null && document.visibilityState === 'visible') load(); };
  sel.onchange = () => { own.value = ''; settings.request({ voice_app: sel.value }); };
  own.onchange = () => settings.request({ voice_app: own.value.trim() });
  const f4 = v => (typeof v === 'number' ? v.toFixed(4) : '-');
  const heard = r => [tr('잡힌 소리 크기') + ': ' + f4(r.capture_peak) + ' (' + tr('평균') + ' ' + f4(r.capture_rms) + ')',
    tr('같은 출력 장치 전체 크기') + ': ' + f4(r.device_peak), tr('받은 길이') + ': ' + (r.frames / (r.rate || 44100)).toFixed(1) + ' ' + tr('초'),
    r.wav ? tr('저장') + ': ' + r.wav : ''];
  const picked = () => {
    const cur = settings.cfg().voice_app || '';
    return list.filter(x => x.key === cur).sort((a, b) => b.peak - a.peak)[0] || list.filter(x => x.exe === cur.split('|')[0])[0];
  };
  const run = async (what) => {
    const g = picked();
    probeOut.hidden = false;
    if (!g) { probeOut.textContent = tr('먼저 위 목록에서 프로그램을 고르세요. 목록에 없으면 소리를 낸 뒤 다시 시도하세요.'); return; }
    probeBtn.disabled = devBtn.disabled = fullBtn.disabled = true; probeOut.textContent = tr('확인 중… 고른 프로그램에서 소리를 내 주세요.');
    try {
      if (what === 'device') {
        const r = await invoke('audio_probe_device', { device: g.device, seconds: 4, save: true });
        probeOut.textContent = !r.ok ? tr('장치 소리 확인 실패') + ': ' + (r.step || '') + ' ' + (r.error || '')
          : [tr('장치') + ': ' + r.device + ' (' + r.format + ')', 'Windows ' + r.build, ...heard(r)].filter(Boolean).join('\n');
      } else {
        const pid = g.pids[0], r = await invoke('audio_probe', { pid, seconds: 4, save: true, full: what === 'full', device: g.device });
        const lines = [labelOf(g) + ' · pid ' + pid + ' · Windows ' + r.build, tr('시도한 조합') + ': ' + r.tried + ' · ' + tr('성공') + ': ' + (r.works || []).length];
        if (r.ok) lines.push(tr('사용') + ': ' + r.used, ...heard(r));
        else lines.push(tr('프로그램 단독 캡처 실패'));
        for (const w of (r.works || []).slice(0, 12)) lines.push('  OK ' + w);
        for (const e of r.activate_errors || []) lines.push('  activate x' + e.count + ' ' + e.error);
        for (const e of r.errors || []) lines.push('  x' + e.count + ' ' + e.error + '  (' + e.example + ')');
        probeOut.textContent = lines.filter(Boolean).join('\n');
      }
    } catch (e) { probeOut.textContent = tr('이 빌드에는 소리 확인 기능이 아직 없습니다.') + ' ' + String(e && e.message || e); }
    probeBtn.disabled = devBtn.disabled = fullBtn.disabled = false;
  };
  probeBtn.onclick = () => run('app');
  devBtn.onclick = () => run('device');
  fullBtn.onclick = () => run('full');
  const off = settings.onChange(() => { if (wrap.isConnected) draw(); });
  timer = setInterval(tick, 500); load();
  return wrap;
}
