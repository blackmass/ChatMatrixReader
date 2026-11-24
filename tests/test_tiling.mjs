// Laying a window on a monitor (3.2.1): the pieces of a work area.
import { check, eq } from './helpers.mjs';
import { TILES, tileOf, textAreaOf } from '../app/core/tiling.js';

const A = [100, 50, 1001, 601];                                           // (odd sizes: the halves must add up, no gap and no overlap)
eq(tileOf('full', A), A, 'tiling: full = the whole area');
eq([tileOf('left', A), tileOf('right', A)], [[100, 50, 500, 601], [600, 50, 501, 601]], 'tiling: the left and the right half add up to the width');
eq([tileOf('top', A), tileOf('bottom', A)], [[100, 50, 1001, 300], [100, 350, 1001, 301]], 'tiling: the top and the bottom half add up to the height');
eq([tileOf('tl', A), tileOf('tr', A), tileOf('bl', A), tileOf('br', A)], [[100, 50, 500, 300], [600, 50, 501, 300], [100, 350, 500, 301], [600, 350, 501, 301]], 'tiling: the quarters');
check(TILES.length === 9 && new Set(TILES).size === 9 && TILES.every(k => tileOf(k, A).every(Number.isInteger)), 'tiling: nine tiles, whole numbers');
for (const k of TILES) { const t = tileOf(k, A); check(t[0] >= A[0] && t[1] >= A[1] && t[0] + t[2] <= A[0] + A[2] && t[1] + t[3] <= A[1] + A[3], 'tiling: ' + k + ' is inside the area'); }
eq(tileOf('nope', A), A, 'tiling: an unknown tile is the whole area');
eq(textAreaOf([0, 100, 400, 300], 22), [0, 122, 400, 278], 'tiling: the bar takes the first part of the tile, the text is below it');
eq(textAreaOf([0, 0, 400, 10], 22)[3], 1, 'tiling: a tile smaller than the bar still has a text area');
