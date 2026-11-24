// The list of a right-click menu as the plain spec for a menu of the system (core/menuspec.js).
import { check, eq } from './helpers.mjs';
import { toSpec } from '../app/core/menuspec.js';

const hit = [];
const h = new Map();
const spec = toSpec([
  { text: 'a & b', fn: () => hit.push('a') },
  { cls: 'sep' }, { cls: 'sep' },
  { text: 'grey', fn: () => hit.push('x'), cls: 'off' },
  { text: 'ticked', fn: () => hit.push('t'), cls: 'on' },
  { text: 'more', sub: [{ text: 'in', fn: () => hit.push('in') }, { cls: 'sep' }] },
  { cls: 'sep' },
], h);
eq(spec.map(s => s.kind), ['item', 'sep', 'item', 'check', 'sub'], 'menuspec: kinds; a second line and a last line are dropped');
eq(spec[0], { kind: 'item', id: 1, text: 'a & b', enabled: true, checked: false }, 'menuspec: a line');
check(spec[2].enabled === false && !h.has(spec[2].id), 'menuspec: a grey line is disabled and has no function');
check(spec[3].checked === true && spec[3].kind === 'check', 'menuspec: a ticked line');
eq(spec[4].items, [{ kind: 'item', id: 4, text: 'in', enabled: true, checked: false }], 'menuspec: the lines of a sub list, numbered on (the last line is dropped)');
h.get(1)(); h.get(4)(); h.get(spec[3].id)();
eq(hit, ['a', 'in', 't'], 'menuspec: the functions wait by number');
eq(toSpec([{ cls: 'sep' }]), [], 'menuspec: only lines = nothing');
eq(toSpec([{ text: 'no function' }])[0].enabled, false, 'menuspec: a line with nothing to do is disabled');
