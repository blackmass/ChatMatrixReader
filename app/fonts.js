// Fonts the user put into the fonts/ folder (next to app/). The exe serves them as <the page's address>/fonts/<file> (http://cmr.localhost/ on Windows, cmr://localhost/ on macOS). A font is used by the
// FAMILY NAME written inside the file (the "name" table: "Nanum Gothic"), the same name Windows shows for an installed font; when the file
// has none that can be read, the file name without its ending is used. Fonts installed in Windows need no file: the exe lists them
// (system_fonts) and their name can be picked or typed in the options.
import { files } from './fs.js';
import { familyFromSfnt, repairedLoca, cleanFont } from './core/sfnt.js';
import { tr } from './core/i18n.js';

const EXT = /\.(ttf|otf|ttc|woff2?)$/i;

export const known = [];                       // [{ family, file }] found by the last loadAll
export const failed = [];                      // [{ file, error }] files that could not be read / used by the last loadAll
export const report = [];                      // what was registered (for the log)
export let system = [];                        // the fonts installed in Windows (listForOptions)
const info = new Map();                        // file -> { family, buf }
const registered = new Set();

export const familyOf = file => file.replace(EXT, '');

async function read(file) {
  if (info.has(file)) return info.get(file);
  let buf = null, error = '';
  try { const r = await fetch(new URL('/fonts/' + encodeURIComponent(file), location.href)); if (r.ok) buf = await r.arrayBuffer(); else error = 'HTTP ' + r.status; } catch (e) { error = String(e?.message || e); }
  const entry = { family: (buf && !/\.woff2?$/i.test(file) && familyFromSfnt(buf)) || familyOf(file), buf, error };
  if (buf) info.set(file, entry);
  return entry;
}

// what the file looks like from outside (for the log when the browser refuses it): the format tag, the number of tables, the size
function describe(buf) {
  try {
    const v = new DataView(buf), tag = String.fromCharCode(...new Uint8Array(buf, 0, 4)).replace(/[^\x20-\x7e]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    const n = v.getUint16(4), tables = [];
    for (let i = 0; i < Math.min(n, 40); i++) tables.push(String.fromCharCode(...new Uint8Array(buf, 12 + i * 16, 4)));
    return `tag ${tag}, ${n} tables: ${tables.join(' ')}, ${buf.byteLength} bytes`;
  } catch { return `${buf.byteLength} bytes`; }
}

// reads the folder; with `register` the fonts are made known to the page too. Resolves with the family names.
export async function loadAll({ register = true } = {}) {
  let list = [];
  try { list = (await files.list('fonts')).filter(f => EXT.test(f) && !/["\\]/.test(f)); } catch { /* no fonts folder */ }
  known.length = 0; failed.length = 0; report.length = 0;
  for (const file of list) {
    const e = await read(file);
    known.push({ family: e.family, file });
    if (!e.buf) { failed.push({ file, error: e.error }); continue; }
    if (!register || registered.has(file)) continue;
    // The browser refuses a whole font when one of its tables is odd, and the game's old fonts have such tables. So: the file as it is; if that is refused,
    // the font put together again from the parts that matter (core/sfnt.js cleanFont), with its hinting and, if that is refused too, without it.
    const fixed = repairedLoca(e.buf);                                   // (a glyph index that points outside 'glyf': old fonts)
    const base = fixed || e.buf;
    let lastErr = null, done = false;
    for (const [how, make] of [['', () => e.buf], ['index table repaired', () => fixed], ['rebuilt', () => cleanFont(base)], ['rebuilt, without hinting', () => cleanFont(base, { hinting: false })]]) {
      const buf = make();
      if (!buf) continue;
      try {
        document.fonts.add(await new FontFace(e.family, buf.slice(0)).load()); registered.add(file); done = true;
        report.push(`${e.family} <- ${file} (${buf.byteLength} bytes${how ? ', ' + how : ''})`);
        break;
      } catch (err) { lastErr = err; }
    }
    if (!done) failed.push({ file, error: `${lastErr?.message || lastErr} [${describe(e.buf)}]` });
  }
  return known.map(k => k.family);
}

// the options window: the files of the folder (the family and the file name) and the fonts of Windows
export async function listForOptions() {
  await loadAll({ register: false });
  try { system = await window.__TAURI__.core.invoke('system_fonts'); } catch { system = []; }
}
export function choices() {
  const seen = new Set(), out = [];
  for (const k of known) { out.push([k.family, `${k.family}  —  ${k.file}`]); seen.add(k.family); }
  const rest = system.filter(n => !seen.has(n));
  if (out.length && rest.length) out.push(['-', '────────── ' + tr('윈도우에 설치된 글꼴')]);       // (a line between the two lists; cannot be picked)
  out.push(...rest);
  return out;
}
