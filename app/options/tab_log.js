// 기록: the log of the program, and what the program and its helper processes use (memory, CPU, handles). The numbers are read only while this page is shown.
import { tr } from '../core/i18n.js';
import { files } from '../fs.js';
import * as debuglog from '../core/debuglog.js';

const invoke = window.__TAURI__.core.invoke;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const mb = bytes => (bytes ? (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) : '–');
const CORES = Math.max(1, navigator.hardwareConcurrency || 1);

// what a process is, in words ("WebView2 렌더러" ...)
function roleOf(p) {
  if (p.kind === 'main') return tr('프로그램 본체');
  if (p.kind === 'renderer') return tr('웹뷰: 페이지(렌더러)');
  if (p.kind === 'gpu-process') return tr('웹뷰: 그래픽(GPU)');
  if (p.kind === 'utility') return tr('웹뷰: 보조') + (p.sub ? ` (${p.sub})` : '');
  if (p.kind === 'crashpad-handler') return tr('웹뷰: 오류 기록');
  if (p.kind === 'webkit') return tr('웹킷 (시스템이 시작, 모든 프로그램 포함)');
  if (p.name && /whisper|stt/i.test(p.name)) return tr('음성 인식 엔진');
  if (/webview2/i.test(p.name || '')) return tr('웹뷰 (브라우저)');
  return tr('하위 프로세스');
}

// the live table: asks for the numbers every 1.5 s while it is on the screen, nothing otherwise
export function resourceBlock() {
  const root = el('div', 'resmon');
  const bar = el('div', 'res-total'), table = el('table', 'res-table'), note = el('small', 'note');
  const head = el('tr');
  for (const h of [tr('역할'), tr('프로세스'), 'PID', 'CPU %', tr('메모리(MB)'), tr('개인(MB)'), tr('핸들'), 'GDI', 'USER']) head.append(el('th', '', h));
  const thead = el('thead'); thead.append(head);
  const tbody = el('tbody');
  table.append(thead, tbody);
  root.append(bar, table, note);
  const last = new Map();                        // pid -> { cpu_ms, at }
  let timer = 0, busy = false;
  const draw = r => {
    const rows = r.procs || [];
    const now = performance.now();
    let totalMem = 0, totalCpu = 0, totalPriv = 0;
    tbody.textContent = '';
    for (const p of rows) {
      let cpu = null;
      if (typeof p.cpu_pct === 'number') cpu = p.cpu_pct / CORES;                                // (macOS: given, in cores)
      else if (typeof p.cpu_ms === 'number') { const b = last.get(p.pid); if (b && now > b.at) cpu = Math.max(0, (p.cpu_ms - b.cpu_ms) / (now - b.at) / CORES * 100); last.set(p.pid, { cpu_ms: p.cpu_ms, at: now }); }
      if (p.kind !== 'webkit') { totalMem += p.ws || 0; totalPriv += p.private || 0; if (cpu !== null) totalCpu += cpu; }
      const tr_ = el('tr', p.kind === 'main' ? 'res-main' : '');
      for (const t of [roleOf(p), p.name || '', String(p.pid), cpu === null ? '–' : cpu.toFixed(1), mb(p.ws), mb(p.private), p.handles ? String(p.handles) : '–', p.gdi ? String(p.gdi) : '–', p.user ? String(p.user) : '–']) tr_.append(el('td', '', t));
      tbody.append(tr_);
    }
    for (const pid of [...last.keys()]) if (!rows.some(p => p.pid === pid)) last.delete(pid);
    const n = rows.filter(p => p.kind !== 'webkit').length;
    bar.textContent = tr('프로세스 {n}개 · 합계 메모리 {mem} MB{priv} · CPU {cpu} % (전체 CPU 기준)', { n, mem: mb(totalMem), priv: totalPriv ? ' ' + tr('(개인 {p} MB)', { p: mb(totalPriv) }) : '', cpu: totalCpu.toFixed(1) });
    note.textContent = r.note === 'webkit' ? tr('웹킷 프로세스는 시스템이 시작해서, 다른 프로그램의 것이 섞여 있고 합계에 넣지 않았습니다.') : '';
  };
  const tick = async () => {
    if (!root.isConnected) { clearInterval(timer); timer = 0; return; }
    if (busy || document.hidden) return;
    busy = true;
    try { draw(await invoke('process_stats')); } catch (e) { bar.textContent = tr('읽지 못했습니다: {e}', { e: String(e).slice(0, 200) }); } finally { busy = false; }
  };
  timer = setInterval(tick, 1500);
  setTimeout(tick, 50);
  return root;
}

export default {
  id: 'log', title: '기록', subtitle: '자원 사용, 로그',
  cards: [
    { title: '자원 사용', note: '프로그램과 그 하위 프로세스(웹뷰 보조 프로세스, 음성 엔진)가 쓰는 메모리와 CPU입니다. 이 화면이 열려 있는 동안에만 1.5초마다 읽습니다. 작업 관리자는 이 프로세스들을 한 줄로 묶어 보여 줍니다.', rows: [
      { type: 'custom', block: true, label: '자원', keywords: '자원 메모리 cpu 프로세스 핸들 gdi 부하 사용량 웹뷰 창', build: () => resourceBlock() },
    ] },
    { title: '로그', note: '문제가 생기면 이 내용을 복사해서 알려 주세요. 파일은 프로그램 폴더의 logs/chatmatrix.log 입니다.', rows: [
      { type: 'logview', label: '최근 로그', files, path: 'logs/chatmatrix.log', last: 400, rows: 20, keywords: '로그 log 기록 오류' },
    ] },
    { title: '상세 기록 (문제를 찾을 때만)', note: ['평소에는 모두 꺼 두세요. 켠 영역의 자세한 기록이 프로그램 폴더의 logs/debug.log에 쌓이고, 끄면 바로 멈춥니다 (재시작이 필요 없습니다).', '문제가 생겼을 때 해당 영역을 켜고 증상을 한 번 만든 뒤, 아래 기록을 복사하거나 파일을 보내 주세요. 창 이름은 남기지 않고 창 종류와 프로그램 이름만 남깁니다.'], rows: [
      ...debuglog.AREAS.map(a => ({ key: 'debug_' + a.key, type: 'check', label: a.label, keywords: '상세 기록 디버그 로그 진단 ' + a.key, note: a.note, def: false,
        get: cfg => debuglog.normalize(cfg.debug_log)[a.key], patch: (cfg, v) => ({ debug_log: { ...debuglog.normalize(cfg.debug_log), [a.key]: v === true } }) })),
      { type: 'logview', label: '상세 기록', files, path: 'logs/debug.log', last: 400, rows: 14, keywords: '상세 기록 디버그 로그 진단 debug' },
    ] },
  ],
};
