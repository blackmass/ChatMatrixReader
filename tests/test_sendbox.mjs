// the send box state machine with a fake world (the scenarios of the 2.0 test_sendbox.py). Everything is awaited: the real io is async.
import { check, eq } from './helpers.mjs';
import { log } from '../app/core/log.js';
import { DEFAULTS } from '../app/core/config.js';
import { SendBox } from '../app/core/sendbox.js';
import * as outgoing from '../app/core/outgoing.js';
import * as hotkeys from '../app/core/hotkeys.js';

log.quiet = true;
class IO {
  constructor() {
    Object.assign(this, { gameH: 'G', front: 'G', combo: false, ret: false, mods: false, log: [], focusOk: true, openOk: true, clipOk: true, pasteOk: true, pending: null, nudgeWorks: true, focusDelay: false });
  }
  game() { return this.gameH; }
  gameIsFront() { return this.front === 'G'; }
  selfIsFront() { return this.front === 'me'; }
  comboDown() { return this.combo; }
  returnDown() { return this.ret; }
  modsDown() { return this.mods; }
  openBox(label) { this.log.push(['open', label]); if (this.openOk && !this.neverFront) this.front = 'me'; return this.openOk; }
  closeBox() { this.log.push(['close']); }
  busyBox(t) { this.log.push(['busy', t]); }
  readyBox() { this.log.push(['ready']); }
  say(t, error = false) { this.log.push(['say', t, error]); }
  showSent(t) { this.log.push(['sent', t]); }
  putClipboard(t) { this.log.push(['clip', t]); return this.clipOk; }
  focusGame() { this.log.push(['focus']); if (this.focusOk && !this.focusDelay) this.front = 'G'; return this.focusOk; }
  paste() { this.log.push(['paste']); return this.pasteOk; }
  nudgeGame() { this.log.push(['nudge']); if (this.nudgeWorks) this.front = 'G'; }
  endNudge() { this.log.push(['end_nudge']); }
  translate(cfg, raw, done) { this.pending = [cfg, raw, done]; }
  async finish(fake = 'hello') {
    const [cfg, raw, done] = this.pending; this.pending = null;
    let res = null, err = null;
    try { res = await outgoing.prepare(cfg, raw, async () => fake); } catch (e) { err = e.message; }
    await done(res, err);
  }
  kinds() { return this.log.map(e => e[0]); }
}
function make(over = {}) {
  const cfg = { ...DEFAULTS, translator: 'google', send_enabled: true, ...over };
  const io = new IO(), clock = { t: 100, advance(s) { this.t += s; } };
  return { box: new SendBox(io, () => cfg, () => clock.t), io, clock, cfg };
}
const run = async (box, clock, n = 1, dt = 0.025) => { for (let i = 0; i < n; i++) { clock.advance(dt); await box.tick(); } };
const press = async (io, box, clock) => { io.combo = false; await run(box, clock); io.combo = true; await run(box, clock); };

{ // the hotkey must be let go once first
  const { box, io, clock } = make();
  io.combo = true; await run(box, clock, 3);
  check(box.state === 'idle' && !io.log.length, 'a hotkey held from the start does nothing');
  io.combo = false; await run(box, clock); io.combo = true; await run(box, clock);
  check(box.state === 'open' && io.log[0][0] === 'open' && io.log[0][1].includes('English') && io.front === 'me', 'the hotkey opens the box');
  // Enter only counts after it was let go
  io.ret = true; await run(box, clock, 2);
  eq(box.submit('안녕'), false, 'Enter held: not taken');
  io.ret = false; clock.advance(0.2); await run(box, clock);
  eq(box.submit('   '), false, 'empty: nothing');
  check(box.submit('안녕하세요') === true && box.state === 'busy' && io.log.some(e => e[0] === 'busy' && e[1] === '번역 중...'), 'submit is taken');
  eq(box.submit('again'), false, 'busy');
  await io.finish('hello');
  check(box.state === 'back' && io.log.some(e => e[0] === 'clip' && e[1] === 'hello') && io.kinds().includes('ready') && io.kinds().includes('close'), 'clipboard, box closed, going back');
  io.ret = true; await run(box, clock, 3);
  check(!io.kinds().includes('focus'), 'waits for Enter to be let go');
  io.ret = false; await run(box, clock, 2);
  check(io.kinds().includes('focus') && box.state === 'idle' && !io.kinds().includes('paste'), 'focus back, no paste (option off)');
}
{ // auto paste waits for the modifiers, pastes once
  const { box, io, clock } = make({ send_autopaste: true });
  await press(io, box, clock); clock.advance(0.2); await run(box, clock);
  box.submit('hi'); await io.finish('hello');
  await run(box, clock);
  check(io.kinds().includes('focus') && !io.kinds().includes('paste'), 'focus first');
  io.mods = true; await run(box, clock, 4, 0.05);
  check(!io.kinds().includes('paste'), 'modifiers down: no paste');
  io.mods = false; await run(box, clock, 2);
  check(io.kinds().filter(k => k === 'paste').length === 1 && box.state === 'idle', 'pasted once');
}
{ // slow system: waits in ticks, nudges once, then pastes
  const { box, io, clock } = make({ send_autopaste: true }); io.focusDelay = true;
  await press(io, box, clock); clock.advance(0.2); await run(box, clock);
  box.submit('hi'); await io.finish('hello');
  await run(box, clock, 4);
  check(io.kinds().includes('focus') && !io.kinds().includes('paste') && box.state === 'back' && !io.kinds().includes('nudge'), 'asked, not in front yet');
  await run(box, clock, 12);
  eq(io.kinds().filter(k => k === 'nudge').length, 1, 'nudged once');
  await run(box, clock, 12);
  check(io.kinds().filter(k => k === 'paste').length === 1 && io.kinds().includes('end_nudge') && box.state === 'idle', 'pasted after the nudge');
  const t = make({ send_autopaste: true }); t.io.focusDelay = true; t.io.nudgeWorks = false;
  await press(t.io, t.box, t.clock); t.clock.advance(0.2); await run(t.box, t.clock);
  t.box.submit('hi'); await t.io.finish('hello'); await run(t.box, t.clock, 120);
  check(t.box.state === 'idle' && !t.io.kinds().includes('paste') && t.io.kinds().filter(k => k === 'end_nudge').length === 1, 'the game never comes: given up, nothing pasted');
}
{ // paste without permission: said
  const { box, io, clock } = make({ send_autopaste: true }); io.pasteOk = false;
  await press(io, box, clock); clock.advance(0.2); await run(box, clock);
  box.submit('hi'); await io.finish('hello'); await run(box, clock, 12, 0.05);
  check(io.log.some(e => e[0] === 'say' && e[1].includes('권한')), 'no permission is said');
}
{ // an error keeps the box open; cancel gives the focus back
  const { box, io, clock } = make();
  await press(io, box, clock); clock.advance(0.2); await run(box, clock);
  box.submit('hi');
  const done = io.pending[2]; io.pending = null;
  await done(null, '번역 실패: x');
  check(box.state === 'open' && io.log.at(-1)[0] === 'say' && io.log.at(-1)[2] === true, 'error: box stays open, said');
  await box.cancel(); eq(box.state, 'back', 'cancel -> back');
  io.ret = false; await run(box, clock, 2); check(box.state === 'idle' && io.kinds().includes('focus'), 'cancel gives the focus back');
}
{ // losing the focus for good closes quietly
  const { box, io, clock } = make();
  await press(io, box, clock); await run(box, clock, 3); io.front = 'other'; await run(box, clock, 40);
  check(box.state === 'idle' && !io.kinds().includes('focus'), 'switched away: closed quietly');
}
{ // the box was opened but this program never came to the front (the system is slow, or refuses): it waits, and when it is for good the keyboard goes back to the game
  const { box, io, clock } = make(); io.neverFront = true;
  await press(io, box, clock); await run(box, clock, 40, 0.05);                     // 2 s: still waiting
  check(box.state === 'open' && !io.kinds().includes('focus'), 'not in front yet: the box waits (a Mac may take a second or more)');
  await run(box, clock, 40, 0.05);                                                   // 4 s
  check(box.state === 'back' || (box.state === 'idle' && io.kinds().includes('focus')), 'never in front: the box is closed and the focus goes back');
  await run(box, clock, 40);
  check(box.state === 'idle' && io.kinds().includes('focus') && io.kinds().includes('say') && io.front === 'G', 'never in front: said, and the game has the keyboard again');
}
{ // it comes to the front late (1.5 s): everything works
  const { box, io, clock } = make(); io.neverFront = true;
  await press(io, box, clock); await run(box, clock, 30, 0.05); io.front = 'me'; await run(box, clock, 10, 0.05);
  check(box.state === 'open', 'in front late: the box stays open');
  io.ret = false; await run(box, clock, 4);
  check(box.submit('hi') === true, 'in front late: Enter is taken');
}
{ // no method / focus refused / game not in front / option off
  let t = make(); t.cfg.translator = 'none'; await press(t.io, t.box, t.clock);
  check(t.box.state === 'idle' && t.io.log.at(-1)[0] === 'say' && !t.io.kinds().includes('open'), 'no translation method: said');
  t = make(); t.io.openOk = false; await press(t.io, t.box, t.clock);
  check(t.box.state === 'back' && t.io.kinds().includes('say') && t.io.kinds().includes('close'), 'focus refused: said, the box is closed and the focus goes back to the game');
  await run(t.box, t.clock, 40);
  check(t.box.state === 'idle' && t.io.kinds().includes('focus') && t.io.front === 'G', 'focus refused: the game has the keyboard again (not left with a program that has no window to type into)');
  t = make(); t.io.front = 'other'; await press(t.io, t.box, t.clock);
  check(t.box.state === 'idle' && !t.io.log.length, 'game not in front: nothing');
  t = make({ send_enabled: false }); await press(t.io, t.box, t.clock);
  check(t.box.state === 'idle' && !t.io.log.length, 'option off: nothing');
}
{ // a bad hotkey text falls back; an error inside switches the feature off; two ticks never overlap
  const t = make({ send_hotkey: 'zzz' });
  eq([[...t.box.combo()[0]], t.box.combo()[1]], [[...hotkeys.parse('Shift+Enter')[0]], hotkeys.parse('Shift+Enter')[1]], 'bad hotkey -> default');
  const u = make(); u.io.comboDown = () => { throw new Error('boom'); }; await run(u.box, u.clock);
  check(u.box.failed && u.box.state === 'idle', 'an error switches the box off');
  const v = make(); let calls = 0; v.io.game = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return 'G'; };
  await Promise.all([v.box.tick(), v.box.tick(), v.box.tick()]);
  eq(calls, 1, 'overlapping ticks are skipped');
}
