// The right-click menu in one shape. ctxmenu.js gives a list of lines { text, fn, cls, sub } ('sep' a line, 'off' grey and does nothing, 'on' has a tick, `sub` a list of lines);
// a menu that the system draws (a window of the system: main.rs native_menu) cannot hold functions, so the list becomes a plain spec - [{ kind: 'item' | 'check' | 'sep' | 'sub', id, text, enabled,
// checked, items }] - and the functions wait here, by `id`, until the exe says which line was chosen. This is the ONLY place that knows both shapes: a new line is added to the list in ctxmenu.js
// and it shows in the menu of the page (center.js openDomMenu) and in the menu of the system alike.
export function toSpec(list, handlers = new Map(), seq = { n: 0 }) {
  const out = [];
  for (const e of list) {
    const cls = String(e.cls || '').split(/\s+/);
    if (cls.includes('sep')) { if (out.length && out[out.length - 1].kind !== 'sep') out.push({ kind: 'sep' }); continue; }       // (no line first, none twice)
    const off = cls.includes('off');
    if (e.sub) { out.push({ kind: 'sub', text: String(e.text ?? ''), enabled: !off, items: toSpec(e.sub, handlers, seq) }); continue; }
    const id = ++seq.n, live = !off && typeof e.fn === 'function';
    if (live) handlers.set(id, e.fn);
    out.push({ kind: cls.includes('on') ? 'check' : 'item', id, text: String(e.text ?? ''), enabled: live, checked: cls.includes('on') });
  }
  while (out.length && out[out.length - 1].kind === 'sep') out.pop();                                                  // (none last)
  return out;
}
