// The move of the files of version 1.x (core/legacy.js): what is found, what stays, and that nothing is lost.
import fs from 'node:fs';
import { memoryFiles } from './memoryfiles.mjs';
import { eq, check } from './helpers.mjs';
import { scan, run, BACKUP } from '../app/core/legacy.js';

const fixture = tag => fs.readFileSync(new URL(`./fixtures/legacy_files_${tag}.txt`, import.meta.url), 'utf8').split('\n').filter(Boolean);

// the user's own data and the files of 3.0, next to the 1.x files
const THREE = ['ChatMatrixReader.exe', 'app/control.html', 'app/hub.js', 'app/core/config.js', 'locale/en-US.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'BUILD-INFO.txt',
  'config.json', 'config.1x.json', 'Glossary.txt', 'Glossary.sample.txt', 'usage.json', 'README.md', 'fonts/README.txt', 'fonts/My.ttf', 'logs/chatmatrix.log',
  'webview-data/x', 'extensions/stt/engine-vulkan/cmr-stt.exe', 'extensions/stt/models/ggml-small.bin', 'extensions/stt/models/ggml-medium.bin.part', 'extensions/stt/catalog.json',
  'my notes.txt', 'docs/mine.txt', 'old_version_backup/app.py'];

function folder(oldNames, extra = []) {
  const f = memoryFiles(Object.fromEntries([...THREE, ...oldNames, ...extra].map(p => [p, p === 'config.json' ? '{"translator":"openai"}' : ''])));
  // fs_move of the exe on a Map: a file or everything under a folder name; the target must be free
  const moveLog = [];
  const move = async (from, to) => {
    const keys = [...f.data.keys()].filter(k => k === from || k.startsWith(from + '/'));
    if (!keys.length) throw new Error('not there: ' + from);
    if (f.data.has(to) || [...f.data.keys()].some(k => k.startsWith(to + '/'))) throw new Error('target exists: ' + to);
    for (const k of keys) { f.data.set(to + k.slice(from.length), f.data.get(k)); f.data.delete(k); }
    moveLog.push(from);
  };
  return { f, move, moveLog };
}

for (const tag of ['1.8.1', '1.5.3.1']) {
  const old = fixture(tag).filter(n => !['README.md', 'Glossary.sample.txt', 'locale/en-US.txt', 'fonts/README.txt'].includes(n));
  const { f, move } = folder(old, ['chatmatrix.log.1', 'chatmatrix_stt.log.1', 'chatmatrix_stt.log.crash', 'chatmatrix_stt.log']);
  const before = new Set(f.data.keys());
  const s = await scan(f);
  check(s.found, `${tag}: found`);
  const r = await run(f, move, new Date(2026, 10, 17, 15, 30, 5));
  eq(r.ok, true, `${tag}: moved all`);
  eq(r.batch, `${BACKUP}/moved-by-3.0-20261117-153005`, `${tag}: batch folder`);
  eq((await scan(f)).found, false, `${tag}: no longer found after the move`);
  const after = [...f.data.keys()];
  const lost = [...before].filter(k => !f.data.has(k) && !after.some(a => a.endsWith('/' + k)));
  eq(lost, [], `${tag}: every file is somewhere (nothing deleted)`);
  for (const k of THREE) check(f.data.has(k), `${tag}: ${k} stays`);
  // no 1.x program file is left in the program folders
  const left = after.filter(k => !k.startsWith(BACKUP + '/') && (/\.(py|bat|vbs|command)$/.test(k) || /\.log(\.|$)/.test(k) && !k.startsWith('logs/') || k.startsWith('ChatMatrix Reader.app/')));
  eq(left, [], `${tag}: no program file, log or launcher of 1.x is left`);
  check(f.data.has(`${r.batch}/MOVED.txt`), `${tag}: the list of moved files is written`);
  check(f.data.has(`${r.batch}/app/app.py`) || f.data.has(`${r.batch}/app.py`), `${tag}: the sub-folder of origin is kept`);
}

// 1.7+: the Python voice recognition in extensions/stt moves, the 3.0 engine and models stay
{
  const { f, move } = folder(fixture('1.8.1'), ['extensions/stt/.venv/Scripts/python.exe', 'extensions/stt/models/.hf_home/x', 'extensions/stt/models/models--Systran--faster-whisper-small/blobs/a', 'extensions/stt/stt_main.py', 'extensions/stt/sttcore/audio.py', 'extensions/stt/requirements.txt', 'extensions/stt/bench/a.wav']);
  const r = await run(f, move, new Date(2026, 0, 2, 3, 4, 5));
  eq(r.ok, true, 'stt: ok');
  for (const k of ['extensions/stt/.venv/Scripts/python.exe', 'extensions/stt/models/.hf_home/x', 'extensions/stt/stt_main.py', 'extensions/stt/sttcore/audio.py']) check(!f.data.has(k) && f.data.has(`${r.batch}/${k}`), `stt: ${k} moved`);
  for (const k of ['extensions/stt/engine-vulkan/cmr-stt.exe', 'extensions/stt/models/ggml-small.bin', 'extensions/stt/bench/a.wav', 'extensions/stt/catalog.json']) check(f.data.has(k), `stt: ${k} stays`);
}

// a folder without 1.x: nothing is found, nothing is touched
{
  const { f, move, moveLog } = folder([]);
  eq((await scan(f)).found, false, 'a 3.0 folder is not a legacy folder');
  eq((await run(f, move)).moved, [], 'nothing moved');
  eq(moveLog, [], 'no move call');
}

// a failure (a running 1.x program holds its files): the marks stay, so the next start offers it again; the retry finishes
{
  const { f, move } = folder(fixture('1.8.1'));
  let lock = true;
  const flaky = (from, to) => (lock && from === '.venv' ? Promise.reject(new Error('Access denied')) : move(from, to));
  f.data.set('.venv/Scripts/pythonw.exe', '');
  const r1 = await run(f, flaky, new Date(2026, 0, 2, 3, 4, 5));
  eq([r1.ok, r1.failed.map(x => x.path)], [false, ['.venv']], 'a failed move is reported');
  eq((await scan(f)).found, true, 'after a failure the folder is still found (the program does not start)');
  check(f.data.has('app/app.py'), 'the marks were not moved');
  lock = false;
  const r2 = await run(f, flaky, new Date(2026, 0, 2, 3, 5, 0));
  eq(r2.ok, true, 'the second try finishes');
  eq((await scan(f)).found, false, 'then it starts');
  check(f.data.has(`${r2.batch}/app/app.py`) && f.data.has(`${r1.batch}/app/options.py`), 'files of the first try stay in the first folder');
}

// the app of the same name on the Mac: the 1.x launcher (with `launch`) moves, the 3.0 app (its own program inside) stays
{
  const { f, move } = folder(['app/app.py', 'ChatMatrix Reader.app/Contents/MacOS/launch', 'ChatMatrix Reader.app/Contents/Info.plist']);
  await run(f, move, new Date(2026, 0, 2, 3, 4, 5));
  check(![...f.data.keys()].some(k => k.startsWith('ChatMatrix Reader.app/')), 'the 1.x launcher app is moved');
  const g = folder(['app/app.py'], ['ChatMatrix Reader.app/Contents/MacOS/chatmatrix-reader', 'ChatMatrix Reader.app/Contents/Info.plist']);
  await run(g.f, g.move, new Date(2026, 0, 2, 3, 4, 5));
  check(g.f.data.has('ChatMatrix Reader.app/Contents/MacOS/chatmatrix-reader'), 'the 3.0 app stays');
}
