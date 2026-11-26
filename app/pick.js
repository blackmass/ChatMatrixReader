// The region picker (OCR assist): this window is laid by the exe over one monitor (pick_region_open); the user drags a rectangle. The answer goes out as the event "pick-result":
// { x, y, w, h } in pixels of the screen, or { cancel: true } (Esc, the right button, another window got the focus, or nothing was done for a minute). Then the window closes itself.
import * as settings from './settings.js';
import { startI18n } from './i18n_host.js';
import { tr } from './core/i18n.js';
await settings.load({ readOnly: true });
await startI18n(settings);
const q = new URLSearchParams(location.search);
const ORIGIN = { x: Number(q.get('x')) || 0, y: Number(q.get('y')) || 0 };          // the top left of this monitor in pixels of the screen
const SCALE = Number(q.get('s')) || window.devicePixelRatio || 1;                       // pixels of the screen per css pixel
const MIN = 8;                                                                          // pixels: a smaller rectangle is not a choice (a click)
const $ = id => document.getElementById(id);
const hint = $('hint'), box = $('box'), size = $('size'), veil = $('veil');
hint.textContent = tr('읽을 구역을 마우스로 끌어서 고르세요 (Esc: 취소)');
let from = null, done = false, armed = false;
// The manual capture gives the screen of the game as it was when the capture began ("pick-image": { src, x, y, w, h } in pixels of the screen); it is drawn where the game window is, so that a
// tooltip that has gone since is still there to choose from. The page asks for it when it is ready ("pick-ready"); without it the chosen rectangle is on the live screen.
const shot = $('shot');
listen('pick-image', ev => {
  const p = ev.payload || {};
  if (!p.src) return;
  shot.src = p.src;
  Object.assign(shot.style, { left: (p.x - ORIGIN.x) / SCALE + 'px', top: (p.y - ORIGIN.y) / SCALE + 'px', width: p.w / SCALE + 'px', height: p.h / SCALE + 'px', display: 'block' });
}).then(() => emit('pick-ready', {})).catch(() => {});

const finish = async result => {
  if (done) return;
  done = true;
  try { await emit('pick-result', result); } catch { /* nobody listens */ }
  try { await thisWin.close(); } catch { /* it is going away anyway */ }
};
const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });      // (css pixels)
const draw = r => {
  box.style.display = size.style.display = 'block';
  Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  size.textContent = `${Math.round(r.w * SCALE)} × ${Math.round(r.h * SCALE)}`;
  size.style.left = r.x + 'px'; size.style.top = Math.max(0, r.y - 24) + 'px';
};
veil.addEventListener('pointerdown', e => {
  if (e.button !== 0) { finish({ cancel: true }); return; }
  from = { x: e.clientX, y: e.clientY }; veil.setPointerCapture(e.pointerId); hint.style.display = 'none'; draw({ x: from.x, y: from.y, w: 0, h: 0 });
});
veil.addEventListener('pointermove', e => { if (from) draw(rectOf(from, { x: e.clientX, y: e.clientY })); });
veil.addEventListener('pointerup', e => {
  if (!from) return;
  const r = rectOf(from, { x: e.clientX, y: e.clientY }); from = null;
  const w = Math.round(r.w * SCALE), h = Math.round(r.h * SCALE);
  if (w < MIN || h < MIN) { box.style.display = size.style.display = 'none'; hint.style.display = ''; return; }      // (a click: try again)
  finish({ x: ORIGIN.x + Math.round(r.x * SCALE), y: ORIGIN.y + Math.round(r.y * SCALE), w, h });
});
window.addEventListener('keydown', e => { if (e.key === 'Escape') finish({ cancel: true }); });
window.addEventListener('contextmenu', e => { e.preventDefault(); finish({ cancel: true }); });
window.addEventListener('focus', () => { armed = true; });
window.addEventListener('blur', () => { if (armed) setTimeout(() => { if (!document.hasFocus()) finish({ cancel: true }); }, 300); });      // (another window got the focus: do not stay over the screen)
setTimeout(() => finish({ cancel: true }), 60000);
