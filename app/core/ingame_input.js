// What was typed in the game's own chat box and sent here by the addon (the command "@IN", docs/HANDOFF.md 4-0ae): it takes the same way as the
// send box (core/sendbox.js): the translation by the "send" settings (send_lang, send_route, the prompts), the result on the clipboard, and
// Ctrl+V into the game when "auto paste" is on (the player presses it himself when it is off). The window of the send box does not open: the
// player is still in the game's own chat box. It is the addon's own input box: the switch "use send" (send_enabled) of the reader's input window does not matter here.
//
// The lines of the command (channel "@IN"; the sender holds the order, the text what has to be told; the text is never empty):
//   sender "send,<n>"   text = what was typed     translate it; <n> numbers the request (the addon counts them)
//   sender "cancel,<n>" text "cancel"              the box was closed, or the addon gave up: the answer of <n> is not wanted any more
//   sender "state,1|0"  text "state"               the option "translate in the game's chat box" of the addon is on / off: while it is on the
//                                                  hotkey of the send box is stopped for this run if it is the same key (Shift+Enter), see SendBox.setHold
//
// The reader is patient for DEADLINE_S only (the addon gives up after 3 s, one second more than this: the lines need some time to come here):
// an answer that comes later is thrown away, so it never lands in the box after the addon has said "no translation". A newer request makes the
// older one useless too.
import { log } from './log.js';
import { tr } from './i18n.js';

export const DEADLINE_S = 2;
const BAD = n => !Number.isFinite(n) || n < 0;

// io: the same as the send box has: translate(cfg, raw, done) putClipboard(text) paste() say(text, error) showSent(text) game() gameIsFront(game)
// onHold(bool): the state of the addon's option
export class InGameInput {
  constructor({ getCfg, io, onHold = () => {}, now = () => performance.now() / 1000 }) {
    Object.assign(this, { getCfg, io, onHold, now });
    this.req = null;                                 // the request that is waited for: { n, at, dead }
    this.toldNone = false;                           // the note in the window is given once per run
  }

  // a line "@IN" (see above) -> nothing
  onLine(line) {
    const parts = String(line.sender ?? '').split(',');
    const cmd = parts[0];
    if (cmd === 'state') { this.onHold(parts[1] === '1'); return; }
    const n = Number(parts[1]);
    if (BAD(n)) return;
    if (cmd === 'cancel') { if (this.req && this.req.n === n) this.kill(this.req, 'cancelled by the addon'); return; }
    if (cmd === 'send') this.send(n, String(line.text ?? ''));
  }

  kill(req, why) { if (!req.dead) { req.dead = true; log.info(`게임 입력칸 번역 #${req.n}: 버림 (${why})`); } }

  send(n, raw) {
    const cfg = { ...this.getCfg() };
    if (this.req) this.kill(this.req, 'a newer one came');
    if ((cfg.translator ?? 'none') === 'none') {
      if (!this.toldNone) { this.toldNone = true; this.say('⚠ ' + tr("번역 방식이 '사용 안 함'이라 보내기 번역을 쓸 수 없습니다 (옵션 → 번역)"), true); }
      return;
    }
    const req = { n, at: this.now(), dead: false };
    this.req = req;
    log.info(`게임 입력칸 번역 #${n}: ${new TextEncoder().encode(raw).length}바이트`);
    try { this.io.translate(cfg, raw, (res, err) => this.finish(req, res, err, cfg)); }
    catch (e) { this.kill(req, 'translate failed: ' + (e?.message || e)); }
  }

  say(text, error = false) { try { Promise.resolve(this.io.say(text, error)).catch(() => {}); } catch { /* the window is not the matter of this */ } }

  async finish(req, res, err, cfg) {
    try {
      if (req.dead || this.req !== req) { log.info(`게임 입력칸 번역 #${req.n}: 늦게 와서 버림 (이미 끝난 요청)`); return; }
      if (this.now() - req.at > DEADLINE_S) { this.kill(req, `too late: ${(this.now() - req.at).toFixed(1)}s`); return; }
      req.dead = true;                                            // (answered: nothing else can happen to it)
      if (err) { await this.io.say('⚠ ' + err, true); return; }
      if (!(await this.io.putClipboard(res.text))) { await this.io.say('⚠ ' + tr('클립보드에 복사하지 못했습니다'), true); return; }
      log.info(`게임 입력칸 번역 #${req.n}: 클립보드에 복사 (${new TextEncoder().encode(res.text).length}바이트)`);
      if (cfg.send_show_log ?? false) await this.io.showSent(res.text);
      if (res.note) await this.io.say(res.note);
      if (cfg.send_autopaste) {
        const g = await this.io.game();
        if (g && await this.io.gameIsFront(g)) await this.io.paste();
        else log.info(`게임 입력칸 번역 #${req.n}: 게임이 앞에 없어 붙여넣지 않음`);
      }
    } catch (e) { log.error('게임 입력칸 번역 처리 오류', e); }
  }
}
