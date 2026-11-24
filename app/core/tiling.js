// Laying a window on its monitor (3.2.1): the whole of it, a half, a quarter. Pure: the pieces of a work area. (frame.js puts a window there; the menu is ctxmenu.js)
export const TILES = ['full', 'top', 'bottom', 'left', 'right', 'tl', 'tr', 'bl', 'br'];

// The part of the area [x, y, w, h] (any unit) that a tile takes -> [x, y, w, h]. The halves are whole numbers that add up to the area (no gap and no overlap between two neighbours).
export function tileOf(kind, a) {
  const [x, y, w, h] = a, hw = Math.floor(w / 2), hh = Math.floor(h / 2);
  switch (kind) {
    case 'top': return [x, y, w, hh];
    case 'bottom': return [x, y + hh, w, h - hh];
    case 'left': return [x, y, hw, h];
    case 'right': return [x + hw, y, w - hw, h];
    case 'tl': return [x, y, hw, hh];
    case 'tr': return [x + hw, y, w - hw, hh];
    case 'bl': return [x, y + hh, hw, h - hh];
    case 'br': return [x + hw, y + hh, w - hw, h - hh];
    default: return [x, y, w, h];
  }
}
// The text area of a window that fills a tile: its bar is the first `head` of the tile (the bar stays at the top of the tile, the text is below it).
export const textAreaOf = (tile, head) => [tile[0], tile[1] + head, tile[2], Math.max(1, tile[3] - head)];
