// The translation of a tooltip of the game in the hub (docs/HANDOFF.md 4-0aa, 4-0ab): the three lines of the addon ("@TS" show, "@TK" alive, "@TH" hide, see core/tip_translate.js) are watched, the
// words are read from a picture of their place with OCR (the reader of the OCR tab; the words of a party finder comment are protected: the addon cannot give them), translated by the translation tab's
// way (the service of the hub: its memories, the glossary), and the translation is shown next to the tooltip of the game by the center that stays above the game.
import { TipTr, TIP_CODES } from './core/tip_translate.js';
import { skipReason } from './core/translate_rules.js';
import * as theme from './core/theme.js';
import { tr } from './core/i18n.js';

// pipeline: observe(fn); service: submit(token, text, route); settings: cfg(); capture: game { rect, front, found }, clientSize(), grabClient(x, y, w, h); emit(name, payload): to the centers
// ocr: { canRead(), readFree(pic) } (ocr_host.js)
const PAD = 4;                              // (pixels of the game around the words in the picture that is read)
const GAP_X = 16, RISE = 2;                 // (pixels of the game: our tooltip is this far to the right of the words of the listing, and this much higher)
export function startTips({ pipeline, service, settings, capture, emit, ocr = null, now = () => performance.now() / 1000, tickMs = 250 }) {
  const waiting = new Map();                  // token -> cb (the tokens are negative: no line of the chat has one)
  let seq = 0;

  const translate = (text, cb) => {
    const token = --seq;
    waiting.set(token, cb);
    let taken;
    try { taken = service.submit(token, text, null); } catch (e) { taken = false; }
    if (!taken && waiting.delete(token)) cb(null, tr('번역 대기열이 가득 차서 일부 줄을 번역하지 못했습니다'));
  };
  // the answer of the service for a token of ours (true), or not ours (false: it is a line of the chat)
  const take = (token, result, err) => {
    const cb = waiting.get(token);
    if (!cb) return false;
    waiting.delete(token);
    cb(result, err);
    return true;
  };

  // a place in the pixels the addon counts in (the screen the game renders to, y from the bottom) -> the pixels of the screen, and the scale from those pixels to these
  const placed = (r, p) => {
    const g = capture.game;
    if (!g || !g.found || !g.rect || !(p.pw > 0) || !(p.ph > 0)) return null;
    const [gx, gy, gw, gh] = g.rect, sx = gw / p.pw, sy = gh / p.ph;
    return { rect: [Math.round(gx + r.left * sx), Math.round(gy + (p.ph - (r.bottom + r.height)) * sy), Math.round(r.width * sx), Math.round(r.height * sy)], sx, sy };
  };

  // the words of a place (physical screen pixels of the game, y from the bottom) -> the picture of it (the pixels of the game window) -> the words (OCR). What was read is kept by leader + the picture.
  const seen = new Map();                     // leader + picture -> the words (the newest last)
  const sign = pic => { let h = 2166136261; const px = pic.px, step = Math.max(1, Math.floor(px.length / 4 / 2000)) * 4; for (let i = 0; i < px.length; i += step) { h ^= Math.max(px[i], px[i + 1], px[i + 2]) >> 4; h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ':' + pic.width + 'x' + pic.height; };
  const read = async (p, cb) => {
    try {
      const size = capture.clientSize();
      if (!size) throw new Error(tr('게임 창을 찾지 못했습니다 (게임이 켜져 있고 최소화되지 않았는지 확인하세요).'));
      const c = p.capture, sx = size.width / p.pw, sy = size.height / p.ph;
      const x0 = Math.max(0, Math.round((c.left - PAD) * sx)), x1 = Math.min(size.width, Math.round((c.left + c.width + PAD) * sx));        // (the picture is a little larger than the words: it is not cut at the letters)
      const y0 = Math.max(0, Math.round((p.ph - (c.bottom + c.height + PAD)) * sy)), y1 = Math.min(size.height, Math.round((p.ph - (c.bottom - PAD)) * sy));
      const x = x0, w = x1 - x0, y = y0, h = y1 - y0;
      if (w < 4 || h < 4) throw new Error('the place of the words is too small');
      const pic = await capture.grabClient(x, y, w, h);
      const key = p.kind + '\u0001' + p.leader + '\u0001' + sign(pic);
      if (seen.has(key)) { const v = seen.get(key); seen.delete(key); seen.set(key, v); cb(v, null); return; }     // (the same listing and the same picture: not read again)
      const text = String(await ocr.readFree(pic) || '').trim();
      if (text) { seen.set(key, text); while (seen.size > 200) seen.delete(seen.keys().next().value); }
      cb(text, null);
    } catch (e) { cb(null, String(e && e.message || e)); }
  };

  const tt = new TipTr({
    read, canRead: () => !!(ocr && ocr.canRead()),
    translate,
    skip: text => skipReason(text, settings.cfg()) !== '',
    show: p => {
      // the words of the listing: our tooltip stands GAP_X pixels to the right of them, RISE pixels higher (the pixels of the game); a tooltip with no place of words: next to the tooltip of the game
      const pl = p.capture ? placed(p.capture, p) : placed(p.rect, p);
      if (!pl) return;
      const lines = p.busy ? [tr('번역 중…')] : String(p.text).split('\n').filter(l => l.trim());
      emit('tip-show', { mode: 2, html: theme.tipHtml(lines, true), rect: pl.rect, dx: Math.round((p.capture ? GAP_X : 6) * pl.sx), dy: p.capture ? -Math.round(RISE * pl.sy) : 0 });
    },
    hide: () => emit('tip-hide', { mode: 2 }),
    front: () => !!(capture.game && capture.game.front),
    now,
  });
  pipeline.observe(line => { if (TIP_CODES.includes(String(line.channel ?? ''))) { try { tt.onLine(line); } catch { /* a tooltip must never disturb the chat */ } } });
  const timer = tickMs > 0 ? setInterval(() => { try { tt.tick(); } catch { /* the same */ } }, tickMs) : null;
  return { take, tip: tt, stop: () => { if (timer) clearInterval(timer); } };
}
