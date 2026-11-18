import fs from 'node:fs';
import path from 'node:path';
import * as w from '../app/core/winconf.js';
import { HERE, eq } from './helpers.mjs';

for (const [fn, args, want] of JSON.parse(fs.readFileSync(path.join(HERE, 'golden', 'winconf.json'), 'utf8'))) {
  // 3.0 differs from 2.0 here on purpose: "only while the voice recognition is on" can be set for every extra window (2.0 allowed it for window 2 only)
  if (fn === 'normalize' && Array.isArray(args[0]) && args[0].length === 1 && args[0][0] && args[0][0].id === 5 && args[0][0].open_mode === 'voice') want.find(c => c.id === 5).open_mode = 'voice';
  const got = w[fn](...args);
  const no3 = v => { if (Array.isArray(v)) v.forEach(no3); else if (v && typeof v === 'object') delete v.clear_on_open; return v; };       // (3.x only: an extra window can start empty)
  eq(no3(got), want, `${fn}(${JSON.stringify(args)})`);
}

// ---- 3.0: what an extra window can leave empty to follow window 1
import { check } from './helpers.mjs';
const main = { font_family: 'Nanum', font_size: 14, trans_color: '#ff0000', text_align: 'center', head_mode: 'detail', blur: 2, show_time: false, line_spacing: 3 };
const ext = (o = {}) => ({ id: 3, ...o });
check(w.opt(ext(), main, 'font_family', '') === 'Nanum' && w.opt(ext({ font_family: '' }), main, 'font_family', '') === 'Nanum' && w.opt(ext({ font_family: 'Arial' }), main, 'font_family', '') === 'Arial', 'font: empty follows window 1, a name is its own');
check(w.opt(ext({ font_size: 0 }), main, 'font_size', 11) === 14 && w.opt(ext({ font_size: 9 }), main, 'font_size', 11) === 9 && w.opt(ext(), main, 'line_spacing', 0) === 3, 'numbers: 0 (size) / no key follows window 1');
check(w.opt(ext({ trans_color: '' }), main, 'trans_color', '') === '#ff0000' && w.opt(ext({ trans_color: '#00ff00' }), main, 'trans_color', '') === '#00ff00', 'colours: empty follows window 1');
check(w.opt(ext({ align: null }), main, 'align', 'left') === 'center' && w.opt(ext({ align: 'right' }), main, 'align', 'left') === 'right' && w.opt(ext({ blur: null }), main, 'blur', 0) === 2, 'choices: null follows window 1 (its name in the main window is text_align)');
check(w.opt(ext(), main, 'show_time', true) === true && w.opt(ext({ show_time: false }), main, 'show_time', true) === false && w.opt(main, main, 'show_time', true) === false, 'on / off switches do not follow: an extra window without a value has the default, the main window its own');
check(w.headMode(ext({ head_mode: null }), main) === 'detail' && w.headMode(ext({ head_mode: 'body' }), main) === 'body' && w.headMode(ext({})) === 'basic', 'line head: null follows window 1');
const kept = w.normalize([{ id: 3, align: null, head_mode: null, blur: null }]).find(c => c.id === 3);
check(kept.align === null && kept.head_mode === null && kept.blur === null, 'normalize keeps the explicit null of a choice (it follows window 1)');
const old = w.normalize([{ id: 3 }]).find(c => c.id === 3);
check(old.align === 'left' && old.head_mode === 'basic' && old.blur === 0, 'a window from an older config keeps its own values (the lists of the 2.0 answers stay as they are)');
const fresh = w.followConf(7);
check(fresh.align === null && fresh.head_mode === null && fresh.blur === null && fresh.font_family === '' && fresh.font_size === 0 && w.normalize([fresh]).find(c => c.id === 7).align === null, 'a window made by the user follows window 1 in everything that can follow, also after it is saved and read again');
check(w.followsMain({ id: 3 }, 'line_spacing') && !w.followsMain({ id: 3, line_spacing: 0 }, 'line_spacing') && !w.followsMain({ id: 3 }, 'show_time') && w.followsMain({ id: 3, font_size: 0 }, 'font_size'), 'followsMain: a number of 0 is a value (except the font size); the switches never follow');
check(w.followsMain({ id: 3 }, 'line_height') && !w.followsMain({ id: 3, line_height: 0 }, 'line_height'), 'line_height: an extra window follows window 1 until it has its own value');
check(w.newConf(3).clear_on_open === false && w.normalize([{ id: 3, clear_on_open: 1 }]).find(c => c.id === 3).clear_on_open === true && w.normalize([{ id: 3 }]).find(c => c.id === 3).clear_on_open === false, 'clear_on_open: off by default, a switch of its own for an extra window');
check(w.followsMain({ id: 3 }, 'max_groups') && !w.followsMain({ id: 3, max_groups: 2 }, 'max_groups') && w.normalize([{ id: 3, max_groups: 99, whole_groups: 1 }]).find(c => c.id === 3).max_groups === 50 && w.normalize([{ id: 3, whole_groups: 1 }]).find(c => c.id === 3).whole_groups === true && !('whole_groups' in w.normalize([{ id: 3 }]).find(c => c.id === 3)), 'max_groups follows window 1 (0..50); whole_groups is the window\'s own switch');
