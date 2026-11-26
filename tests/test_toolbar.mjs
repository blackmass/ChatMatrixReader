// the function buttons of the bar of a window (core/toolbar.js and where the setting `tools` is kept)
import { check, eq } from './helpers.mjs';
import { LEGACY, TOOLS, IDS, clean, listOf } from '../app/core/toolbar.js';
import * as winconf from '../app/core/winconf.js';
import { normalize, DEFAULTS } from '../app/core/config.js';

eq(LEGACY, ['research', 'voice', 'options'], 'the three buttons a window always had');
eq(IDS, ['research', 'voice', 'options', 'capture'], 'the buttons there are');
check(IDS.every(id => TOOLS[id].cls && TOOLS[id].html && typeof TOOLS[id].title() === 'string' && typeof TOOLS[id].hint() === 'string'), 'every button has a class, a picture and two texts');

// the list a window has
eq(listOf(undefined), LEGACY, 'no setting: the three of before'); eq(listOf(null), LEGACY, 'null: the three of before'); eq(listOf('x'), LEGACY, 'not a list: the three of before');
check(listOf(undefined) !== LEGACY, 'the default list is a copy (nobody changes the shared one)');
eq(listOf([]), [], 'an empty list is a choice: only the close button');
eq(listOf(['capture', 'options']), ['capture', 'options'], 'the order is the window\'s own');
eq(clean(['voice', 'zzz', 'voice', 5, null, 'research']), ['voice', 'research'], 'unknown ids, repeats and other things are dropped, the order stays');
eq(clean('x'), [], 'not a list: nothing');

// the main window: the top level of the config
eq(DEFAULTS.tools, null, 'the main window has not chosen by default');
eq([normalize({}).tools, normalize({ tools: [] }).tools, normalize({ tools: ['capture', 'x'] }).tools, normalize({ tools: 'x' }).tools], [null, [], ['capture'], null], 'the main window\'s setting is cleaned');

// an extra window: its own entry; no entry = the window never chose
const items = winconf.normalize([{ id: 2, tools: ['options', 'bad', 'options'] }, { id: 3 }, { id: 4, tools: [] }, { id: 5, tools: 'x' }]);
const by = id => items.find(c => c.id === id);
eq(by(2).tools, ['options'], 'a window\'s list is cleaned');
check(!('tools' in by(3)), 'a window that never chose has no list (it has the three of before)');
eq(by(4).tools, [], 'an empty list stays empty');
check(!('tools' in by(5)), 'a bad value is no choice');
eq(listOf(by(3).tools), LEGACY, '... and shows the three');
check(!('tools' in winconf.newConf(9)), 'a window of an older kind (newConf) has no list');
eq(winconf.followConf(9).tools, [], 'a window the user makes starts with only the close button');
check(winconf.HOST_KEYS.has('tools'), 'a tab has the bar of its window: `tools` belongs to the window');
