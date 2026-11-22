// What the boxes of a control center have in common (a translation window: pane.js; a web window: webpane.js): a box with a place (`rect`: the text area, in the pixels of the page; the bar
// stands above it), moved and made bigger by the mouse.
export const BAR_H = 22;
export const MIN_W = 120, MIN_H = 60;                                  // (the smallest text area: as in 3.1.1)

// A drag on `target` (the bar, an edge, the corner): `fn(start, dx, dy)` changes owner.rect, the box is drawn again and the center is told; at the end the place is saved. `accept(event)`: may it start;
// `flag`: a name on the owner that is true while it lasts ("resizing").
export function dragFrame(owner, target, fn, accept = () => true, flag = '') {
  target.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !accept(e)) return;
    target.setPointerCapture(e.pointerId);
    if (flag) { owner[flag] = true; owner.center.changed(owner); }
    const s = { ...owner.rect, px: e.clientX, py: e.clientY };
    const move = m => { fn(s, m.clientX - s.px, m.clientY - s.py); owner.layout(); owner.center.changed(owner); };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); if (flag) owner[flag] = false; owner.save(); owner.center.changed(owner); };
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
