// the manual capture (app/manual_host.js): the screen is taken when it begins, the picker shows it, the chosen part is read and comes in as an OCR line; the hotkey
import { check, eq } from './helpers.mjs';
import { log } from '../app/core/log.js';
import { startManual } from '../app/manual_host.js';
import { normalize, DEFAULTS } from '../app/core/config.js';

log.quiet = true;
const W = 400, H = 300, RECT = [100, 50, W, H];                  // (the game window: its place on the screen, and its size)
const pic = (ww = W, hh = H) => { const px = new Uint8Array(ww * hh * 4); for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) { const i = (y * ww + x) * 4; px[i] = x % 256; px[i + 1] = y % 256; px[i + 2] = 7; px[i + 3] = 255; } return { px, width: ww, height: hh }; };

function world(over = {}) {
  const w = { cfg: { ocr_cap_hotkey: '' }, notes: [], published: [], read: [], grabs: 0, emitted: [], opened: [], handlers: {}, state: { fg: 7, ctrl: false, shift: false, alt: false, keys: [false] }, problem: '', text: 'Hello\nWorld', picked: { x: 150, y: 100, w: 80, h: 40 }, ...over };
  w.screen = [0, 0, 800, 600]; w.screenGrabs = [];
  w.capture = { game: { found: true, hwnd: 7, rect: RECT }, grabClient: async (x, y, ww, hh) => { w.grabs++; w.grabArgs = [x, y, ww, hh]; return pic(); },
    screenRect: async () => w.screen, grabScreen: async (x, y, ww, hh) => { w.screenGrabs.push([x, y, ww, hh]); return pic(ww, hh); } };
  w.ocr = { freeProblem: () => w.problem, readFree: async p => { w.read.push(p); return w.text; } };
  w.pipeline = { onLine: line => { w.line = line; return [{ type: 'LineAdded', line }]; } };
  w.listen = async (name, fn) => { (w.handlers[name] ||= []).push(fn); return () => { w.handlers[name] = w.handlers[name].filter(f => f !== fn); }; };
  w.emit = async (name, payload) => { w.emitted.push([name, payload]); };
  w.fire = (name, payload) => { for (const f of [...(w.handlers[name] || [])]) f({ payload }); };
  w.invoke = async (cmd, args) => {
    if (cmd === 'os_state') return w.state;
    if (cmd === 'pick_region_open') { w.opened.push(args); setTimeout(() => { w.fire('pick-ready', {}); if (w.picked !== 'never') setTimeout(() => w.fire('pick-result', w.picked), 5); }, 5); return; }
    throw new Error('unknown ' + cmd);
  };
  w.m = startManual({ settings: { cfg: () => w.cfg }, capture: w.capture, ocr: w.ocr, pipeline: w.pipeline, publish: ev => w.published.push(...ev), invoke: w.invoke, listen: w.listen, emit: w.emit,
    system: t => w.notes.push(t), encode: () => ({ mime: 'image/jpeg', base64: 'QUJD' }), tickMs: 0 });
  return w;
}

{ // a capture: the screen of the beginning, the picker over the middle of the game, the chosen part, one OCR line
  const w = world();
  const r = await w.m.run();
  eq(w.grabArgs, [0, 0, W, H], 'the whole game window is taken at the start');
  eq(w.opened, [{ x: 300, y: 200 }], 'the picker opens on the monitor of the middle of the game');
  const img = w.emitted.find(e => e[0] === 'pick-image');
  check(img && img[1].src === 'data:image/jpeg;base64,QUJD' && img[1].x === 100 && img[1].y === 50 && img[1].w === W && img[1].h === H, 'the picker is given the picture and where it lies');
  eq([w.read.length, w.read[0].width, w.read[0].height], [1, 80, 40], 'the part read is the chosen rectangle (in the pixels of the window)');
  eq([w.read[0].px[0], w.read[0].px[1]], [50, 50], 'it is that part of the picture (screen 150,100 is window 50,50)');
  eq(w.line, { channel: '!OCR', id: 0, sender: '', text: 'Hello World', cls: '', base: -1 }, 'the OCR line: one line, the line breaks are spaces');
  eq([r.text, w.published.length, w.notes], ['Hello World', 1, []], 'told and published once, no note');
  eq(w.handlers['pick-result'] || [], [], 'the listeners of the picker are gone');
  eq(w.emitted.filter(e => e[0] === 'pick-active').map(e => e[1].on), [true, false], 'our windows step aside while the picker is there, and come back');
  const order = w.emitted.map(e => e[0]); check(order.indexOf('pick-active') < order.indexOf('pick-image'), 'they step aside before the picture is shown');
}
{ // cancel, a part outside the window, nothing read, the reader that cannot read, no game, an error of the picker
  let w = world({ picked: { cancel: true } });
  eq(await w.m.run(), { cancel: true }, 'cancel'); eq([w.read.length, w.published.length, w.notes], [0, 0, []], 'cancel: nothing read, nothing said');
  eq(w.emitted.filter(e => e[0] === 'pick-active').map(e => e[1].on), [true, false], 'cancel: our windows come back');
  w = world({ picked: { x: 5000, y: 5000, w: 50, h: 50 } });
  await w.m.run(); check(w.notes.length === 1 && w.read.length === 0, 'a part outside the game window: a note, nothing read');
  w = world({ text: '  ' });
  await w.m.run(); check(w.notes.length === 1 && w.notes[0].startsWith('ℹ') && w.published.length === 0, 'nothing read: a note, no line');
  w = world({ problem: 'no reader' });
  await w.m.run(); eq([w.notes, w.grabs], [['⚠ no reader'], 0], 'the reader cannot read: told, the screen is not even taken');
  w = world(); w.capture.game.found = false; w.capture.game.rect = null; w.state.cursor = [400, 300];
  const rs = await w.m.run();
  eq([w.grabs, w.screenGrabs, w.notes], [0, [[0, 0, 800, 600]], []], 'no game window: the whole screen is taken, nothing is said');
  eq(w.opened, [{ x: 400, y: 300 }], '... and the picker opens where the mouse is');
  eq([w.read[0].width, w.read[0].height, w.read[0].px[0], w.read[0].px[1]], [80, 40, 150, 100], '... the chosen part is cut from the picture of the screen (150,100 on the screen)');
  eq([rs.text, w.published.length], ['Hello World', 1], '... and its line comes in');
  const img0 = w.emitted.find(e => e[0] === 'pick-image'); check(img0 && img0[1].x === 0 && img0[1].y === 0 && img0[1].w === 800 && img0[1].h === 600, '... the picker is given the screen\'s picture where it lies');
  w = world(); w.capture.game.found = true; w.capture.game.rect = null;
  await w.m.run(); eq(w.screenGrabs.length, 1, 'a game window that is minimized (no rectangle): the screen is taken');
  w = world(); w.capture.game.found = false; w.capture.game.rect = null; w.screen = [0, 0, 0, 0];
  await w.m.run(); check(w.notes.length === 1 && w.screenGrabs.length === 0 && w.published.length === 0, 'no screen at all: told');
  w = world(); w.invoke = async () => { throw new Error('boom'); };
  w.m = startManual({ settings: { cfg: () => w.cfg }, capture: w.capture, ocr: w.ocr, pipeline: w.pipeline, publish: () => {}, invoke: w.invoke, listen: w.listen, emit: w.emit, system: t => w.notes.push(t), encode: () => ({ mime: 'image/jpeg', base64: 'x' }), tickMs: 0 });
  const r = await w.m.run(); check(r.error === 'boom' && w.notes.length === 1, 'the picker could not be opened: told');
  w = world({ text: 'x' }); w.ocr.readFree = async () => { throw new Error('engine'); };
  await w.m.run(); check(w.notes.length === 1 && w.notes[0].includes('engine'), 'the reading failed: told');
}
{ // what was not foreseen (here: no rectangle of the window at all) is told, not thrown
  const w = world(); w.capture.game.found = false; w.capture.screenRect = async () => { throw new Error('boom'); };
  const r = await w.m.run(); check(r.error && w.notes.length === 1, 'an unforeseen error: a note, no throw');
}
{ // one at a time; the menu's event starts it
  const w = world();
  const a = w.m.run(), b = await w.m.run();
  eq(b, { error: 'busy' }, 'a second capture while one is going: refused');
  await a;
  w.fire('capture-manual', {}); await new Promise(r => setTimeout(r, 60));
  eq(w.published.length, 2, 'the event of the menu runs a capture');
}
{ // the hotkey: nothing asked when it is empty; once per press; only with the game in front; the key is let go first
  const w = world();
  await w.m.tick(); eq(w.grabs, 0, 'no hotkey: nothing happens');
  w.cfg.ocr_cap_hotkey = 'Ctrl+Q';
  w.state = { fg: 7, ctrl: true, shift: false, alt: false, keys: [true] };
  await w.m.tick(); eq(w.grabs, 0, 'held from the start: nothing');
  w.state = { ...w.state, ctrl: false, keys: [false] }; await w.m.tick();
  w.state = { ...w.state, fg: 9, ctrl: true, keys: [true] }; await w.m.tick(); eq(w.grabs, 0, 'another program in front: nothing');
  w.state = { ...w.state, fg: 7, ctrl: false, keys: [false] }; await w.m.tick();
  w.state = { ...w.state, ctrl: true, keys: [true] }; await w.m.tick();
  eq(w.grabs, 1, 'the hotkey: a capture'); eq(w.published.length, 1, '... and its line');
  w.state = { ...w.state, ctrl: true, shift: false, keys: [false] }; await w.m.tick();            // (the key part let go, Ctrl held: no capture)
  eq(w.grabs, 1, 'only Q is let go: nothing');
  w.cfg.ocr_cap_hotkey = 'Shift+Q'; w.state = { fg: 7, ctrl: false, shift: false, alt: false, keys: [false] }; await w.m.tick();
  w.state = { ...w.state, ctrl: true, keys: [true] }; await w.m.tick(); eq(w.grabs, 1, 'Ctrl+Q is not Shift+Q');
  w.cfg.ocr_cap_hotkey = 'zzz'; await w.m.tick(); eq(w.grabs, 1, 'a hotkey that does not parse is no hotkey');
  // with no game the key works wherever the user is
  const n = world(); n.cfg.ocr_cap_hotkey = 'Ctrl+Q'; n.capture.game.found = false; n.capture.game.rect = null;
  n.state = { fg: 9, ctrl: false, shift: false, alt: false, keys: [false] }; await n.m.tick();
  n.state = { ...n.state, ctrl: true, keys: [true] }; await n.m.tick();
  eq([n.grabs, n.screenGrabs.length, n.published.length], [0, 1, 1], 'no game: the hotkey works in any program (the screen is taken)');
}
{ // the setting: empty by default, a good hotkey in its own spelling, a bad one is none
  eq(DEFAULTS.ocr_cap_hotkey, '', 'no hotkey by default');
  eq([normalize({ ocr_cap_hotkey: 'ctrl+q' }).ocr_cap_hotkey, normalize({ ocr_cap_hotkey: 'zzz' }).ocr_cap_hotkey, normalize({ ocr_cap_hotkey: '  ' }).ocr_cap_hotkey, normalize({}).ocr_cap_hotkey], ['Ctrl+Q', '', '', ''], 'the setting is normalized');
}
