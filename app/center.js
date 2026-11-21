// A control center (3.2). The page of one of the three transparent windows over all the screens (center.rs): the translation windows of its kind of order (the page says it: ?mode=0
// ordinary, 1 always on top, 2 above the game only) are panes in it (pane.js). The data comes from the hub exactly as it comes to a window of 3.1.1 ('feed', 'feed-replay').
import * as settings from './settings.js';
import { startI18n } from './i18n_host.js';
import { MAIN } from './core/pipeline.js';
import * as winconf from './core/winconf.js';
import * as fonts from './fonts.js';
import { Pane } from './pane.js';

const q = new URLSearchParams(location.search), mode = Number(q.get('mode')) || 0, ox = Number(q.get('ox')) || 0, oy = Number(q.get('oy')) || 0;
const label = 'center' + mode;
let cfg = await settings.load({ readOnly: true });
await startI18n(settings);
await fonts.loadAll().catch(() => []);
document.title = 'CMR Center ' + mode;

const panes = new Map();                       // window id -> Pane
let open = new Set([MAIN]);
const center = {
  cfg: () => cfg,
  dpr: () => window.devicePixelRatio || 1,
  origin: () => [ox, oy],
  changed: () => report(),
};
// the kind of order a window has now (settings: "항상 위", "와우 위에서만")
const optOf = (id, key, d) => (id === MAIN ? (cfg[winconf.MAIN_KEY[key] || key] ?? d) : winconf.opt(cfg.child_windows.find(c => c.id === id) || null, cfg, key, d));
const modeOf = id => (optOf(id, 'topmost_wow_only', false) ? 2 : optOf(id, 'topmost', true) ? 1 : 0);

function sync() {
  const want = new Set([...open].filter(id => (id === MAIN || cfg.child_windows.some(c => c.id === id && c.kind !== 'web')) && !winconf.dockHost(cfg.child_windows, id) && modeOf(id) === mode));
  for (const id of want) if (!panes.has(id)) { const p = new Pane(id, center); panes.set(id, p); emit('feed-hello', { label: p.label }); }
  for (const [id, p] of [...panes]) if (!want.has(id)) { p.destroy(); panes.delete(id); }
  report();
}

let lastKey = '';
function report() {
  const list = [...panes.values()].map(p => p.box());
  const key = JSON.stringify(list);
  if (key === lastKey) return;
  lastKey = key;
  invoke('center_rects', { label, panes: list }).catch(() => {});
}

settings.onChange(c => { cfg = c; for (const p of panes.values()) p.update(); sync(); });
await listen('win-state', e => { open = new Set([MAIN, ...(e.payload.open || [])]); sync(); });
await listen('feed', e => { for (const p of panes.values()) p.take(e.payload.seq, e.payload.event, false); });
await listen('feed-replay', e => { for (const p of panes.values()) if (p.label === e.payload.label) p.takeReplay(e.payload.events); });
emit('win-state-hello', {});
sync();
setInterval(report, 1000);
