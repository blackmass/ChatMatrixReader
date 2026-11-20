import fs from 'node:fs';
import path from 'node:path';
import * as w from '../app/core/winconf.js';
import { HERE, eq } from './helpers.mjs';

for (const [fn, args, want] of JSON.parse(fs.readFileSync(path.join(HERE, 'golden', 'winconf.json'), 'utf8'))) {
  // 3.0 differs from 2.0 here on purpose: "only while the voice recognition is on" can be set for every extra window (2.0 allowed it for window 2 only)
  if (fn === 'normalize' && Array.isArray(args[0]) && args[0].length === 1 && args[0][0] && args[0][0].id === 5 && args[0][0].open_mode === 'voice') want.find(c => c.id === 5).open_mode = 'voice';
  const got = w[fn](...args);
  const no3 = v => { if (Array.isArray(v)) v.forEach(no3); else if (v && typeof v === 'object') { delete v.clear_on_open; delete v.dock_to; delete v.tab_opacity; delete v.owner; delete v.owner_win; delete v.kind; delete v.page; } return v; };       // (3.x only: an extra window can start empty)
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

// ---- tabs: "탭으로 합칠 창" (dock_to): one level only, a window cannot be a tab of itself or of a missing window
{
  const L = [{ id: 2, dock_to: 3 }, { id: 3, dock_to: 1 }, { id: 4, dock_to: 2 }, { id: 5, dock_to: 5 }, { id: 6, dock_to: 9 }, { id: 7, dock_to: 1 }, { id: 8 }];
  check(JSON.stringify([2, 3, 4, 5, 6, 7, 8].map(i => w.dockHost(L, i))) === '[0,1,0,0,0,1,0]', 'dockHost: a tab of window 1 is valid; a tab of a tab, of itself, of a missing window or none is not');
  check(JSON.stringify(w.dockedOf(L, 1)) === '[3,7]' && w.dockedOf(L, 3).length === 0, 'dockedOf: the tabs of a window, in the order of the list');
  check(w.normalize([{ id: 3, dock_to: 3 }]).find(c => c.id === 3).dock_to === 0 && w.normalize([{ id: 3, dock_to: '1' }]).find(c => c.id === 3).dock_to === 1 && w.newConf(3).dock_to === 0, 'dock_to: cleaned (itself = none, text numbers read, default none)');
}

// ---- a window of a plugin (kind 'page'): it keeps its plugin, its name and its page; without them it is an ordinary window
{
  const ok = w.normalize([{ id: 5, owner: 'my-plugin-id', owner_win: 'main', kind: 'page', page: 'ui/window.html' }]).find(c => c.id === 5);
  check(ok.kind === 'page' && ok.owner === 'my-plugin-id' && ok.owner_win === 'main' && ok.page === 'ui/window.html', 'winconf: a plugin window keeps owner, name and page');
  for (const bad of [{ page: '../x.html' }, { page: '/x.html' }, { page: 'x.js' }, { owner: 'Bad Owner' }, { owner_win: 'a b' }]) {
    const c = w.normalize([{ id: 5, owner: 'my-plugin-id', owner_win: 'main', kind: 'page', page: 'w.html', ...bad }]).find(x => x.id === 5);
    check(c.kind === '' || (c.owner === 'my-plugin-id' && !bad.owner && !bad.page) || c.owner_win === '', 'winconf: a bad ' + JSON.stringify(bad) + ' is cleaned: ' + JSON.stringify([c.kind, c.owner, c.owner_win, c.page]));
  }
  const plain = w.normalize([{ id: 5, kind: 'page' }]).find(c => c.id === 5);
  check(plain.kind === '' && plain.owner === '' && plain.page === '', 'winconf: kind page without an owner and a page is an ordinary window');
}
