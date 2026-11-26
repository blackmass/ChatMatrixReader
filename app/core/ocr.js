// OCR assist (3.3): the words of the screen read as text, for the time the addon cannot give the chat (the lines are marked as read by OCR) and for a region the
// user picks. This file is what the options and the readers share: the choices and their names, what is available where. The reading itself comes in the files after it.
import { isMac } from '../platform.js';

// when the reader works. 'ondemand' and 'resident': the matrix is read as always; the OCR starts when the chat is restricted and stops when that is over; they differ in the
// engine: 'ondemand' makes it when the chat is restricted and lets it go after, 'resident' keeps it in memory while the OCR is on. (To try the reading with ordinary messages,
// the addon pretends that the chat is censored: /cm marks all)
export const WHEN = [['ondemand', '필요할 때만'], ['resident', '상주']];
export const WHEN_HINTS = {
  ondemand: '매트릭스는 평소처럼 읽습니다. 채팅이 제한(검열)되면 그때부터 OCR이 화면을 읽고, 제한이 끝나면 멈춥니다. OCR 엔진은 제한이 시작될 때 올리고 끝나면 내려서 평소에는 메모리를 쓰지 않습니다 (대신 시작할 때 준비하는 시간이 듭니다).',
  resident: '매트릭스는 평소처럼 읽습니다. 채팅이 제한(검열)되면 그때부터 OCR이 화면을 읽고, 제한이 끝나면 멈춥니다. OCR 엔진은 OCR을 켜 두는 동안 계속 메모리에 올려 두어서 제한이 시작되면 바로 읽습니다 (대신 메모리를 계속 씁니다).',
};

// who reads (the letters). The engines of the system are in the program; the ones that are added later come as extensions (extensions/ocr)
export const READERS = () => [['ai', 'AI 서버 (그림을 보는 모델)'], isMac ? ['vision', 'macOS Vision'] : ['windows', 'Windows OCR']];
export const READER_READY = { ai: true, windows: true, vision: true };

export const reader = cfg => (READERS().some(r => r[0] === cfg.ocr_read) ? cfg.ocr_read : 'ai');
export const readerWhy = id => (READER_READY[id] === false ? '아직 만들고 있습니다' : '');
// is the OCR assist on at all (the window mode "OCR 기능을 켤 때만" follows this)
export const ocrOn = cfg => !!(cfg && cfg.ocr_enabled);

// ---- the region the user picks. It is kept relative to the game window (its client area) so that it follows the window when the window moves.
const int = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
// the rectangle picked on the screen + the game window (both [x, y, w, h] in pixels of the screen) -> { x, y, w, h, gw, gh } or null (outside of the game window or too small)
export function regionFromScreen(rect, game) {
  if (!rect || !game) return null;
  const [rx, ry, rw, rh] = [rect.x, rect.y, rect.w, rect.h].map(int), [gx, gy, gw, gh] = game.map(int);
  if ([rx, ry, rw, rh, gx, gy, gw, gh].some(Number.isNaN) || gw <= 0 || gh <= 0) return null;
  const x = Math.max(0, rx - gx), y = Math.max(0, ry - gy);
  const w = Math.min(gw, rx + rw - gx) - x, h = Math.min(gh, ry + rh - gy) - y;       // (the part that is inside of the window)
  return w >= 8 && h >= 8 ? { x, y, w, h, gw, gh } : null;
}
// what is kept in the settings: a good region or null
export function cleanRegion(v) {
  if (!v || typeof v !== 'object') return null;
  const [x, y, w, h, gw, gh] = [v.x, v.y, v.w, v.h, v.gw, v.gh].map(int);
  return [x, y, w, h, gw, gh].every(n => Number.isInteger(n) && n >= 0) && w >= 8 && h >= 8 && gw >= w && gh >= h ? { x, y, w, h, gw, gh } : null;
}
// the region for a game window of another size (the window was resized or the game's resolution changed): the same part of the window
export function regionFor(region, gw, gh) {
  const r = cleanRegion(region);
  if (!r || !(gw > 0) || !(gh > 0)) return null;
  const fx = gw / r.gw, fy = gh / r.gh;
  return { x: Math.round(r.x * fx), y: Math.round(r.y * fy), w: Math.max(8, Math.round(r.w * fx)), h: Math.max(8, Math.round(r.h * fy)) };
}

// the time the game writes in front of a line ("[17:08:44]", "17:08:44", "5:08 PM", with or without brackets) is taken off: the window writes its own. Only the very first thing of the
// line, and only when a space (or a bracket) follows it, so a time inside of the words stays
const STAMP = /^\s*[\[(]?\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?[\])]?(?=[\s\[]|$)\s*/;
export const stripStamp = text => String(text ?? '').replace(STAMP, '');
