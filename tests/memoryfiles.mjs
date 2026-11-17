// The files API of app/fs.js on a plain Map, for tests of the core (same paths rules: relative, no "..", no ":").
export function memoryFiles(initial = {}) {
  const data = new Map(Object.entries(initial));
  const clean = p => {
    const parts = String(p).replace(/\\/g, '/').split('/').filter(x => x && x !== '.');
    if (parts.some(x => x === '..' || x.includes(':'))) throw new Error('path not allowed: ' + p);
    return parts.join('/');
  };
  return {
    data,
    async read(p) { return data.has(clean(p)) ? data.get(clean(p)) : null; },
    async write(p, t) { data.set(clean(p), t); },
    async append(p, t) { data.set(clean(p), (data.get(clean(p)) || '') + t); },
    async kind(p) { const c = clean(p); if (data.has(c)) return 'file'; return [...data.keys()].some(k => c === '' || k.startsWith(c + '/')) ? 'dir' : ''; },
    async list(p) {
      const c = clean(p), pre = c ? c + '/' : '', out = new Set();
      for (const k of data.keys()) if (k.startsWith(pre)) { const rest = k.slice(pre.length), i = rest.indexOf('/'); out.add(i < 0 ? rest : rest.slice(0, i + 1)); }
      return [...out].sort();
    },
    async mkdir() {},
    async remove(p) { data.delete(clean(p)); },
  };
}
