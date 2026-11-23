// Where a window of the hub's making (the mini browser, the web window of a plugin) goes when it has no saved place: the middle of the work area of the main screen (the same as the
// windows of the centers: core/winlayout.js firstPlace), a step further when a window that has a saved place stands there. null = not known (webwin.rs then centers it itself).
import { firstPlace, parseGeometry } from './winlayout.js';

export async function newWindowPlace({ invoke, cfg }, w, h, top) {
  let lay = null;
  try { lay = await invoke('center_layout'); } catch { return null; }
  const area = lay && ((lay.work && lay.work[0]) || (lay.monitors && lay.monitors[0]));
  if (!Array.isArray(area) || area.length < 4) return null;
  const c = (cfg && cfg()) || {};
  const taken = [c.geometry, ...(c.child_windows || []).map(x => x && x.geometry), ...(c.browser_windows || []).map(x => x && x.geometry)].map(parseGeometry).filter(g => g && g.x !== null);
  const [x, y] = firstPlace({ w, h }, area, taken, top);
  return Number.isFinite(x) && Number.isFinite(y) ? [Math.round(x), Math.round(y)] : null;
}
