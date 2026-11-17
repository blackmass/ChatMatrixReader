// The window shown instead of the program when the folder still holds the files of version 1.x (the exe opens only this page then;
// src-tauri/src/main.rs legacy_present). "Move and start" puts them into old_version_backup/ (core/legacy.js) and starts the program again;
// "cancel" (or the X) ends it.
import { files } from './fs.js';
import * as settings from './settings.js';
import { startI18n } from './i18n_host.js';
import { tr } from './core/i18n.js';
import { scan, run, explain } from './core/legacy.js';

const invoke = window.__TAURI__.core.invoke;
const $ = id => document.getElementById(id);

try { await settings.load({ readOnly: true }); await startI18n(settings); } catch { /* the page is shown in Korean */ }

let items = [];
async function show() {
  const s = await scan(files);
  items = s.items;
  $('sum').textContent = tr('옮길 파일과 폴더 {n}개 (눌러서 보기)', { n: items.length });
  $('list').replaceChildren(...items.slice(0, 200).map(it => Object.assign(document.createElement('li'), { textContent: it.path + (it.dir ? '/' : '') })));
  if (items.length > 200) $('list').append(Object.assign(document.createElement('li'), { textContent: '...' }));
  $('go').disabled = false;
  return s;
}

$('cancel').onclick = () => invoke('quit_app');
$('go').onclick = async () => {
  $('go').disabled = $('cancel').disabled = true;
  $('err').textContent = '';
  $('go').textContent = tr('옮기는 중...');
  const r = await run(files, (from, to) => invoke('fs_move', { from, to }));
  if (r.ok) {
    $('go').textContent = tr('다시 시작합니다...');
    await invoke('restart_app');
    return;
  }
  $('err').textContent = tr('옮기지 못한 것이 있습니다. 이전 버전 프로그램이 켜져 있으면 먼저 끄고(작업 관리자에서 python, pythonw 종료) 다시 시도하세요.') + '\n' + explain(r.failed);
  await show();
  $('go').textContent = tr('다시 시도');
  $('cancel').disabled = false;
};

try { await show(); } catch (e) { $('err').textContent = String(e?.message || e); }
