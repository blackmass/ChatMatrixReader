import { check, eq } from './helpers.mjs';
import * as w from '../app/core/winlayout.js';
for (const [t, want] of [['520x260+80+80', { w: 520, h: 260, x: 80, y: 80 }], ['520x260', { w: 520, h: 260, x: null, y: null }], ['420x300+-5+10', { w: 420, h: 300, x: -5, y: 10 }],
  ['420x300-5-10', { w: 420, h: 300, x: -5, y: -10 }], ['', null], ['abc', null], ['10x10+5', null], [undefined, null]]) eq(w.parseGeometry(t), want, 'parse ' + t);
eq(w.formatGeometry(520, 260.4, -5, 10), '520x260+-5+10', 'format');
eq(w.parseGeometry(w.formatGeometry(1, 2, -3, -4)), { w: 1, h: 2, x: -3, y: -4 }, 'round trip with negative places');
eq(w.cascade([100, 50, 500, 300], 2), [172, 122], 'cascade'); eq(w.cascade(null, 1), [116, 116], 'cascade without a main window');
eq([w.labelOf(1), w.labelOf(2), w.labelOf(7), w.widOf('main'), w.widOf('win7'), w.widOf('win'), w.widOf('input')], ['main', 'win2', 'win7', 1, 7, 0, 0], 'labels');
check(w.wantedOpen({ id: 3, open_mode: 'always' }, new Set()) && !w.wantedOpen({ id: 3, open_mode: 'never' }, new Set()) && w.wantedOpen({ id: 3, open_mode: 'never' }, new Set([3])), 'open modes');
