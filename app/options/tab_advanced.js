// 고급: every timer of the program, changeable, with what it does and where it is used; and a live table of how much time they take.
// The values are the config key `tuning` ({ NAME: value }, core/timings.js); a value that is the default is simply not stored.
import { TUNE, DEFAULT_TUNING } from '../core/timings.js';
import { entries } from '../core/tuning.js';
import { tr } from '../core/i18n.js';
import { isMac } from '../platform.js';

// timers of the Windows sound capture (sound sessions, the gate): a Mac has none of them, so they are not shown there
const WINDOWS_ONLY = new Set(['VOICE_POLL_MS', 'VOICE_GATE_PERMILLE', 'VOICE_GATE_HOLD_MS', 'VOICE_LOSE_SEC']);

const rowFor = ([name, def, min, max, unit, group, label, where, desc]) => ({
  type: 'number', key: 'tuning', label, when: group === '음성인식' ? 'live' : undefined, keywords: `${name} ${where} ${desc}`, min, max, unit, def,
  note: `${desc}  ·  ${where}`,
  get: cfg => (cfg.tuning && typeof cfg.tuning[name] === 'number' ? cfg.tuning[name] : def),
  patch: (cfg, v) => {
    const t = { ...(cfg.tuning || {}) };
    if (v === def) delete t[name]; else t[name] = v;
    return { tuning: t };
  },
});

const groups = new Map();
for (const t of TUNE) { if (!groups.has(t[5])) groups.set(t[5], []); groups.get(t[5]).push(t); }

const fixed = new Map();
for (const e of entries()) { if (!fixed.has(e.group)) fixed.set(e.group, []); fixed.get(e.group).push(e); }

export default {
  id: 'advanced', title: '고급', subtitle: '프로그램이 몇 ms마다 무엇을 하는지 바꾸고, 그 일이 얼마나 걸리는지 봅니다',
  cards: [
    { title: '얼마나 걸리나', rows: [
      { type: 'perf', label: '', keywords: '부하 측정 사용률 프레임 cpu', names: Object.fromEntries(TUNE.map(t => [t[0], [t[6], t[1], t[4]]])) },
      { type: 'button', label: '모두 기본값으로', keywords: '초기화 되돌리기 기본값', action: ctx => ctx.set({ tuning: {} }) },
    ] },
    { title: '진단: 창 상태', rows: [{ type: 'diag', label: '', keywords: '작업표시줄 포커스 포그라운드 진단 noactivate' }] },
    ...[...groups].map(([title, list]) => ({ title, rows: list.filter(t => !(isMac && WINDOWS_ONLY.has(t[0]))).map(rowFor) })),
    ...[...fixed].map(([title, list]) => ({
      title: tr(title) + ' (' + tr('고정값') + ')',
      rows: list.map(e => ({ type: 'info', label: e.name, keywords: `${e.where} ${e.desc} ${e.unit}`, note: e.desc, text: () => `${e.value} ${tr(e.unit)}  ·  ${e.where}` })),
    })),
  ],
  DEFAULT_TUNING,
};
