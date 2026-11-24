// What the boxes of a control center have in common (a translation window: pane.js; a web window: webpane.js): a box with a place (`rect`: the text area, in the pixels of the page; the bar
// stands above it), moved and made bigger by the mouse.
import { T } from './core/timings.js';

export const BAR_H = 22;
// The Alt key lets a window go over the edge of a monitor without the resistance. It is built, not on: nobody asked for it yet (to turn it on: true).
export const EDGE_ALT_BYPASS = false;
export const MIN_W = 120, MIN_H = 60;                                  // (the smallest text area: as in 3.1.1)

// A drag on `target` (the bar, an edge, the corner): `fn(start, dx, dy)` changes owner.rect, the box is drawn again and the center is told; at the end the place is saved. `accept(event)`: may it start;
// `flag`: a name on the owner that is true while it lasts ("resizing").
export function dragFrame(owner, target, fn, accept = () => true, flag = '') {
  target.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !accept(e)) return;
    target.setPointerCapture(e.pointerId);
    if (flag) { owner[flag] = true; owner.center.changed(owner); }
    const s = { ...owner.rect, px: e.clientX, py: e.clientY };
    const move = m => { fn(s, m.clientX - s.px, m.clientY - s.py, m); owner.layout(); owner.center.changed(owner); };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); if (flag) owner[flag] = false; settle(owner); owner.layout(); owner.save(); owner.center.changed(owner); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
  });
}

// The edges and the corner that resize a box (the elements `.pgrip`, `.e-l`, `.e-r`, `.e-b`, `.e-bl` in its element): the left side moves the box, so the other side stays.
export function sizeEdges(owner, accept, [minW, minH] = [MIN_W, MIN_H]) {
  const q = s => owner.el.querySelector(s), r = () => owner.rect;
  const sizes = { '.pgrip': (s, dx, dy) => { r().w = Math.max(minW, s.w + dx); r().h = Math.max(minH, s.h + dy); },
    '.e-r': (s, dx) => { r().w = Math.max(minW, s.w + dx); },
    '.e-b': (s, dx, dy) => { r().h = Math.max(minH, s.h + dy); },
    '.e-l': (s, dx) => { r().w = Math.max(minW, s.w - dx); r().x = s.x + (s.w - r().w); },
    '.e-bl': (s, dx, dy) => { r().w = Math.max(minW, s.w - dx); r().x = s.x + (s.w - r().w); r().h = Math.max(minH, s.h + dy); } };
  for (const [sel, fn] of Object.entries(sizes)) dragFrame(owner, q(sel), fn, accept, 'resizing');
}

// ---- where a box may stand: the monitors, the side of its bar, the resistance at the edge of a monitor
// (the monitors are the center's list: [[x, y, w, h], ...] in screen pixels; a box has `rect` (the text area, in css pixels of the page), `head` (the height of its bar) and `flip` (the bar is BELOW)).
const physical = o => { const [ox, oy] = o.center.origin(), d = o.center.dpr(), r = o.rect; return { x: ox + r.x * d, y: oy + r.y * d, w: r.w * d, h: r.h * d }; };
const containing = (mons, x, y) => mons.find(m => x >= m[0] && x < m[0] + m[2] && y >= m[1] && y < m[1] + m[3]);
const fullyIn = (m, p) => p.x >= m[0] - 0.5 && p.y >= m[1] - 0.5 && p.x + p.w <= m[0] + m[2] + 0.5 && p.y + p.h <= m[1] + m[3] + 0.5;
export function monitorOf(mons, p) {                                    // the monitor that has the middle of the box; else the one it overlaps most
  const c = containing(mons, p.x + p.w / 2, p.y + p.h / 2); if (c) return c;
  let best = null, most = 0;
  for (const m of mons) {
    const w = Math.min(p.x + p.w, m[0] + m[2]) - Math.max(p.x, m[0]), h = Math.min(p.y + p.h, m[1] + m[3]) - Math.max(p.y, m[1]);
    if (w > 0 && h > 0 && w * h > most) { most = w * h; best = m; }
  }
  return best;
}

// Is the bar of this box below its text? Above when it fits above inside the monitor (the one the box is on); below when it does not (the box touches the top of the monitor) and it fits below.
// Once below it stays until there is 8 pixels more room above (the box does not flip back and forth at the limit).
export function barBelow(o) {
  const mons = o.center.monitors ? o.center.monitors() : [], p = physical(o), d = o.center.dpr(), head = o.head * d, [, oy] = o.center.origin();
  const m = mons.length ? monitorOf(mons, p) : null;
  const top = m ? m[1] : oy, bottom = m ? m[1] + m[3] : oy + innerHeight * d;
  const above = p.y - head >= top - 0.5, below = p.y + p.h + head <= bottom + 0.5;
  if (o.flip) return below ? !(p.y - head >= top + 8 * d) : false;
  return !above && below;
}

// Moving a box by the mouse (`s` is the start of the drag: `fn(start, dx, dy, event)` of dragFrame). In the monitor the box is in, it goes where the mouse takes it, and stops at the edge: the whole text
// area stays on the monitor (the bar goes below when there is no room above). A side that has another monitor next to it is a speed bump: the box stays at the edge until the mouse is more than
// EDGE_STICK_PX beyond it, and then it comes after the mouse (not at once: it eases over). A side with nothing next to it is a wall. A box that is on two monitors (it was put there) moves freely until it is
// wholly on one again.
export function moveBy(o, s, dx, dy, ev) {
  const [ox, oy] = o.center.origin(), d = o.center.dpr(), mons = o.center.monitors ? o.center.monitors() : [];
  const set = A => { o.rect.x = (A.x - ox) / d; o.rect.y = (A.y - oy) / d; };
  const want = { x: ox + (s.x + dx) * d, y: oy + (s.y + dy) * d, w: s.w * d, h: s.h * d };
  const st = s.mv || (s.mv = { init: false, m: null, cur: null, ease: false, raf: 0 });
  st.dx = dx; st.dy = dy;
  if (!mons.length || (EDGE_ALT_BYPASS && ev && ev.altKey)) { set(want); st.cur = null; st.m = null; st.ease = false; return; }
  if (!st.init) {
    st.init = true;
    const start = { x: ox + s.x * d, y: oy + s.y * d, w: s.w * d, h: s.h * d }, m0 = monitorOf(mons, start);
    st.m = m0 && fullyIn(m0, start) ? m0 : null; st.cur = { x: start.x, y: start.y };
  }
  const head = o.head * d;
  let A;
  if (st.m) {
    const m = st.m, left = m[0] - want.x, right = want.x + want.w - (m[0] + m[2]), up = m[1] - want.y, down = want.y + want.h - (m[1] + m[3]);
    let cx = Math.min(Math.max(want.x, m[0]), m[0] + m[2] - want.w), cy = Math.min(Math.max(want.y, m[1]), m[1] + m[3] - want.h);
    if (cy - head < m[1]) cy = Math.min(cy, Math.max(m[1], m[1] + m[3] - want.h - head));          // (the bar goes below: it needs its room there)
    const thr = T.EDGE_STICK_PX * d, mx = want.x + want.w / 2, my = want.y + want.h / 2;
    const next = (px, py) => !!containing(mons, px, py);
    const out = (left > thr && next(m[0] - 3, my)) || (right > thr && next(m[0] + m[2] + 3, my)) || (up > thr && next(mx, m[1] - 3)) || (down > thr && next(mx, m[1] + m[3] + 3));
    if (out) { st.m = null; st.ease = true; A = { ...st.cur }; }
    else A = { x: cx, y: cy };
  }
  if (!st.m) {
    A = A || { ...want };
    if (st.ease && st.cur) {
      A = { x: st.cur.x + (want.x - st.cur.x) * 0.4, y: st.cur.y + (want.y - st.cur.y) * 0.4 };
      if (Math.abs(want.x - A.x) < 1 && Math.abs(want.y - A.y) < 1) { A = { ...want }; st.ease = false; }
      else if (!st.raf && typeof requestAnimationFrame === 'function') st.raf = requestAnimationFrame(() => { st.raf = 0; moveBy(o, s, st.dx, st.dy, ev); o.layout(); o.center.changed(o); });       // (the mouse stood still: it goes on)
    } else {
      const m2 = monitorOf(mons, { ...A, w: want.w, h: want.h });
      if (m2 && fullyIn(m2, { ...A, w: want.w, h: want.h })) st.m = m2;                                // (wholly on a monitor again: it holds there)
    }
  }
  st.cur = A; set(A);
}

// After a move: a box whose middle is on no monitor (it was left in the space between them) is brought into the nearest one.
export function settle(o) {
  const mons = o.center.monitors ? o.center.monitors() : [];
  if (!mons.length) return;
  const p = physical(o), cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  if (containing(mons, cx, cy)) return;
  let best = mons[0], near = Infinity;
  for (const m of mons) { const dx = Math.max(m[0] - cx, 0, cx - (m[0] + m[2])), dy = Math.max(m[1] - cy, 0, cy - (m[1] + m[3])); if (dx * dx + dy * dy < near) { near = dx * dx + dy * dy; best = m; } }
  const [ox, oy] = o.center.origin(), d = o.center.dpr();
  o.rect.x = (Math.min(Math.max(p.x, best[0]), Math.max(best[0], best[0] + best[2] - p.w)) - ox) / d;
  o.rect.y = (Math.min(Math.max(p.y, best[1]), Math.max(best[1], best[1] + best[3] - p.h)) - oy) / d;
}
