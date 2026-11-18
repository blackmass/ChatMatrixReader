// The display language of a window. The Korean text of the program IS the key (core/i18n.js); other languages are locale/<code>.txt in the
// program folder ("한국어 = English" per line). Two ways a text is translated:
//   * tr('text {n}', { n }) in the code, for texts that are put together while running (and for everything in core/);
//   * every other text of the page (HTML, option rows ...) is translated where it stands in the DOM: a text node or a placeholder / title
//     whose whole text is a key. The Korean original is remembered, so switching the language back and forth works at once.
// Parts of a page that show other people's text (the chat) are marked data-notr: nothing inside is touched.
// Every window: `await startI18n(settings)` once, right after settings.load().
import { files } from './fs.js';
import { parseLocale, setTable, tr, pickLanguage, DEFAULT_LANG, setTextFilter, macKeys } from './core/i18n.js';
import { isMac } from './platform.js';

if (isMac) setTextFilter(macKeys);                      // (every text shown by tr(), also the ones the DOM walker below translates)

const HAN = /[가-힣]/;
const ATTRS = ['placeholder', 'title', 'aria-label'];
const textOrig = new WeakMap();                         // Text node -> { orig, shown }
const attrOrig = new WeakMap();                         // Element -> Map(attr -> { orig, shown })

// [{ code, name }]: Korean first, then every locale/*.txt
export async function languages() {
  const out = [{ code: DEFAULT_LANG, name: `한국어 (${DEFAULT_LANG})` }];
  let names = [];
  try { names = await files.list('locale'); } catch { /* no folder */ }
  for (const n of names.slice().sort()) {
    const m = /^(.+)\.txt$/i.exec(n);
    if (!m || m[1].toLowerCase() === DEFAULT_LANG.toLowerCase()) continue;
    let name = '';
    try { name = parseLocale((await files.read('locale/' + n)) || '').name || ''; } catch { /* unreadable */ }
    out.push({ code: m[1], name: name ? `${name} (${m[1]})` : m[1] });
  }
  return out;
}

// the code in use for the setting `language` ('' = the system language)
export async function resolve(language) {
  return pickLanguage(language, (await languages()).map(l => l.code), navigator.language || '');
}

async function loadTable(code) {
  if (code.toLowerCase() === DEFAULT_LANG.toLowerCase()) return setTable({}, DEFAULT_LANG);
  let text = null;
  for (const n of await files.list('locale').catch(() => [])) if (n.toLowerCase() === (code + '.txt').toLowerCase()) text = await files.read('locale/' + n);
  const { entries } = parseLocale(text || '');
  return setTable(entries, code);
}

// ---------------------------------------------------------------- the DOM
const inNotr = node => { const e = node.nodeType === 1 ? node : node.parentElement; return !!(e && e.closest('[data-notr]')); };
const wrap = (base, key, t) => (t === key ? base : base.slice(0, base.length - base.trimStart().length) + t + base.slice(base.trimEnd().length));

function doText(node) {
  const cur = node.data, rec = textOrig.get(node);
  const base = rec && rec.shown === cur ? rec.orig : cur;
  const key = base.replace(/\s+/g, ' ').trim();
  if (!HAN.test(key) || inNotr(node)) { if (rec) textOrig.delete(node); return; }
  const shown = wrap(base, key, tr(key));
  textOrig.set(node, { orig: base, shown });
  if (shown !== cur) node.data = shown;
}
function doAttr(el, attr) {
  const cur = el.getAttribute(attr);
  if (cur === null) return;
  let m = attrOrig.get(el); if (!m) attrOrig.set(el, m = new Map());
  const rec = m.get(attr), base = rec && rec.shown === cur ? rec.orig : cur;
  const key = base.replace(/\s+/g, ' ').trim();
  if (!HAN.test(key) || inNotr(el)) { m.delete(attr); return; }
  const shown = wrap(base, key, tr(key));
  m.set(attr, { orig: base, shown });
  if (shown !== cur) el.setAttribute(attr, shown);
}
export function translateTree(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1) return;
  for (const a of ATTRS) doAttr(root, a);
  for (const child of root.childNodes) translateTree(child);
}

let observer = null, current = DEFAULT_LANG;
export const currentCode = () => current;

export async function applyLanguage(language) {
  current = await loadTable(await resolve(language));
  translateTree(document.documentElement);
  window.dispatchEvent(new Event('cmr-language'));          // pages that put texts together while running build them again
  return current;
}

export async function startI18n(settings) {
  let shown = settings.cfg().language ?? '';
  await applyLanguage(shown);
  observer = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'characterData') doText(r.target);
      else if (r.type === 'attributes') doAttr(r.target, r.attributeName);
      else for (const n of r.addedNodes) translateTree(n);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  settings.onChange(() => {
    const now = settings.cfg().language ?? '';
    if (now !== shown) { shown = now; applyLanguage(now); }
  });
}
