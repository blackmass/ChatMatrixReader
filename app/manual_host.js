// The manual capture in the hub (docs/HANDOFF.md 4-0ag): the user starts it (the item "수동 캡처" of the menu of a translation window, the event "capture-manual", or the hotkey of the OCR tab,
// `ocr_cap_hotkey`, empty = none), the screen of the game as it is AT THAT MOMENT is taken (a tooltip is gone as soon as the mouse moves), the picker (pick.html: a window over the monitor)
// shows that picture and the user drags the part to read, the part is read as words by the reader of the OCR tab (no switch: only the reader has to be there) and comes into the chat as a line of
// the OCR channel, which the pipeline marks "[OCR]" and translates like the lines of any channel (the method of the translation tab). Nothing is copied or remembered: the next capture starts again.
import { sub } from './core/image.js';
import { regionFromScreen } from './core/ocr.js';
import * as hotkeys from './core/hotkeys.js';
import { encodeBGRA } from './imgenc.js';
import { tr } from './core/i18n.js';
import { log } from './core/log.js';

const PICK_WAIT_MS = 70000;           // the picker closes itself after a minute (pick.js); this is a little more, for a picker that never answers

// settings: cfg(); capture: { game: { found, hwnd, rect }, grabClient }; ocr: { freeProblem(), readFree(pic) }; pipeline: onLine(line) -> events; publish(events); invoke/listen/emit: the exe's;
// system(text): a line of the program in the main window; encode: the picture for the picker (a page function: the tests give another)
export function startManual({ settings, capture, ocr, pipeline, publish, invoke, listen, emit, system, encode = encodeBGRA, tickMs = 40 }) {
  let busy = false;

  // the picker over the game: it asks for the picture when it is there ("pick-ready"), the answer is { x, y, w, h } in pixels of the screen or { cancel: true }
  async function pick(pic, rect) {
    const [gx, gy, gw, gh] = rect;
    let image = null;
    try { const e = encode(pic, { scale: 1, format: 'jpeg' }); image = { src: `data:${e.mime};base64,${e.base64}`, x: gx, y: gy, w: gw, h: gh }; }
    catch (e) { log.warn('수동 캡처: 멈춘 화면을 만들지 못했습니다 (지금 화면 위에서 고릅니다): ' + String(e && e.message || e)); }
    return new Promise(async resolve => {
      const offs = [];
      let timer = null, done = false;
      const end = v => { if (done) return; done = true; if (timer) clearTimeout(timer); Promise.resolve(emit('pick-active', { on: false })).catch(() => {}); for (const off of offs) { try { off(); } catch { /* gone */ } } resolve(v); };
      try {
        await emit('pick-active', { on: true });                                          // (the windows of ours step aside: not drawn, no mouse)
        offs.push(await listen('pick-result', ev => end(ev.payload || { cancel: true })));
        offs.push(await listen('pick-ready', () => { if (image) Promise.resolve(emit('pick-image', image)).catch(() => {}); }));
        await invoke('pick_region_open', { x: Math.round(gx + gw / 2), y: Math.round(gy + gh / 2) });
      } catch (e) { log.warn('수동 캡처: 구역 고르기를 열지 못했습니다: ' + String(e && e.message || e)); end({ error: String(e && e.message || e) }); return; }
      timer = setTimeout(() => end({ cancel: true }), PICK_WAIT_MS);
    });
  }

  // one capture -> { text } | { cancel: true } | { error } (what is told to the user is told here)
  async function run() {
    try { return await runInner(); }
    catch (e) {                                                                          // (whatever was not foreseen: the user is told, the key or the menu works again)
      log.error('수동 캡처 오류', e);
      const m = tr('읽지 못했습니다: {e}', { e: String(e && e.message || e) }); system('⚠ ' + m);
      return { error: m };
    }
  }
  async function runInner() {
    if (busy) return { error: 'busy' };
    const problem = ocr.freeProblem();
    if (problem) { system('⚠ ' + problem); return { error: problem }; }
    const rect = capture.game.rect;                                                    // (the place of the game's window on the screen: [x, y, w, h])
    if (!capture.game.found || !rect) { const m = tr('게임 창을 찾지 못했습니다 (게임이 켜져 있고 최소화되지 않았는지 확인하세요).'); system('⚠ ' + m); return { error: m }; }
    busy = true;
    try {
      const t0 = performance.now();
      const pic = await capture.grabClient(0, 0, rect[2], rect[3]);                      // (the screen of this moment: the tooltip stays in it)
      const picked = await pick(pic, rect);
      if (!picked || picked.cancel) return { cancel: true };
      if (picked.error) { system('⚠ ' + tr('구역을 고르지 못했습니다: {e}', { e: picked.error })); return { error: picked.error }; }
      const region = regionFromScreen(picked, rect);
      if (!region) { const m = tr('고른 곳이 게임 창 밖이거나 너무 작습니다.'); system('⚠ ' + m); return { error: m }; }
      const part = sub(pic, region.x, region.y, region.w, region.h);
      const text = String(await ocr.readFree(part) || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
      log.info(`수동 캡처: ${region.w}x${region.h}, 글자 ${[...text].length}개, ${Math.round(performance.now() - t0)}ms`);
      if (!text) { system('ℹ ' + tr('읽은 글이 없습니다.')); return { error: 'empty' }; }
      publish(pipeline.onLine({ channel: '!OCR', id: 0, sender: '', text, cls: '', base: -1 }));
      return { text };
    } catch (e) {
      log.warn('수동 캡처 실패: ' + String(e && e.message || e));
      const m = tr('읽지 못했습니다: {e}', { e: String(e && e.message || e) }); system('⚠ ' + m);
      return { error: m };
    } finally { busy = false; }
  }

  // the hotkey: looked at every tick while it is set (nothing is asked of the system when it is empty), only while the game is in front, and once per press
  let prev = true, combo = null, comboText = '';
  async function tick() {
    const text = (settings.cfg().ocr_cap_hotkey || '').trim();
    if (!text) { prev = true; return; }
    if (text !== comboText) { comboText = text; try { combo = hotkeys.parse(text); } catch { combo = null; } }
    if (!combo || busy || !capture.game.found) { prev = true; return; }
    const [mods, vk] = combo;
    const s = await invoke('os_state', { keys: [vk] });
    if (s.fg !== capture.game.hwnd) { prev = true; return; }                          // (the key must be let go once after the game came to the front)
    const down = [...mods].every(m => s[m.toLowerCase()] === true) && s.keys[0] === true;
    if (down && !prev) { prev = true; await run(); }
    else if (!down) prev = false;
  }
  const timer = tickMs > 0 ? setInterval(() => { tick().catch(e => log.warn('수동 캡처 단축키 점검 오류: ' + String(e && e.message || e))); }, tickMs) : null;
  if (listen) listen('capture-manual', () => { run(); });
  return { run, tick, stop: () => { if (timer) clearInterval(timer); } };
}
