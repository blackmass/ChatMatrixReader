// How long the periodic jobs of the program take. A job reports each run (add(name, ms)); a page sends the totals of the last seconds to the
// options window ('perf' event, started by report()), which shows runs per second, time per run and the share of time spent.
const stats = new Map();                  // name -> { n, ms, max }
let since = typeof performance !== 'undefined' ? performance.now() : 0;

export function add(name, ms) {
  let s = stats.get(name);
  if (!s) stats.set(name, s = { n: 0, ms: 0, max: 0 });
  s.n++; s.ms += ms; if (ms > s.max) s.max = ms;
}

// wraps a function (sync or async) so that every call is measured under `name`
export function timed(name, fn) {
  return (...args) => {
    const t0 = performance.now();
    const done = () => add(name, performance.now() - t0);
    let r;
    try { r = fn(...args); } catch (e) { done(); throw e; }
    if (r && typeof r.then === 'function') return r.finally(done);
    done(); return r;
  };
}

// the totals since the last call, and a new start
export function take() {
  const now = performance.now(), secs = Math.max(0.001, (now - since) / 1000);
  const out = {}; for (const [k, v] of stats) out[k] = { ...v };
  stats.clear(); since = now;
  return { secs, stats: out };
}

// a page tells the options window every few seconds (only when something ran)
export function report(label, emit, everyMs = 2000) {
  return setInterval(() => { const t = take(); if (Object.keys(t.stats).length) emit('perf', { label, secs: t.secs, stats: t.stats }); }, everyMs);
}
