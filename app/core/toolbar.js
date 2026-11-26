// The function buttons of the bar of a translation window (docs/HANDOFF.md 4-0ah). Which buttons a window has, and in what order, is the setting `tools` of the window (an array of ids;
// the main window: the top level of the config). The close button is always there and is not in the list. A window that has no `tools` (every window of an older version, the first
// windows of a new installation) has LEGACY: the three buttons it always had. A window the user makes is saved with `tools: []` (only the close button).
import { tr } from './i18n.js';

export const LEGACY = ['research', 'voice', 'options'];
const VOICE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path class="waves" d="M11.2 5.4a3.6 3.6 0 0 1 0 5.2M13 3.6a6.2 6.2 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
// (the viewfinder: four corners and two lines of text inside)
const CAPTURE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 5V3a1 1 0 0 1 1-1h2M11 2h2a1 1 0 0 1 1 1v2M14 11v2a1 1 0 0 1-1 1h-2M5 14H3a1 1 0 0 1-1-1v-2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5 6.3h6M5 9.7h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

// id -> { cls: the class of the button (css), html: what it shows, title(): the text of its tooltip in the bar, hint(): what it is for (the tooltip in the options) }
export const TOOLS = {
  research: { cls: 'presearch', html: '⟳', title: () => tr('매트릭스 다시 찾기'), hint: () => tr('매트릭스(애드온이 채팅을 실어 보내는 그림)를 다시 찾습니다') },
  voice: { cls: 'pvoice', html: VOICE, title: () => tr('음성인식 켜기'), hint: () => tr('음성인식을 켜고 끕니다 (상태에 따라 색이 바뀝니다)') },
  options: { cls: 'poptions', html: '⚙', title: () => tr('옵션'), hint: () => tr('옵션 창을 엽니다') },
  capture: { cls: 'pcapture', html: CAPTURE, title: () => tr('수동 캡처'), hint: () => tr('화면에서 읽을 곳을 직접 골라 글을 읽고 번역합니다') },
};
export const IDS = Object.keys(TOOLS);

// a saved list -> a clean list: only the buttons that exist, each once, in the order given
export function clean(list) {
  const out = [];
  for (const id of Array.isArray(list) ? list : []) if (typeof id === 'string' && Object.hasOwn(TOOLS, id) && !out.includes(id)) out.push(id);
  return out;
}
// the setting of a window (absent / null / not a list = the window never chose) -> the buttons it shows
export const listOf = v => (Array.isArray(v) ? clean(v) : [...LEGACY]);
