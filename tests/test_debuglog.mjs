// The areas of the detailed log: all off by default, what a file holds is made right, the keys that are on are told to the exe.
import { check } from './helpers.mjs';
import * as D from '../app/core/debuglog.js';
import { normalize } from '../app/core/config.js';

check(D.AREAS.length >= 3 && D.AREAS.every(a => /^[a-z0-9_]{1,32}$/.test(a.key) && a.label && a.note), 'debuglog: every area has a key the exe accepts, a label and a note');
check(new Set(D.AREAS.map(a => a.key)).size === D.AREAS.length, 'debuglog: the keys are different');
check(Object.values(D.defaults()).every(v => v === false) && Object.keys(D.defaults()).length === D.AREAS.length, 'debuglog: all areas are off by default');
check(JSON.stringify(D.normalize(null)) === JSON.stringify(D.defaults()) && JSON.stringify(D.normalize([1])) === JSON.stringify(D.defaults()) && JSON.stringify(D.normalize('x')) === JSON.stringify(D.defaults()), 'debuglog: something that is not an object is all off');
{
  const n = D.normalize({ blur: true, order: 1, web: 'yes', nothing: true });
  check(n.blur === true && n.order === false && n.web === false && !('nothing' in n), 'debuglog: only a true turns an area on, an unknown key is dropped');
}
check(D.enabled({ debug_log: { blur: true, web: true } }).join() === 'blur,web' && D.enabled({}).length === 0 && D.enabled(null).length === 0, 'debuglog: the keys that are on');
check(normalize({}).debug_log.blur === false && normalize({ debug_log: { blur: true } }).debug_log.blur === true, 'debuglog: the settings carry it');
