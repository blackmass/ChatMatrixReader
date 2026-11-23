import { check, eq } from './helpers.mjs';
import * as w from '../app/core/winlayout.js';
for (const [t, want] of [['520x260+80+80', { w: 520, h: 260, x: 80, y: 80 }], ['520x260', { w: 520, h: 260, x: null, y: null }], ['420x300+-5+10', { w: 420, h: 300, x: -5, y: 10 }],
  ['420x300-5-10', { w: 420, h: 300, x: -5, y: -10 }], ['', null], ['abc', null], ['10x10+5', null], [undefined, null]]) eq(w.parseGeometry(t), want, 'parse ' + t);
eq(w.formatGeometry(520, 260.4, -5, 10), '520x260+-5+10', 'format');
eq(w.parseGeometry(w.formatGeometry(1, 2, -3, -4)), { w: 1, h: 2, x: -3, y: -4 }, 'round trip with negative places');
eq(w.cascade([100, 50, 500, 300], 2), [172, 122], 'cascade'); eq(w.cascade(null, 1), [116, 116], 'cascade without a main window');
eq([w.labelOf(1), w.labelOf(2), w.labelOf(7), w.widOf('main'), w.widOf('win7'), w.widOf('win'), w.widOf('input')], ['main', 'win2', 'win7', 1, 7, 0, 0], 'labels');
check(w.wantedOpen({ id: 3, open_mode: 'always' }, new Set()) && !w.wantedOpen({ id: 3, open_mode: 'never' }, new Set()) && w.wantedOpen({ id: 3, open_mode: 'never' }, new Set([3])), 'open modes');
// the first place of a window: the middle of the work area (the menu bar is not in it), a step further when one stands there, never out of the area
{
  const area = [0, 38, 1440, 862];                                           // (a Mac: the menu bar is the first 38 pixels)
  eq(w.firstPlace({ w: 360, h: 640 }, area, [], 44), [540, 149], 'the middle of the work area');
  eq(w.firstPlace({ w: 360, h: 640 }, area, [{ x: 540, y: 149 }], 44), [576, 185], 'a step further when a window stands there');
  eq(w.firstPlace({ w: 360, h: 640 }, area, [{ x: 540, y: 149 }, { x: 576, y: 185 }, { x: null, y: null }], 44), [612, 221], 'and again');
  eq(w.firstPlace({ w: 360, h: 640 }, area, [{ x: 100, y: 100 }], 44), [540, 149], 'a window that is elsewhere does not matter');
  eq(w.firstPlace({ w: 960, h: 900 }, area, [], 44), [240, 82], 'a window that is too tall: below the menu bar and its own bar, as far up as it can');
  eq(w.firstPlace({ w: 2000, h: 500 }, area, [], 44), [0, 219], 'a window wider than the screen: at the left edge');
  const crowd = []; for (let i = 0; i < 60; i++) crowd.push({ x: 540 + 36 * i, y: 149 + 36 * i });
  eq(w.firstPlace({ w: 360, h: 640 }, area, crowd, 44), [540, 149], 'no room for another step: the middle again');
}
