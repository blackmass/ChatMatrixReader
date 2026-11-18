// Settings of the chat windows (no window code): which channels a window shows, how its lines are headed and aligned, and the
// clean-up of the saved list. Port of winconf.py. Window 1 is the main window (top level of the config); the extra windows are
// a list. Window 2 (voice recognition) always exists. A setting an extra window does not have of its own is taken from window 1.

import { normalizeWidgets } from '../widgets/registry.js';

export const SPEECH_CODES = ['!MS', '!MY', '!ME', '!MW', '!MP', '!BE', '!BW'];
export const ETC = '!ETC';
export const KNOWN = ['S', 'Y', 'E', 'P', 'PL', 'R', 'RL', 'RW', 'I', 'IL', 'G', 'O', 'W', 'B', 'WT', 'BT', 'CM',
  ...Array.from({ length: 10 }, (_, i) => `C${i + 1}`), '!NPC', '!VC'];
export const VOICE_ID = 2;
export const ALIGNS = ['left', 'center', 'right'];
export const HEADS = ['detail', 'basic', 'nochan', 'body'];
export const MODES = ['always', 'voice', 'never'];
export const KEYS = {
  id: 0, name: '', open_mode: 'never', channels: [], geometry: '', font_family: '', font_size: 0, bg_opacity: 1.0, text_opacity: 1.0,
  topmost: true, topmost_wow_only: false, click_through: false, hover_clear: false, blur: 0, shadow: false, head_mode: 'basic', align: 'left', bottom: false,
  clear_on_open: false,                // an extra window: starts empty when it is opened (the hub's earlier lines are not given to it)
};
export const OPT_NUM = {
  max_lines: [50, 5000], font_weight: [100, 900], trans_font_size: [0, 32], line_spacing: [-20, 40], line_height: [-10, 40], group_spacing: [-20, 60], max_groups: [0, 50], indent: [0, 16],
  shadow_dx: [-8, 8], shadow_dy: [-8, 8], fade_sec: [0, 86400], outline: [0, 30], bold_fix: [-10, 10], letter_spacing: [-10, 20],
};
export const OPT_BOOL = ['show_time', 'class_colors', 'swap_trans', 'plain_text', 'whole_groups'];
export const OPT_STR = ['trans_color', 'shadow_color', 'outline_color'];
// What an extra window can leave EMPTY to follow window 1 (shown as "창 1을 따름"): numbers and text that can be typed, and the choices (a list has
// "창 1을 따름" on top). Not on / off switches and sliders: those are the window's own value with a "기본값" button.
//   empty = no key, null, '' (text), 0 (font_size).  The main window has no "follow": its empty text / 0 is the default.
export const FOLLOW = new Set([...Object.keys(OPT_NUM), ...OPT_STR, 'font_family', 'font_size', 'align', 'head_mode', 'blur']);
const EMPTY_TEXT = new Set([...OPT_STR, 'font_family']);       // '' is "empty" for these (an extra window follows window 1, the main window uses the default)
export const MAIN_KEY = { align: 'text_align', bottom: 'bottom_stick', shadow: 'shadow_on' };       // (names that differ in the main window's top level)

export const chanKey = code => (SPEECH_CODES.includes(code) ? '!NPC' : KNOWN.includes(code) ? code : ETC);

export function newConf(wid, channels = []) {
  return { ...structuredClone(KEYS), id: Math.trunc(wid), channels: [...channels] };
}
// a window made by the user: everything that can follow window 1 does (the choices are null = follow; text '' and size 0 already are)
export const followConf = (wid, channels = []) => ({ ...newConf(wid, channels), align: null, head_mode: null, blur: null });

// Python's int(): numbers truncate, numeric strings parse, everything else is an error
export function pyInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new TypeError('int');
}
function pyFloat(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new TypeError('float');
}
export const truthy = v => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length));

export function cleanColor(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return /^#[0-9a-fA-F]{6}$/.test(t) ? t.toLowerCase() : '';
}

// the saved list -> a clean list: objects with every key, unique ids, window 2 present
export function normalize(items) {
  const out = [], seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    let wid;
    try { wid = pyInt(it.id); } catch { continue; }
    if (wid < 2 || seen.has(wid)) continue;
    seen.add(wid);
    const d = newConf(wid);
    for (const k of Object.keys(KEYS)) if (k in it && k !== 'id') d[k] = it[k];
    const follows = ['align', 'head_mode', 'blur'].filter(k => it[k] === null);       // (3.0: an explicit null = follows window 1)
    if (!('open_mode' in it) && truthy(it.enabled)) d.open_mode = 'always';
    if (!MODES.includes(d.open_mode)) d.open_mode = 'never';          // ('voice' = only while the voice recognition is on: any extra window can have it; in 2.0 only window 2 could)
    d.channels = Array.isArray(d.channels) ? d.channels.filter(c => typeof c === 'string') : [];
    if ('opacity' in it && !('bg_opacity' in it) && !('text_opacity' in it)) d.bg_opacity = d.text_opacity = it.opacity;
    try {
      d.bg_opacity = Math.min(1.0, Math.max(0.03, pyFloat(d.bg_opacity)));
      d.text_opacity = Math.min(1.0, Math.max(0.2, pyFloat(d.text_opacity)));
      d.font_size = pyInt(d.font_size);
    } catch { d.bg_opacity = d.text_opacity = 1.0; d.font_size = 0; }
    try { d.blur = Math.min(3, Math.max(0, pyInt(d.blur))); } catch { d.blur = 0; }
    for (const k of ['topmost', 'topmost_wow_only', 'click_through', 'hover_clear', 'bottom', 'shadow', 'clear_on_open']) d[k] = truthy(d[k]);
    if (!ALIGNS.includes(d.align)) d.align = 'left';
    if (!HEADS.includes(d.head_mode)) d.head_mode = 'basic';
    for (const k of follows) d[k] = null;
    for (const [k, [lo, hi]] of Object.entries(OPT_NUM)) {
      if (k in it) { try { d[k] = Math.max(lo, Math.min(hi, pyInt(it[k]))); } catch { /* keeps following window 1 */ } }
    }
    for (const k of OPT_BOOL) if (k in it) d[k] = truthy(it[k]);
    for (const k of OPT_STR) if (k in it) d[k] = cleanColor(it[k]);
    if ('widgets' in it) d.widgets = normalizeWidgets(it.widgets);               // (3.0: the widgets of this window, only when it has some)
    if (d.topmost_wow_only) d.topmost = false;
    if (typeof d.name !== 'string') d.name = '';
    out.push(d);
  }
  if (!seen.has(VOICE_ID)) out.push(newConf(VOICE_ID, ['!VC']));
  out.sort((a, b) => a.id - b.id);
  return out;
}

export const nextId = items => Math.max(VOICE_ID, ...items.map(d => d.id)) + 1;

// is this setting of an extra window empty (it follows window 1)? Only for the settings in FOLLOW
export function followsMain(conf, key) {
  if (!FOLLOW.has(key)) return false;
  const v = conf[key];
  return v === undefined || v === null || (key === 'font_size' && !v) || (v === '' && EMPTY_TEXT.has(key));
}
// what "follow window 1" is written as in the entry of an extra window ('delete' = no key)
export const followValue = key => (key === 'font_size' ? 0 : EMPTY_TEXT.has(key) ? '' : key in OPT_NUM ? 'delete' : null);

// the value of a setting for the window `conf`: its own when it has one, else the main window's (`cfg`) - the settings in FOLLOW; the on / off ones (OPT_BOOL)
// are the window's own and fall back to the default `dflt`, not to window 1
export function opt(conf, cfg, key, dflt = null) {
  const v = conf[key];
  const empty = v === undefined || v === null || (key === 'font_size' && !v) || (v === '' && EMPTY_TEXT.has(key));
  if (!empty) return v;
  if (OPT_BOOL.includes(key) && conf !== cfg) return dflt;
  const m = cfg[MAIN_KEY[key] || key];
  return m === undefined ? dflt : m;
}

export function headMode(conf, cfg = null) {
  const m = conf.head_mode;
  if (HEADS.includes(m)) return m;
  if (cfg && conf !== cfg && m === null) return headMode(cfg);                        // an extra window that follows window 1
  return truthy(conf.channel_detail) ? 'detail' : 'basic';
}

export const accepts = (conf, code) => (conf.channels || []).includes(chanKey(code));
export const parentShows = (cfg, code) => !(cfg.win1_off || []).includes(chanKey(code));
export const validGeometry = g => /^\d+x\d+([+-]-?\d+[+-]-?\d+)?$/.test(g || '');
