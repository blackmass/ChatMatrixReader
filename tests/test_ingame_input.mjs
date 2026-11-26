// the text typed in the game's own chat box (command "@IN"): core/ingame_input.js, and the hold of the send box's hotkey (core/sendbox.js setHold)
import { check, eq } from './helpers.mjs';
import { log } from '../app/core/log.js';
import { DEFAULTS } from '../app/core/config.js';
import { InGameInput, DEADLINE_S } from '../app/core/ingame_input.js';
import { SendBox } from '../app/core/sendbox.js';
import * as outgoing from '../app/core/outgoing.js';

log.quiet = true;
class IO {
  constructor() { Object.assign(this, { log: [], pending: [], front: true, clipOk: true }); }
  game() { return 'G'; }
  gameIsFront() { return this.front; }
  say(t, error = false) { this.log.push(['say', t, error]); }
  showSent(t) { this.log.push(['sent', t]); }
  putClipboard(t) { this.log.push(['clip', t]); return this.clipOk; }
  paste() { this.log.push(['paste']); return true; }
  translate(cfg, raw, done) { this.pending.push([cfg, raw, done]); }
  async finish(i = 0, fake = 'hello') {
    const [cfg, raw, done] = this.pending[i];
    let res = null, err = null;
    try { res = await outgoing.prepare(cfg, raw, async () => fake); } catch (e) { err = e.message; }
    await done(res, err);
  }
  kinds() { return this.log.map(e => e[0]); }
}
const line = (sender, text = 'x') => ({ channel: '@IN', id: 1, sender, text, cls: '', base: -1 });
function make(over = {}) {
  const cfg = { ...DEFAULTS, translator: 'google', send_enabled: true, ...over };
  const io = new IO(), clock = { t: 100 }, holds = [];
  const g = new InGameInput({ getCfg: () => cfg, io, onHold: on => holds.push(on), now: () => clock.t });
  return { g, io, clock, holds, cfg };
}

{ // a request is translated like the send box does, and lands on the clipboard; the paste only with the option
  const { g, io } = make();
  g.onLine(line('send,5', '안녕하세요'));
  eq(io.pending.length, 1, 'translation asked');
  eq(io.pending[0][1], '안녕하세요', 'the typed text is what is translated');
  await io.finish();
  eq(io.kinds(), ['clip'], 'clipboard, no paste (auto paste off)');
  eq(io.log[0][1], 'hello', 'the translation is on the clipboard');
}
{ // auto paste: Ctrl+V once, and only when the game is in front
  const a = make({ send_autopaste: true });
  a.g.onLine(line('send,1', '안녕')); await a.io.finish();
  eq(a.io.kinds(), ['clip', 'paste'], 'auto paste on: clipboard then Ctrl+V');
  const b = make({ send_autopaste: true }); b.io.front = false;
  b.g.onLine(line('send,1', '안녕')); await b.io.finish();
  eq(b.io.kinds(), ['clip'], 'the game is not in front: no Ctrl+V');
}
{ // too late: thrown away (the addon has given up after 3 s)
  const { g, io, clock } = make({ send_autopaste: true });
  g.onLine(line('send,2', '안녕')); clock.t += DEADLINE_S + 0.1; await io.finish();
  eq(io.kinds(), [], 'an answer after the deadline: nothing on the clipboard, no paste');
  g.onLine(line('send,3', '안녕')); clock.t += DEADLINE_S - 0.1; await io.finish(1);
  eq(io.kinds(), ['clip', 'paste'], 'just in time: taken');
}
{ // cancel and a newer request
  const { g, io } = make({ send_autopaste: true });
  g.onLine(line('send,1', '하나')); g.onLine(line('cancel,1', 'cancel')); await io.finish(0);
  eq(io.kinds(), [], 'cancelled: nothing');
  g.onLine(line('send,2', '둘')); g.onLine(line('send,3', '셋'));
  await io.finish(1); eq(io.kinds(), [], 'a newer request makes the older one useless');
  await io.finish(2); eq(io.kinds(), ['clip', 'paste'], 'the newest is taken');
  g.onLine(line('cancel,99', 'cancel')); g.onLine(line('send,x', 'a')); g.onLine(line('zzz,1', 'a'));
  eq(io.pending.length, 3, 'a cancel of another number, a bad number and an unknown order do nothing');
}
{ // a command (/...) is copied untouched; an error goes to the window; a failed clipboard is told
  const a = make();
  a.g.onLine(line('send,1', '/p 안녕')); await a.io.finish();
  check(a.io.log.some(e => e[0] === 'clip' && e[1] === '/p 안녕') && a.io.log.some(e => e[0] === 'say'), 'a command is copied as it is (and told so)');
  const b = make(); b.g.onLine(line('send,1', '   ')); await b.io.finish();
  check(b.io.log.length === 1 && b.io.log[0][0] === 'say' && b.io.log[0][2] === true, 'an empty text: an error line in the window');
  const c = make({ clipOk: false }); c.io.clipOk = false; c.g.onLine(line('send,1', '안녕')); await c.io.finish();
  check(c.io.log.some(e => e[0] === 'say' && e[2] === true) && !c.io.kinds().includes('paste'), 'no clipboard: told, no paste');
}
{ // "use send" of the reader's input window does not matter: the game's own chat box has its own switch in the addon; no translator: told once per run
  const a = make({ send_enabled: false, send_autopaste: true });
  a.g.onLine(line('send,1', '안녕')); await a.io.finish();
  eq(a.io.kinds(), ['clip', 'paste'], 'send off (the reader\'s input window): the game\'s chat box is translated all the same');
  const b = make({ translator: 'none' });
  b.g.onLine(line('send,1', '안녕')); b.g.onLine(line('send,2', '안녕'));
  eq([b.io.pending.length, b.io.kinds()], [0, ['say']], 'no translator: told once');
}
{ // the state of the addon's option goes to the hold
  const { g, holds } = make();
  g.onLine(line('state,1', 'state')); g.onLine(line('state,0', 'state'));
  eq(holds, [true, false], 'state 1 / 0');
}

// ---- the hold of the send box: the same key only, for this run
class BoxIO {
  constructor() { Object.assign(this, { combo: false, log: [] }); }
  game() { return 'G'; } gameIsFront() { return true; } selfIsFront() { return false; }
  comboDown() { return this.combo; } returnDown() { return false; } modsDown() { return false; }
  openBox(l) { this.log.push(['open']); return true; } closeBox() { this.log.push(['close']); } busyBox() {} readyBox() {}
  say() {} showSent() {} putClipboard() { return true; } focusGame() { return true; } paste() { return true; } nudgeGame() {} endNudge() {}
  translate() {}
}
const mk = (over = {}) => {
  const cfg = { ...DEFAULTS, translator: 'google', send_enabled: true, ...over }, io = new BoxIO(), clock = { t: 100 };
  return { box: new SendBox(io, () => cfg, () => clock.t), io, clock, cfg };
};
const tick = async (t, n = 1) => { for (let i = 0; i < n; i++) { t.clock.t += 0.025; await t.box.tick(); } };
const press = async t => { t.io.combo = false; await tick(t); t.io.combo = true; await tick(t); };
{
  const t = mk();
  t.box.setHold(true); await press(t);
  check(t.box.state === 'idle' && !t.io.log.length, 'hold: Shift+Enter does not open the box');
  t.box.setHold(false); await press(t);
  check(t.box.state === 'open', 'hold ended: the hotkey works again');
}
{
  const t = mk({ send_hotkey: 'Ctrl+Alt+T' });
  t.box.setHold(true); await press(t);
  check(t.box.state === 'open', 'another key is not held');
}
{ // the key is held down while the hold ends: it must be let go first
  const t = mk();
  t.box.setHold(true); t.io.combo = false; await tick(t); t.io.combo = true; await tick(t, 2);
  t.box.setHold(false); await tick(t, 2);
  check(t.box.state === 'idle', 'the key held while the hold ends does not open the box');
  t.io.combo = false; await tick(t); t.io.combo = true; await tick(t);
  check(t.box.state === 'open', '... after it was let go it does');
}
{ // switching "use send" off and on clears the hold
  const t = mk();
  t.box.setHold(true); t.cfg.send_enabled = false; await tick(t); t.cfg.send_enabled = true; await press(t);
  check(t.box.state === 'open', 'send off and on: the hold is gone');
}
