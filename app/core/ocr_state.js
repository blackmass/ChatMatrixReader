// The state of the chat window as the addon tells it (a line of the channel "@CS", see addon/ChatMatrix/PROTOCOL.md) -> where the chat window and its strip of bars are
// in the picture of the game window.

// version 1 (an older addon): all of these, and `t`, `session` after them as options. Version 2: FIELDS2 (only what the reader uses), all of them.
const FIELDS = ['version', 'n', 'win', 'left', 'bottom', 'width', 'height', 'side', 'stripX', 'stripW', 'barW', 'barH', 'pitch', 'fontH', 'scroll', 'pw', 'ph', 'mx', 'my', 'mw', 'mh', 'messages', 'shown'];
const FIELDS2 = ['version', 'n', 'left', 'bottom', 'width', 'height', 'stripX', 'stripW', 'barW', 'barH', 'pitch', 'fontH', 'scroll', 'pw', 'ph', 't', 'session'];
// added later at the end of version 1 (an older addon does not send them): t = the count of the messages of the chat window (the number of the newest one), session = a number that
// changes every time the addon is loaded (the numbers t start again)
const OPTIONAL = ['t', 'session'];

// the text of the line -> the state, or null when it is not a state of version 1 or 2
export function parseState(text) {
  const parts = String(text ?? '').trim().split(',');
  const v2 = Number(parts[0]) === 2;
  const names = v2 ? FIELDS2 : FIELDS;
  if (parts.length < names.length) return null;
  const st = {};
  for (let i = 0; i < names.length; i++) {
    const v = Number(parts[i]);
    if (!Number.isFinite(v)) return null;
    st[names[i]] = Math.round(v);
  }
  if (!v2) {
    for (let i = 0; i < OPTIONAL.length; i++) {
      const v = Number(parts[FIELDS.length + i]);
      if (parts[FIELDS.length + i] !== undefined && parts[FIELDS.length + i] !== '' && Number.isFinite(v)) st[OPTIONAL[i]] = Math.round(v);
    }
  }
  if ((st.version !== 1 && st.version !== 2) || st.width <= 0 || st.height <= 0 || st.pitch <= 0 || st.fontH <= 0 || st.fontH > st.pitch || st.pw <= 0 || st.ph <= 0 || st.barW <= 0 || st.barH <= 0) return null;
  return st;
}

// the state + the size of the game window in pixels ({ width, height }) -> the places in the game window's own pixels (y from the top), or null when the sizes do not fit.
// The addon counts in the pixels of the screen it renders to (pw x ph); the window is that size unless the system scales it: then everything is scaled the same way.
// -> { x, y, w, h: the part to grab (the chat window and the strip together), chat: { left, top, width, height } and strip: { x, w } in the pixels of that part,
//      pitch, fontH, barW, barH }
export function regionOf(st, client) {
  if (!st || !client || !(client.width > 0) || !(client.height > 0)) return null;
  const sx = client.width / st.pw, sy = client.height / st.ph;
  if (Math.abs(sx - sy) > 0.02) return null;                                 // (not the same on both sides: not a picture of what the addon draws)
  const s = (sx + sy) / 2, r = v => Math.round(v * s);
  const left = r(st.left), width = r(st.width), height = r(st.height), top = r(st.ph - (st.bottom + st.height));
  const stripX = r(st.stripX), stripW = r(st.stripW);
  const x0 = Math.max(0, Math.min(stripX, left)), x1 = Math.min(client.width, Math.max(left + width, stripX + stripW));
  const y0 = Math.max(0, top), y1 = Math.min(client.height, top + height);
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  const sx0 = Math.max(0, stripX), sx1 = Math.min(client.width, stripX + stripW);
  return {
    x: x0, y: y0, w: x1 - x0, h: y1 - y0,
    chat: { left: left - x0, top: top - y0, width, height },
    strip: { x: sx0 - x0, w: Math.max(1, sx1 - sx0) },
    pitch: Math.max(1, r(st.pitch)), fontH: Math.max(1, r(st.fontH)), barW: Math.max(1, r(st.barW)), barH: Math.max(1, r(st.barH)),
    scale: s,
  };
}
