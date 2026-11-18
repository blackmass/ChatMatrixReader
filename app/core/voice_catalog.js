// What the voice extension downloads, and where each file goes (all inside extensions/stt/). Fixed in the program: a download list is not
// something a web page or a config value can change; the only way in is the file extensions/stt/catalog.json that a person puts there by hand
// (for trying other builds / mirrors; format at the bottom).
//
//   engine = one or more files in extensions/stt/engine-<kind>/ ; the one that is started is exeName(kind)  (cmr-stt.exe; the Mac engine 'metal': cmr-stt)
//   model  = one file extensions/stt/models/ggml-<name>.bin
//
// sha256: '' = not checked (the size the server announces is still checked). The engine addresses stay empty until the engine builds are
// published (GitHub Actions of this repository); an engine without address says so instead of downloading.
export const FOLDER = 'extensions/stt';
export const exeName = kind => (kind === 'metal' ? 'cmr-stt' : 'cmr-stt.exe');
export const CATALOG_FILE = FOLDER + '/catalog.json';

const MODEL_URL = n => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${n}.bin`;
// mb = about how big (shown before the download; the real size comes from the server)
export const BUILTIN = {
  // <engine-files> written by tools/engine_release.py when an engine is released (empty until then: the engine buttons say it is not up yet)
  engines: { cpu: { files: [] }, vulkan: { files: [] }, cuda: { files: [] }, metal: { files: [] } },
  // </engine-files>
  models: {
    tiny: { url: MODEL_URL('tiny'), sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', mb: 75 },
    base: { url: MODEL_URL('base'), sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', mb: 142 },
    small: { url: MODEL_URL('small'), sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', mb: 466 },
    medium: { url: MODEL_URL('medium'), sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208', mb: 1500 },
    'large-v3': { url: MODEL_URL('large-v3'), sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2', mb: 3100 },
    'large-v3-turbo': { url: MODEL_URL('large-v3-turbo'), sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69', mb: 1600 },
  },
};

export const engineDir = kind => `${FOLDER}/engine-${kind}`;
export const exePath = kind => `${engineDir(kind)}/${exeName(kind)}`;
export const modelPath = name => `${FOLDER}/models/ggml-${name}.bin`;

const okUrl = u => typeof u === 'string' && /^https?:\/\/[^\s]+$/.test(u);
const okName = n => typeof n === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(n) && !n.startsWith('.');
const okSha = s => s === undefined || s === '' || (typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s));

// catalog.json: { "engines": { "cpu": { "files": [ { "name": "cmr-stt.exe", "url": "https://...", "sha256": "..." } ] } },
//                 "models": { "small": { "url": "https://...", "sha256": "..." } } }
// -> the built-in lists with the entries of the file put over them; a wrong entry is left out (and named in `problems`).
export function mergeCatalog(overrideText) {
  const out = { engines: {}, models: {}, problems: [] };
  for (const k of Object.keys(BUILTIN.engines)) out.engines[k] = { files: BUILTIN.engines[k].files.slice() };
  for (const k of Object.keys(BUILTIN.models)) out.models[k] = { ...BUILTIN.models[k] };
  if (!overrideText) return out;
  let o;
  try { o = JSON.parse(overrideText); } catch (e) { out.problems.push('catalog.json: ' + e.message); return out; }
  for (const [kind, e] of Object.entries((o && o.engines) || {})) {
    if (!(kind in out.engines)) { out.problems.push('engine ' + kind); continue; }
    const list = Array.isArray(e && e.files) ? e.files : null;
    if (!list || !list.every(f => f && okName(f.name) && okUrl(f.url) && okSha(f.sha256))) { out.problems.push('engine ' + kind); continue; }
    out.engines[kind] = { files: list.map(f => ({ name: f.name, url: f.url, sha256: (f.sha256 || '').toLowerCase() })) };
  }
  for (const [name, m] of Object.entries((o && o.models) || {})) {
    if (!okName(name) || !m || !okUrl(m.url) || !okSha(m.sha256)) { out.problems.push('model ' + name); continue; }
    out.models[name] = { url: m.url, sha256: (m.sha256 || '').toLowerCase(), mb: Number(m.mb) || 0 };
  }
  return out;
}
