// Look up the newest GitHub release and compare version numbers. It only reads one small JSON document: nothing is downloaded or
// installed. Port of updatecheck.py.
import { MAJOR, LATEST_API } from './version.js';

const TAG = /^[vV]?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?$/;

// 'v1.2.0' / '1.2' -> [1, 2, 0]; null if it does not look like a version number
export function parse(tag) {
  const m = TAG.exec(String(tag || '').trim());
  return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
}
export const fmt = v => `v${v[0]}.${v[1]}.${v[2]}`;
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  return !!(a && b && cmp(a, b) > 0);
}

// -> 'v3.0.2': the newest release tag OF THIS MAJOR VERSION (a 3.x program does not announce 4.0). Drafts and pre-releases are skipped.
// http: makeHttp(transport). Throws when nothing fits.
export async function fetchLatest(http, { url = LATEST_API, timeout = 5, major = MAJOR } = {}) {
  const data = await http.json(url, null, { Accept: 'application/vnd.github+json' }, timeout);
  const items = Array.isArray(data) ? data : [data];
  let best = null; const seen = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || it.draft || it.prerelease) continue;
    const v = parse(typeof it.tag_name === 'string' ? it.tag_name : '');
    if (!v) { seen.push(String(it.tag_name).slice(0, 40)); continue; }
    if (v[0] === major && (best === null || cmp(v, best) > 0)) best = v;
  }
  if (best === null) throw new Error(`no release of version ${major}.x found (tags seen: ${JSON.stringify(seen.slice(0, 3))})`);
  return fmt(best);
}
