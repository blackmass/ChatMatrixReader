// The settings of the program (config.json) for a page. ONE window owns the file and writes it (the "control" window, today's test
// window): it calls load() and set(). Every other window calls load({ readOnly: true }) and gets the changes as 'cfg' events.
import { files } from './fs.js';
import { ConfigStore } from './core/config.js';
import { T, applyTuning } from './core/timings.js';

const { emit, listen } = window.__TAURI__.event;
const label = window.__TAURI__.window.getCurrentWindow().label;
export let store = null;
const subs = new Set();
let timer = null;

export const cfg = () => store.cfg;
export const onChange = fn => { subs.add(fn); return () => subs.delete(fn); };

export async function load({ readOnly = false } = {}) {
  store = new ConfigStore(files, { readOnly });
  await store.load();
  applyTuning(store.cfg.tuning);
  await listen('cfg', ev => {
    if (ev.payload.from === label) return;
    store.cfg = ev.payload.cfg;
    applyTuning(store.cfg.tuning);
    subs.forEach(f => f(store.cfg));
  });
  return store.cfg;
}

// write what is waiting now (before the program ends)
export async function flush() {
  clearTimeout(timer); timer = null;
  try { await store.save(); } catch { /* the next start has the older file */ }
}

// change settings (the owner window only): saved a moment later, and every window is told
export function set(patch) {
  Object.assign(store.cfg, patch);
  applyTuning(store.cfg.tuning);
  clearTimeout(timer);
  timer = setTimeout(() => store.save(), T.CONFIG_SAVE_MS);
  emit('cfg', { from: label, cfg: store.cfg });
  subs.forEach(f => f(store.cfg));
}

// the same for a read-only window (the options window): the change is shown at once here and asked of the hub, which saves it and tells
// every window ('cfg')
export function request(patch) {
  Object.assign(store.cfg, patch);
  applyTuning(store.cfg.tuning);
  emit('cfg-patch', { patch });
  subs.forEach(f => f(store.cfg));
}
