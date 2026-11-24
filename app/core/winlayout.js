// Where windows are: the geometry text of the settings ("520x260+80+80") and the places of new windows. Port of the helpers of winview.py.
// Sizes and places are real screen pixels.
const GEO = /^(\d+)x(\d+)(?:([+-])(-?\d+)([+-])(-?\d+))?$/;
export const CASCADE = 36;
export const DEFAULT_SIZE = [420, 300];

// -> { w, h, x, y } (x and y are null when the text has no place), or null when it is no geometry
export function parseGeometry(text) {
  const m = GEO.exec(String(text || '').trim());
  if (!m) return null;
  const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  if (m[3] === undefined) return { w, h, x: null, y: null };
  let x = parseInt(m[4], 10), y = parseInt(m[6], 10);
  if (m[3] === '-' && x >= 0) x = -x;
  if (m[5] === '-' && y >= 0) y = -y;
  return { w, h, x, y };
}

export const formatGeometry = (w, h, x, y) => `${Math.round(w)}x${Math.round(h)}+${Math.round(x)}+${Math.round(y)}`;

// the place of a window that has none saved: next to the main window, a little lower and to the right each time
export function cascade(mainRect, n) {
  const [x, y] = mainRect ? [mainRect[0], mainRect[1]] : [80, 80];
  return [x + CASCADE * n, y + CASCADE * n];
}

// where a window with no saved place first appears: the middle of the work area of the main screen (what the menu bar, the dock or the task bar leave), `top` pixels of it kept free
// above for the bar that stands over the window. When a window already stands there (`taken`: [{ x, y }], the upper left corners), the next one is a step lower and to the right.
export function firstPlace(size, area, taken = [], top = 0) {
  const [ax, ay, aw, ah] = area, { w, h } = size;
  const fit = (x, y) => x + w <= ax + aw && y + h <= ay + ah;
  const x0 = Math.max(ax, Math.min(Math.round(ax + (aw - w) / 2), ax + aw - w)), y0 = Math.max(ay + top, Math.min(Math.round(ay + (ah - h) / 2), ay + ah - h));
  const busy = (x, y) => taken.some(t => t && Number.isFinite(t.x) && Number.isFinite(t.y) && Math.abs(t.x - x) < CASCADE && Math.abs(t.y - y) < CASCADE);
  for (let k = 0; k < 40; k++) {
    const x = x0 + k * CASCADE, y = y0 + k * CASCADE;
    if (k && !fit(x, y)) break;
    if (!busy(x, y)) return [x, y];
  }
  return [x0, y0];                                    // (no room for one more step: the middle again)
}

// Does a window that may be click-through take the mouse now? (a window of the web: webpane.js; a translation window has the same rule with its own details: pane.js tick)
// through: the user chose it; held: the interact keys are held; inside: the pointer is over the window; game: a game is there (no game: nothing to click through to);
// drag: a button went down on the window while it took the mouse, and is still down (a drag that leaves the window is not cut off)
export const takesMouse = ({ through, held, inside, game = true, drag = false }) => !through || (held && inside) || !game || !!drag;

export const MAIN_LABEL = 'main';
export const labelOf = wid => (wid === 1 ? MAIN_LABEL : `win${wid}`);
export const widOf = label => (label === MAIN_LABEL ? 1 : (/^win(\d+)$/.exec(label) ? parseInt(RegExp.$1, 10) : 0));

// should the window of this conf be open? What the user does with a window (the X, opening it by hand) is only for now and never changes the settings:
// `manual`: ids the user opened by hand; `voiceOn`: the voice recognition is on (starting or running); `dismissed`: ids the user closed with the X while the
// setting wants them open ("프로그램을 켤 때 항상" until the program is started again, "음성 인식을 켤 때만" until the voice recognition is turned off or on)
export const wantedOpen = (conf, manual, voiceOn = false, dismissed = new Set()) =>
  manual.has(conf.id) || ((conf.open_mode === 'always' || (conf.open_mode === 'voice' && voiceOn)) && !dismissed.has(conf.id));
