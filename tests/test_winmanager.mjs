// The extra windows follow the voice recognition ("음성 인식을 켤 때만"), and the X of such a window is only for now.
import { check } from './helpers.mjs';
import * as layout from '../app/core/winlayout.js';
import * as winconf from '../app/core/winconf.js';

// ---- the rule
const c = (id, mode) => ({ id, open_mode: mode });
check(layout.wantedOpen(c(2, 'voice'), new Set(), true) && !layout.wantedOpen(c(2, 'voice'), new Set(), false) && !layout.wantedOpen(c(2, 'voice'), new Set()), 'a "voice" window is wanted exactly while the voice recognition is on');
check(!layout.wantedOpen(c(2, 'voice'), new Set(), true, new Set([2])) && layout.wantedOpen(c(2, 'voice'), new Set([2]), true, new Set([2])), 'one the user closed is not wanted again (until the next time), unless it was opened by hand');
check(layout.wantedOpen(c(3, 'always'), new Set(), false) && !layout.wantedOpen(c(3, 'never'), new Set(), true), 'the other modes do not care');
check(!layout.wantedOpen(c(3, 'always'), new Set(), false, new Set([3])) && layout.wantedOpen(c(3, 'always'), new Set([3]), false, new Set([3])), 'an "always" window the user closed is not wanted (for now) either, unless opened by hand');
check(winconf.normalize([{ id: 7, open_mode: 'voice' }]).find(x => x.id === 7).open_mode === 'voice', 'any extra window can have the "voice" mode');

// ---- the manager, with a stand-in for the exe
globalThis.window = { __TAURI__: { event: { emit() {}, listen() {} }, core: { invoke: async (cmd, a) => { calls.push(cmd + ':' + (a && a.label)); return null; } } } };
const calls = [];
const { startWindows } = await import('../app/winmanager.js');
const cfg = { child_windows: [{ ...winconf.newConf(2, ['!VC']), open_mode: 'voice' }, { ...winconf.newConf(3, []), open_mode: 'always' }, { ...winconf.newConf(4, []), open_mode: 'voice' }, { ...winconf.newConf(5, []), open_mode: 'never' }] };
const modes = () => cfg.child_windows.map(w => w.open_mode).join();
const subs = [];
const settings = { cfg: () => cfg, set: p => { Object.assign(cfg, p); subs.forEach(f => f(cfg)); }, onChange: f => { subs.push(f); return () => {}; } };
const wm = startWindows({ settings });
const settle = () => new Promise(r => setTimeout(r, 20));
await settle();
check(wm.openIds().join() === '3' && calls.length === 0, 'the program starts: only the "always" window opens (the exe is not asked for anything: the control centers draw the windows)');
const modes0 = modes();
calls.length = 0;

wm.setVoice(true); await settle();
check(wm.openIds().sort().join() === '2,3,4' && calls.length === 0, 'the voice recognition is turned on: the "voice" windows open');
calls.length = 0; wm.setVoice(true); await settle();
check(calls.length === 0, 'told again: nothing happens');

// ---- the OCR assist: a window of the mode "ocr" follows it like the voice windows follow the voice recognition
{
  const before = wm.openIds().sort().join();
  wm.setOcr(true); await settle();
  check(wm.openIds().sort().join() === before, 'the OCR assist is turned on: no window has the mode "ocr" here, nothing opens');
  wm.setOcr(false); await settle();
}

// ---- what the user does is only for now and never changes the settings
wm.closeWindow(2); await settle();
check(wm.openIds().sort().join() === '3,4' && modes() === modes0, 'the X of a "voice" window closes it for now; the settings are as they were');
settings.set({}); await settle();
check(!wm.isOpen(2), 'a change of some setting does not open it again');
wm.setVoice(false); await settle();
check(wm.openIds().join() === '3', 'the voice recognition is turned off: the other "voice" window closes too');
wm.setVoice(true); await settle();
check(wm.openIds().sort().join() === '2,3,4', 'turned on again: the window that was closed with the X opens again');

wm.closeWindow(3); await settle();
check(!wm.isOpen(3) && modes() === modes0, 'the X of an "always" window closes it for now: its setting stays "always" (it is not changed to "never" any more)');
settings.set({}); await settle();
check(!wm.isOpen(3), 'and a change of some setting does not open it again');
wm.openWindow(3); await settle();
check(wm.isOpen(3), 'opened by hand again');

// ---- "only while the voice recognition is on": the windows that were opened by hand go with it
wm.setVoice(false); await settle();
check(!wm.isOpen(2) && !wm.isOpen(4), 'turned off: the "voice" windows are closed');
wm.openWindow(2); await settle();
check(wm.isOpen(2), 'opened by hand while it is off: it opens');
wm.setVoice(true); await settle();
check(wm.isOpen(2) && wm.isOpen(4), 'turned on: it is open (with the other)');
wm.setVoice(false); await settle();
check(!wm.isOpen(2) && !wm.isOpen(4) && wm.isOpen(3), 'turned off: both are closed, also the one that was opened by hand; the "always" window stays');
wm.setVoice(true); wm.closeWindow(4); await settle(); wm.openWindow(4); await settle();
check(wm.isOpen(4), 'closed with the X, then opened by hand while it is on: it is open');
wm.setVoice(false); await settle();
check(!wm.isOpen(4), 'turned off: closed (a hand opened window is only for now)');
// a window with "닫아 둠" is only opened by hand and closed by hand
wm.openWindow(5); await settle();
check(wm.isOpen(5) && modes() === modes0, 'a "never" window: opened by hand');
wm.setVoice(true); wm.setVoice(false); await settle();
check(wm.isOpen(5), 'it does not care for the voice recognition');
wm.closeWindow(5); await settle();
check(!wm.isOpen(5) && modes() === modes0, 'closed by hand; the settings never changed');
