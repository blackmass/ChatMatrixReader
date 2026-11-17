// The official widget: the voice recognition bar (docs/WIDGETS.md). It is an ordinary widget, `core:voice-level`; this file is its definition and the one thing
// only the program knows: how the state of the voice recognition becomes the state of the widget.
import { statusText, stateWhy } from '../core/voice_text.js';
import { captureText } from '../core/voice_target.js';

export const VOICE_ID = 'core:voice-level';

export const VOICE_WIDGET = {
  id: VOICE_ID, owner: 'core', label: '음성인식 음량바', kind: 'meter',
  styles: [{ id: 'bar', label: '얇은 막대' }, { id: 'battery', label: '작은 배터리' }],
  settings: [],
  hint: { place: 'inside', anchor: 'bottom-right' },
};

const DB_MIN = -70;                                          // the left end of the bar (the right end is 0 dB)
const unit = db => Math.max(0, Math.min(1, (db - DB_MIN) / -DB_MIN));
const dbOf = v => 20 * Math.log10(Math.max(v, 1e-6));

// s = the state of core/voice.js (state, capture, warn, texts ...), level = the last reading of `onLevel` ({ source, db, peak, speech, thr }) or null, tr = the translation
export function voiceWidgetState(s, level, tr) {
  const on = s.state === 'on', starting = s.state === 'starting';
  const active = on || starting;
  const lines = [s.state === 'error' ? tr('꺼져 있음') + ' · ' + stateWhy(s, tr) : statusText(s, tr)];
  const cap = active ? captureText(s.capture, tr) : '';
  if (cap) lines.push(cap);
  if (active && s.warn) lines.push('⚠ ' + s.warn);
  if (on && s.texts && s.texts.count) lines.push(tr('인식된 글 {n}개', { n: s.texts.count }));
  let tone = 'idle', text = tr('꺼짐'), value = 0, marker = null;
  if (s.state === 'error') { tone = 'bad'; text = tr('오류'); }
  else if (starting) { tone = 'busy'; text = tr('켜는 중'); }
  else if (on) {
    const c = s.capture, waiting = !c || c.mode === 'none' || c.mode === 'off';
    const reconnect = c && (c.status === 'retry' || c.status === 'reconnecting');
    const db = level ? (level.source === 'engine' ? level.db : dbOf(level.peak ?? level.level ?? 0)) : DB_MIN;
    value = unit(db);
    if (level && level.source === 'engine' && typeof level.thr === 'number') marker = unit(level.thr);
    if (s.warn) { tone = 'warn'; text = tr('소리 없음'); }
    else if (reconnect) { tone = 'busy'; text = tr('연결 중'); }
    else if (waiting) { tone = 'idle'; text = tr('소리 기다리는 중'); }
    else if (level && level.speech) { tone = 'hot'; text = tr('듣는 중'); }
    else { tone = 'ok'; text = tr('대기 중'); }
  }
  return { active, value, marker, tone, text, tip: lines.join('\n') };
}
