// The widgets (docs/WIDGETS.md): definitions, the settings of a window, the state store, the official voice widget, the hub.
import { check, eq } from './helpers.mjs';
import * as W from '../app/widgets/registry.js';
import { voiceWidgetState, VOICE_WIDGET, VOICE_ID } from '../app/widgets/core_voice.js';
import { defaultRegistry } from '../app/widgets/defaults.js';
import * as winconf from '../app/core/winconf.js';
import { tr } from '../app/core/i18n.js';

// ---- definitions
const d = W.checkDef({ id: 'demo:status', label: 'Demo', kind: 'meter', styles: [{ id: 'bar', label: 'Bar' }, { id: 'nope', label: 'x' }, { id: 'battery', label: 'Batt' }],
  settings: [{ key: 'warn_at', type: 'number', label: 'Warn', min: 0, max: 10, def: 99 }, { key: 'bad key', type: 'check' }, { key: 'm', type: 'script' }, { key: 'c', type: 'color', def: '#ABCDEF' },
    { key: 's', type: 'select', options: [['a', 'A'], ['b', 'B']], def: 'zz' }] });
check(d.owner === 'demo' && d.kind === 'meter' && d.styles.map(s => s.id).join() === 'bar,battery', 'a definition: the owner is read from the id, the looks the kind does not have are left out');
check(d.settings.map(s => s.key).join() === 'warn_at,c,s' && d.settings[0].def === 10 && d.settings[1].def === '#abcdef' && d.settings[2].def === 'a', 'its own options: wrong keys and types are left out, the defaults are made to fit');
check(W.checkDef({ id: 'demo:x', kind: 'sparkle' }).kind === 'text' && W.checkDef({ id: 'demo:x', kind: 'light', styles: [] }).styles[0].id === 'dot', 'an unknown kind is drawn as text; a widget always has a look');
let err = ''; for (const bad of [null, { id: 'nocolon' }, { id: 'a b:c' }, { id: 'x:y', owner: 'other' }]) { try { W.checkDef(bad); } catch (e) { err += '1'; } }
check(err === '1111', 'a wrong definition is refused');
const reg = new W.Registry(); reg.register(VOICE_WIDGET);
check(reg.get(VOICE_ID).kind === 'meter' && reg.list().length === 1 && defaultRegistry().get('core:voice-level') && !reg.get('x:y') && reg.unregister(VOICE_ID) && !reg.get(VOICE_ID), 'the registry');

// ---- the settings of a window
const w = W.normalizeWidgets({
  'core:voice-level': { place: 'sideways', anchor: 'middle', dx: 9999, dy: -9999.6, style: 'bat tery', show: 'sometimes', scale: 9, opacity: 0, opts: { a: 1, b: true, c: 'x'.repeat(100), d: {}, 'bad key': 1 } },
  'other:thing': { place: 'outside', anchor: 'left', style: 'star' }, 'bad id': { place: 'inside' }, 'x:y': 'no', 'z:w': null });
const e = w['core:voice-level'];
check(e.place === 'inside' && e.anchor === 'bottom-right' && e.dx === 400 && e.dy === -400 && e.style === '' && e.show === 'always' && e.scale === 3 && e.opacity === 0.2, 'wrong values are made to fit (clamped, or the default)');
check(Object.keys(e.opts).join() === 'a,b,c' && e.opts.c.length === 64, 'the options of a widget: plain values only, short');
check(Object.keys(w).join() === 'core:voice-level,other:thing' && w['other:thing'].place === 'outside' && w['other:thing'].style === 'star', 'a widget the program does not know is KEPT (a plugin that is off keeps its settings); a wrong id or entry is dropped');
const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p:w${i}`, { place: 'inside' }]));
check(Object.keys(W.normalizeWidgets(many)).length === W.MAX_WIDGETS && Object.keys(W.normalizeWidgets('x')).length === 0 && Object.keys(W.normalizeWidgets(null)).length === 0, 'at most 32 widgets; not an object: none');
const de = W.defaultEntry(VOICE_WIDGET);
check(de.place === 'inside' && de.anchor === 'bottom-right' && de.style === 'bar' && de.show === 'always' && de.dx === 0 && de.scale === 1, 'a widget that is turned on: the place it suggests, its first look, always shown');
check(W.drawn({ a: { place: 'inside' }, 'b:c': { place: 'inside', anchor: 'top' }, 'd:e': { place: 'outside' } }).map(x => x.id).join() === 'b:c', 'drawn: only what is inside (outside waits)');
const cfg = { widgets: { 'core:voice-level': { place: 'inside' } }, child_windows: [{ id: 3, widgets: { 'demo:status': { place: 'inside' }, 'demo:other': { place: 'outside' } } }, { id: 4 }, null] };
check([...W.usedIds(cfg)].sort().join() === 'core:voice-level,demo:status' && W.usedIds({}).size === 0, 'the ids a window of the settings shows (the main window and the extra windows)');
// saved in a window entry and in the main settings
const kept = winconf.normalize([{ id: 3, widgets: { 'core:voice-level': { anchor: 'top' }, 'demo:x': { place: 'outside' } } }, { id: 4 }]);
check(kept.find(c => c.id === 3).widgets['core:voice-level'].anchor === 'top' && kept.find(c => c.id === 3).widgets['demo:x'] && !('widgets' in kept.find(c => c.id === 4)), 'an extra window keeps its widgets, and has none unless it was given some (nothing new in an old entry)');

// ---- the state
const st = new W.StateStore();
const s1 = st.set('a:b', { value: 5, tone: 'sparkle', text: 'x'.repeat(99), tip: 'tip', active: 1, marker: -3, count: 1e9, extra: 'ignored' });
check(s1.value === 1 && s1.tone === 'idle' && s1.text.length === 40 && s1.marker === 0 && s1.count === 99999 && s1.active === true && !('extra' in s1), 'a state is made to fit: the value 0..1, a tone from the list, short texts');
check(st.set('a:b', { value: 1 }) === null && st.set('a:b', { value: 0.5 }).value === 0.5 && st.get('a:b').tip === 'tip' && st.get('nope') === null, 'a change merges; the same state again says "nothing changed"');

// ---- the official widget
const s = (o = {}) => ({ state: 'on', engine: 'cpu', model: 'small', device: 'cpu', capture: { mode: 'process', program: 'Discord.exe', pid: 4, status: 'listening' }, warn: '', texts: { count: 3, last: 0 }, ...o });
const eng = (db, speech, thr = -44.4) => ({ source: 'engine', db, peak: 0.1, speech, thr });
let v = voiceWidgetState({ state: 'off' }, null, tr);
check(v.active === false && v.tone === 'idle' && v.value === 0 && v.text === '꺼짐' && v.tip === '꺼져 있음', 'off: idle, empty, the tip says so');
v = voiceWidgetState({ state: 'starting' }, null, tr);
check(v.active === true && v.tone === 'busy' && v.text === '켜는 중', 'starting: busy');
v = voiceWidgetState(s(), eng(-35, true), tr);
check(v.tone === 'hot' && Math.abs(v.value - 0.5) < 1e-9 && Math.abs(v.marker - (-44.4 + 70) / 70) < 1e-9 && v.text === '듣는 중', 'on and speech heard: hot, the value from the dB (-70..0), the speech limit as the mark');
v = voiceWidgetState(s(), eng(-60, false), tr);
check(v.tone === 'ok' && v.text === '대기 중', 'on, nothing said: ok');
v = voiceWidgetState(s({ capture: { mode: 'none', status: 'waiting' } }), eng(-80, false), tr);
check(v.tone === 'idle' && v.text === '소리 기다리는 중' && v.value === 0, 'on, the program does not play: idle, waiting for sound');
v = voiceWidgetState(s({ capture: { mode: 'none', status: 'reconnecting' } }), null, tr);
check(v.tone === 'busy' && v.text === '연결 중', 'the capture connects again: busy');
v = voiceWidgetState(s({ warn: '프로그램에서 8초 동안 소리가 나지 않았습니다.' }), eng(-80, false), tr);
check(v.tone === 'warn' && v.text === '소리 없음' && v.tip.includes('⚠'), 'a warning of the capture: warn, in the tip too');
v = voiceWidgetState({ state: 'error', code: 'no_model', msg: 'large-v3' }, null, tr);
check(v.tone === 'bad' && v.tip.includes('large-v3') && v.active === false, 'error: bad, with the reason');
v = voiceWidgetState(s({ capture: { mode: 'device', device: 'Headset', program: 'D.exe', status: 'listening' } }), { source: 'capture', peak: 0.1, gate: true }, tr);
check(Math.abs(v.value - (-20 + 70) / 70) < 1e-9 && v.marker === null, 'without the engine\'s reading the loudness of the capture is used (no mark)');
v = voiceWidgetState(s(), eng(-35, true), tr);
check(v.tip.split('\n').length === 3 && v.tip.includes('켜져 있음 · Whisper · CPU · small') && v.tip.includes('Discord.exe') && v.tip.includes('인식된 글 3개'), 'the tip: the state, how the sound is received, the number of texts');

// ---- the hub
const sent = [], handlers = {};
const { startWidgets } = await import('../app/widgets/hub.js');
let cfg2 = { widgets: {}, child_windows: [] };
const hub = startWidgets({ settings: { cfg: () => cfg2 }, emit: (n, p) => sent.push([n, p]), listen: (n, f) => { handlers[n] = f; } });
hub.publish(VOICE_ID, { tone: 'hot', value: 0.5 });
check(sent.length === 0 && hub.store.get(VOICE_ID).tone === 'hot', 'nobody shows the widget: the state is kept, nothing is sent');
cfg2 = { widgets: { [VOICE_ID]: { place: 'inside' } }, child_windows: [] };
hub.publish(VOICE_ID, { value: 0.6 });
check(sent.length === 1 && sent[0][0] === 'widget-state' && sent[0][1].id === VOICE_ID && sent[0][1].state.value === 0.6 && sent[0][1].state.tone === 'hot', 'a window shows it: the change is sent (the whole state)');
hub.publish(VOICE_ID, { value: 0.6 });
check(sent.length === 1, 'the same state again: nothing is sent');
sent.length = 0; handlers['widget-hello']({ payload: { ids: [VOICE_ID, 'none:here'] } });
check(sent.length === 1 && sent[0][1].id === VOICE_ID, 'a window that asks (it was opened) gets the states it needs');

{ // the definitions of the plugins reach a page's registry: exactly these besides the program's own
  const reg = new W.Registry(); reg.register(VOICE_WIDGET);
  const PL = 'a-long-plugin-id-0123456789abcdef-0123456789';
  const def = n => ({ id: `${PL}:${n}`, label: n, kind: 'text' });
  W.syncPluginDefs(reg, [def('one'), def('two'), { id: 'core:evil', label: 'x' }, null]);
  eq(reg.list().map(d => d.id).sort(), [`${PL}:one`, `${PL}:two`, 'core:voice-level'], 'widgets: the plugin definitions are put in; a core: id from outside and a null are not');
  W.syncPluginDefs(reg, [def('two')]);
  eq(reg.list().map(d => d.id).sort(), [`${PL}:two`, 'core:voice-level'], 'widgets: one that is not told any more is taken out, the program\'s own stays');
  let n = 0; reg.onChange(() => n++); W.syncPluginDefs(reg, [def('two')]);
  eq(n, 0, 'widgets: the same definitions again change nothing');
}
