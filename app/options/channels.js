// Names of the chat channels as the options show them.
export const NAMES = {
  S: '일반 대화', Y: '외침', E: '감정 표현', P: '파티', PL: '파티장', R: '공격대', RL: '공격대장', RW: '공격대 경보', I: '던전', IL: '던전 안내', G: '길드', O: '길드 관리',
  W: '귓속말 받음', WT: '귓속말 보냄', B: '배틀넷 받음', BT: '배틀넷 보냄', CM: '커뮤니티', '!NPC': 'NPC 대사', '!VC': '음성인식', '!OCR': 'OCR', '!PLG': '플러그인', '!ETC': '기타',
  C1: '사용자 채널 1', C2: '사용자 채널 2', C3: '사용자 채널 3', C4: '사용자 채널 4', C5: '사용자 채널 5',
  C6: '사용자 채널 6', C7: '사용자 채널 7', C8: '사용자 채널 8', C9: '사용자 채널 9', C10: '사용자 채널 10',
};
import { defaultColor, typeColor } from '../core/theme.js';
// The colour a channel has in the chat window: the one the game has for it (told by the lines, kept for the next start), until then the default
// (NPC / speech lines: the NPC colour).
const KEY = 'cmr-chan-colors';
const seen = (() => { try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } })();
export const chColor = c => seen[c] || defaultColor(c === '!NPC' ? '!MS' : c === '!ETC' ? 'other' : c);
// a line of the feed: its channel's colour (lines that carry their own colour say nothing about the channel)
export function noteChannelColor(event) {
  if (!event || event.type !== 'LineAdded' || !event.line || event.line.per_line) return;
  const code = event.line.code;
  if (typeof code !== 'string' || code.startsWith('!')) return;
  const color = typeColor(code, event.line.base);
  if (seen[code] === color) return;
  seen[code] = color;
  try { localStorage.setItem(KEY, JSON.stringify(seen)); } catch { /* not kept */ }
  for (const s of document.querySelectorAll('[data-ccode]')) if (s.dataset.ccode === code) s.style.color = color;
}
export const chName = c => NAMES[c] || c;
