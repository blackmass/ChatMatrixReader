// A folder that still holds the files of version 1.x (the Python program, from before 1.6 in the main folder, since 1.6 in app/).
// 3.0 does not use any of them. The first start finds them and (when the user agrees) MOVES them - never deletes - into
// old_version_backup/moved-by-3.0-<date>/, in the same sub-folders they came from. Until that is done the program does not start (a 1.x
// program next to 3.0 could rewrite config.json). Pure logic over a `files` object (app/fs.js, or the in-memory one of the tests) and a
// `move(from, to)` function (the exe: fs_move); tests/test_legacy.mjs.
//
// What is moved is decided by "what 1.x had", never by "everything that is not 3.0": the user's own files stay where they are. The user's
// data (config.json, Glossary.txt, usage.json, fonts/, extensions/ with the 3.0 engine and models, logs) is never touched.
export const BACKUP = 'old_version_backup';

const lc = s => s.toLowerCase();
const isDir = n => n.endsWith('/');
const bare = n => (isDir(n) ? n.slice(0, -1) : n);

// ---- main folder
const ROOT_KEEP = new Set(['readme.md', 'license', 'glossary.txt', 'glossary.sample.txt', 'usage.json', 'config.json', 'config.1x.json']);
const ROOT_DIRS = new Set(['plat', '.venv', '__pycache__', '.pytest_cache']);
const ROOT_FILE = /(\.py|\.pyc|\.bat|\.vbs|\.command|\.md)$|\.log(\.[a-z0-9]+)?$|^requirements.*\.txt$|^credit\.json$/;   // (the logs: chatmatrix.log, .log.1, .log.crash)
// the 1.x launcher for the Mac: an app whose Contents/MacOS has the script `launch`. 3.0 has an app of the same name (its program is
// there instead of `launch`): that one stays.
const OLD_APP = 'chatmatrix reader.app';
const ROOT_DOCS = new Set(['protocol.md', 'mac.md']);                 // (docs/ itself stays: a user may keep notes there)

// ---- app/ (1.6 and later: the program was moved there)
const APP_DIRS = new Set(['plat', '__pycache__', '.pytest_cache']);
const APP_FILE = /(\.py|\.pyc)$|^credit\.json$/;

// ---- extensions/stt/ (the 1.x voice recognition: a Python environment and models). The 3.0 engine (engine-*/) and its models
// (models/ggml-*.bin) live in the same folders and stay.
const STT_DIRS = new Set(['.venv', '.tmp', 'sttcore', '__pycache__']);
const STT_FILE = /(\.py|\.pyc)$|^requirements.*\.txt$|^readme\.md$/;
const KEEP_MODEL = /^ggml-.*\.bin(\.part)?$/;

// the two files whose presence says "this is a 1.x folder": moved last, so a start that was interrupted is found again
const MARKS = ['app.py', 'app/app.py'];

async function names(files, dir) {
  try { return await files.list(dir); } catch { return []; }
}

// -> { found, items: [{ path, dir }] }  (items are what would be moved; paths are relative to the program folder)
export async function scan(files) {
  const found = (await files.kind('app/app.py')) === 'file' || (await files.kind('app.py')) === 'file';
  if (!found) return { found: false, items: [] };
  const items = [];
  const add = (dir, n) => items.push({ path: dir ? `${dir}/${bare(n)}` : bare(n), dir: isDir(n) });

  for (const n of await names(files, '')) {
    const l = lc(bare(n));
    if (ROOT_KEEP.has(l)) continue;
    if (l === OLD_APP && isDir(n)) { if ((await files.kind(`${bare(n)}/Contents/MacOS/launch`)) === 'file') add('', n); continue; }
    if (isDir(n) ? ROOT_DIRS.has(l) : ROOT_FILE.test(l)) add('', n);
  }
  for (const n of await names(files, 'docs')) if (!isDir(n) && ROOT_DOCS.has(lc(n))) add('docs', n);
  for (const n of await names(files, 'app')) {
    const l = lc(bare(n));
    if (isDir(n) ? APP_DIRS.has(l) : APP_FILE.test(l)) add('app', n);
  }
  for (const n of await names(files, 'extensions/stt')) {
    const l = lc(bare(n));
    if (isDir(n) ? STT_DIRS.has(l) : STT_FILE.test(l)) add('extensions/stt', n);
  }
  for (const n of await names(files, 'extensions/stt/models')) if (!KEEP_MODEL.test(lc(bare(n)))) add('extensions/stt/models', n);
  return { found: true, items };
}

const pad = n => String(n).padStart(2, '0');
export const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// Moves what scan() found. -> { ok, batch, moved: [path], failed: [{ path, error }] }
// ok = nothing is left that would be moved. The marks go last and only when everything else went: after a failure the next start
// still finds the folder as "1.x" and offers the move again (the files already moved are not in the way).
export async function run(files, move, now = new Date()) {
  const { items } = await scan(files);
  const batch = `${BACKUP}/moved-by-3.0-${stamp(now)}`;
  const moved = [], failed = [];
  const go = async it => {
    try { await move(it.path, `${batch}/${it.path}`); moved.push(it.path); }
    catch (e) { failed.push({ path: it.path, error: String(e?.message || e) }); }
  };
  for (const it of items) if (!MARKS.includes(it.path)) await go(it);
  if (!failed.length) for (const it of items) if (MARKS.includes(it.path)) await go(it);
  if (moved.length) {
    const text = `ChatMatrixReader 3.0 moved these files of the earlier version here (${now.toISOString()}).\n` +
      'Nothing was deleted: after you have checked that all is well you may delete this folder.\n\n' + moved.join('\n') + '\n';
    try { await files.write(`${batch}/MOVED.txt`, text); } catch { /* the list is only a note */ }
  }
  return { ok: !failed.length, batch, moved, failed };
}

// a short text for the failed ones: the usual reason is a running 1.x program (it holds its files)
export const explain = failed => failed.slice(0, 5).map(f => `${f.path}: ${f.error}`).join('\n');
