// The send box (no screen): what happens between the hotkey in the game and the translation on the clipboard. Port of sendbox.py.
//
//   The hotkey (Shift+Enter by default; the game opens its chat box as usual)  ->  an input line appears in the chat window  ->
//   you type in your own language, Enter  ->  the translation is put on the clipboard  ->  the focus goes back to the game, where its
//   chat box is still open: Ctrl+V, Enter.  Nothing is ever sent to the game by this program (except Ctrl+V, and only with "auto paste").
//
//   box = new SendBox(io, getCfg)
//   await box.tick()      every 25 ms (the program's timer): looks for the hotkey, drives the steps after Enter
//   box.submit(text)      Enter in the input line -> true when taken
//   await box.cancel()    Esc in the input line
//
// `io` is what the box needs from the world (the program gives the real one, the test a fake). EVERY call may return a promise (the
// real keys are read through the exe) and is awaited; the box never runs two ticks at once.
//   game() -> the game window or null          gameIsFront(game) / selfIsFront() -> bool
//   focusGame(game) -> bool (asked)            nudgeGame(game) / endNudge()    (the game is then waited for with gameIsFront)
//   comboDown([mods, vk]) / returnDown() / modsDown() -> bool
//   openBox(label) -> bool (shows the line, takes the focus)     closeBox()      busyBox(text)      readyBox(label)
//   say(text, error=false)      showSent(text)      putClipboard(text) -> bool      paste() -> bool
//   translate(cfg, raw, done)   runs outgoing.prepare and calls done(result, errorText)
import { log } from './log.js';
import { tr } from './i18n.js';
import * as hotkeys from './hotkeys.js';

export const [IDLE, OPEN, BUSY, BACK] = ['idle', 'open', 'busy', 'back'];
export const ARM_AFTER = 0.1;            // Enter only counts after it was let go once (a long hotkey press cannot submit anything)
export const LOST_AFTER = 0.7;           // the user went to another program: the box is forgotten
export const RETURN_WAIT = 1.5;          // waiting for Enter to be let go before the focus goes back
export const PASTE_DELAY = 0.16;
export const PASTE_TRIES = 40;           // waiting for the modifier keys to be up (40 x 25 ms)
export const STEP = 0.025;
export const FRONT_WAIT = 2.0;           // how long the game may take to come to the front
export const NUDGE_AFTER = 0.3;          // ... and when to help it (the io decides how)

export class SendBox {
  constructor(io, getCfg, now = () => performance.now() / 1000) {
    Object.assign(this, { io, getCfg, now });
    this.state = IDLE; this.game = null;
    this.prev = true;                    // the hotkey was down in the last tick (it must be let go once before it can fire)
    this.armed = false; this.opened = 0; this.lost = null;
    this.comboCache = [null, null];
    this.stepAt = 0; this.step = null; this.paste = false; this.tries = 0; this.t0 = 0;
    this.failed = false; this.inTick = false; this.nudged = false;
  }

  combo() {
    const text = this.getCfg().send_hotkey || hotkeys.DEFAULT;
    if (this.comboCache[0] !== text) {
      let parsed;
      try { parsed = hotkeys.parse(text); }
      catch { log.warn(`보내기 단축키가 올바르지 않아 기본값을 씁니다: ${JSON.stringify(text)}`); parsed = hotkeys.parse(hotkeys.DEFAULT); }
      this.comboCache = [text, parsed];
    }
    return this.comboCache[1];
  }

  // the box is open, translating, or giving the focus back: the window must take the keyboard / not hand the focus away
  get active() { return this.state !== IDLE; }

  async tick() {
    if (this.failed || this.inTick) return;
    this.inTick = true;
    try { await this.tickInner(); }
    catch (e) {
      log.error('보내기 번역 오류 - 이번 실행 동안 이 기능을 끕니다 ' + (e?.stack || e));
      this.failed = true; this.state = IDLE;
      try { await this.io.closeBox(); await this.io.say('⚠ ' + tr('보내기 번역에서 오류가 나서 이번 실행 동안 껐습니다 (로그 확인)'), true); } catch { /* ignore */ }
    } finally { this.inTick = false; }
  }

  async tickInner() {
    const cfg = this.getCfg();
    if (!(cfg.send_enabled ?? true)) {
      this.prev = true;
      if (this.state === OPEN || this.state === BUSY) await this.close(false);
      return;
    }
    if (this.state === BACK) await this.backStep();
    else if (this.state === OPEN || this.state === BUSY) await this.openStep();
    else {
      const g = await this.io.game();
      if (!g || !(await this.io.gameIsFront(g))) { this.prev = true; return; }       // the key must be let go once before it can trigger
      const down = await this.io.comboDown(this.combo());
      if (down && !this.prev) { this.prev = true; await this.open(g); }
      else if (!down) this.prev = false;
    }
  }

  label(cfg = null) { return tr('→ {lang}', { lang: (cfg || this.getCfg()).send_lang || 'English' }); }

  async open(game) {
    const cfg = this.getCfg();
    if ((cfg.translator ?? 'none') === 'none') { await this.io.say('⚠ ' + tr("번역 방식이 '사용 안 함'이라 보내기 번역을 쓸 수 없습니다 (옵션 → 번역)"), true); return; }
    this.game = game;
    if (!(await this.io.openBox(this.label(cfg)))) {
      log.warn('보내기 입력줄: 포커스를 가져오지 못했습니다');
      await this.io.say('⚠ ' + tr('입력줄로 포커스를 가져오지 못했습니다'), true);
      await this.giveBack();                                    // (the keyboard must not stay with this program without a window to type into: every key would only beep)
      return;
    }
    this.state = OPEN; this.armed = false; this.lost = null; this.opened = this.now();
    log.info('보내기 입력줄 열림');
  }

  async openStep() {
    const now = this.now();
    if (!this.armed && now - this.opened >= ARM_AFTER && !(await this.io.returnDown())) this.armed = true;
    if (this.state === BUSY) return;
    if (!(await this.io.selfIsFront())) {
      if (this.lost === null) this.lost = now;
      else if (now - this.lost > LOST_AFTER) {                 // the user switched to another program: forget the box
        log.info('보내기 입력줄: 포커스를 잃어 닫음');
        await this.close(false);
      }
    } else this.lost = null;
  }

  // Enter in the input line -> true when it was taken
  submit(raw) {
    if (this.state !== OPEN || !this.armed) return false;
    raw = (raw || '').trim();
    if (!raw) return false;
    this.state = BUSY;
    Promise.resolve(this.io.busyBox(tr('번역 중...'))).catch(() => {});
    const cfg = { ...this.getCfg() };
    this.io.translate(cfg, raw, (res, err) => this.done(res, err, cfg));
    return true;
  }

  async done(res, err, cfg) {
    if (this.state !== BUSY) return;                           // cancelled while translating
    this.state = OPEN;
    await this.io.readyBox(this.label(cfg));
    if (err) { await this.io.say('⚠ ' + err, true); return; }  // problems go to the chat window; the box stays open for another try
    if (!(await this.io.putClipboard(res.text))) { await this.io.say('⚠ ' + tr('클립보드에 복사하지 못했습니다'), true); return; }
    log.info(`보내기: 클립보드에 복사 (${new TextEncoder().encode(res.text).length}바이트)`);
    if (cfg.send_show_log ?? false) await this.io.showSent(res.text);
    if (res.note) await this.io.say(res.note);
    await this.close(true, !!cfg.send_autopaste);
  }

  async cancel() { if (this.state === OPEN || this.state === BUSY) await this.close(true); }

  async close(refocus, paste = false) {
    const was = this.state === OPEN || this.state === BUSY;
    this.state = IDLE;
    await this.io.closeBox();
    if (was && refocus) this.startBack(paste);
  }

  // the focus goes back to the game (the steps of backStep, one per tick)
  startBack(paste = false) { this.state = BACK; this.step = 'return'; this.paste = paste; this.t0 = this.now(); this.stepAt = 0; this.tries = 0; }
  async giveBack() { await this.io.closeBox(); this.startBack(false); }

  // The focus goes back. Never waits inside a step: every step is one tick (macOS tells which program is in front only while the
  // event loop runs).
  async backStep() {
    const now = this.now();
    if (now < this.stepAt) return;
    if (this.step === 'return') {
      if ((await this.io.returnDown()) && now - this.t0 < RETURN_WAIT) { this.stepAt = now + STEP; return; }       // let go of Enter first
      if (!(await this.io.focusGame(this.game))) { log.warn('와우로 포커스를 돌리지 못했습니다'); this.state = IDLE; return; }
      this.step = 'front'; this.t0 = now; this.nudged = false; this.tries = 0;
    } else if (this.step === 'front') {
      if (await this.io.gameIsFront(this.game)) await this.focusDone(now);
      else if (now - this.t0 > FRONT_WAIT) { log.warn('와우가 앞으로 오지 않았습니다'); await this.endNudge(); this.state = IDLE; }
      else if (!this.nudged && now - this.t0 > NUDGE_AFTER) { this.nudged = true; await this.io.nudgeGame(this.game); }          // (macOS: asking was not enough)
    } else if (this.step === 'paste') {
      if (!(await this.io.gameIsFront(this.game))) { await this.io.say('⚠ ' + tr('자동 붙여넣기를 하지 않았습니다: 와우가 활성 창이 아닙니다'), true); this.state = IDLE; }
      else if ((await this.io.modsDown()) && this.tries < PASTE_TRIES) { this.tries++; this.stepAt = now + STEP; }          // wait until the modifier keys are up
      else {
        if ((await this.io.paste()) === false) await this.io.say('⚠ ' + tr('자동 붙여넣기를 하지 않았습니다: 키 입력 권한이 없습니다 (시스템 설정 → 손쉬운 사용에서 Python 허용 후 다시 시작)'), true);
        this.state = IDLE;
      }
    }
  }

  async focusDone(now) {
    await this.endNudge();
    if (this.paste) { this.step = 'paste'; this.stepAt = now + PASTE_DELAY; this.tries = 0; }
    else this.state = IDLE;
  }

  async endNudge() { if (this.nudged) { this.nudged = false; await this.io.endNudge(); } }
}
