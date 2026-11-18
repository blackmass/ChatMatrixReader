// The settings (config.json in the program folder): the defaults, "what a file holds -> the settings the program uses", the move
// from 1.x, and reading/writing through the files API. Port of config.py + migrate.py. The format is the one of 2.0 (config_version 2):
// flat, window 1's settings are the main keys, `child_windows` the others.
//   3.0 additions: `plugins` (docs/PLUGINS.md: { <id>: { enabled, granted } }); blur 3 (Windows 11 acrylic) is read as 2.
import { log, fmt } from './log.js';
import { tr } from './i18n.js';
import * as winconf from './winconf.js';
import { pyInt, truthy } from './winconf.js';
import { normalizeWidgets } from '../widgets/registry.js';
import { DEFAULT_PROMPT, DEFAULT_EXTRA_PROMPT, DEFAULT_SEND_EXTRA_PROMPT, DEFAULT_SEND_PROMPT } from './prompts.js';
import { LEGACY_DEFAULT_PROMPTS } from './prompts_legacy.js';
import { DEFAULT_REASONING_OFF } from './translate.js';

export const PATH = 'config.json';
export const VERSION = 3;                      // the format of config.json; a file without it comes from 1.x. 2 -> 3: line_height (see carryLineHeight)

export const DEFAULTS = {

    // translation
    translator: 'google',   // none | openai | google | custom
    target_lang: '한국어',
    language: '',   // '' = system language, else a locale/<code>.txt name (ko-KR = built in)
    api_url: 'http://localhost:1234/v1',
    api_model: '',
    api_key: '',
    custom_preset: '',   // custom HTTP translator: preset name (informational) and the request settings
    custom_key: '',
    custom_url: '',
    custom_headers: '{}',
    custom_body_type: 'json',   // json | form
    custom_body: '',
    custom_path: '',   // where the translation is in the answer, e.g. translations.0.text
    google_free: false,   // True: the main method is Google without the API key (the key field is kept but not used)
    google_api_key: '',   // optional; empty = free unofficial endpoint
    prompt: DEFAULT_PROMPT,
    extra_prompt: DEFAULT_EXTRA_PROMPT,   // the user's own additional instructions, added to the end of the prompt (style ...)
    glossary_file: 'Glossary.txt',   // a file name in the program folder
    glossary_google: true,   // also apply the glossary to Google translation
    glossary_mode: 'full',   // AI: full = the whole glossary in the prompt | list = the entries that occur in the line, before it | mixed = single meanings in parentheses, the rest listed
    glossary_style: 'paren',   // paren: LFM(구인) | replace: 구인
    disable_reasoning: true,
    reasoning_off_body: DEFAULT_REASONING_OFF,
    temperature: 0.2,
    timeout: 30,
    max_tokens: 300,
    skip_same_lang: true,
    channel_route: {},   // channel code -> 'google_free' | 'google' | 'openai' | 'custom' | 'off' (missing = the translation tab's method)
    win1_off: [],   // channels NOT shown in the main window (empty = all; see winconf.py)
    child_windows: [],   // extra windows (winconf.py): id, name, enabled, channels, geometry, font_family, font_size, opacity
    blur: 0,   // blur behind the chat window: 0 off | 1 weak | 2 strong (per window; this is window 1). 2.0's 3 (Windows 11 acrylic) is gone: read as 2
    hover_clear: false,   // click-through only: the window turns fully transparent while the mouse is over it
    prompt_update_notice: true,   // tell when the prompt differs from the newest default (a note at the start, a dot in the options)
    skip_regex_hide: false,   // also leave the matching lines out of the window (not only untranslated)
    skip_regex: '',   // lines matching this regular expression are not translated (empty = off)
    max_pending: 20,
    log_request: false,   // write the full request (prompt) of every translation into the log
    max_parallel: 2,
    // send box: type in your own language, get the translation on the clipboard
    send_enabled: true,
    send_route: 'default',   // the translation method for sending: 'default' = the translation tab's | google_free | google | openai | custom
    send_lang: 'English',
    send_hotkey: 'Shift+Enter',
    send_show_log: false,   // show the translated text sent (the '↗' line) in the window; off: it comes back as a chat line
    send_autopaste: false,   // press Ctrl+V in the game for you (off: you press it)
    send_prompt: DEFAULT_SEND_PROMPT,
    send_extra_prompt: DEFAULT_SEND_EXTRA_PROMPT,   // the user's own additional instructions for the send translation
    // voice recognition (optional extension in extensions/stt, see voice.py)
    voice_enabled: false,   // on: started with the program (and by the options)
    voice_target: 'discord',   // discord | discord-all | wow | system | app: whose sound is recognised (app: the program in voice_app)
    voice_app: '',   // the program picked from the list (file name, e.g. chrome.exe): remembered, used when voice_target is 'app'
    voice_capture: 'auto',   // auto | process | device: how the sound of the program is received (core/voice_target.js)
    voice_lang: 'auto',   // language spoken in the voice chat ('auto' = detect for every sentence)
    voice_mode: 'sentence',   // sentence: one text when a sentence is finished | live: the text while it is spoken (Whisper: not recommended)
    voice_partial_ms: 1000,   // live mode: how often the text so far is updated
    voice_end_ms: 700,   // quiet time (ms) that ends a sentence
    voice_device: 'auto',   // auto | cuda | cpu
    voice_model: '',   // '' = the extension's default (large-v3-turbo)
    voice_prompt: '',   // a hint for the recogniser: words that come up often (empty = none)
    voice_min_db: -44,   // the quietest sound (dB) that can be speech: quieter is silence (the noise around makes the limit higher by itself)
    voice_max_s: 12,   // longest piece of speech recognised at once (longer speech is cut there)
    voice_engine: 'whisper',   // whisper (on this PC) | openai (a server with the OpenAI speech-to-text API)
    voice_oa_url: '',   // openai: e.g. http://localhost:8000/v1
    voice_oa_key: '',   // openai: API key (empty = none; sent to the child through its environment)
    voice_oa_model: '',   // openai: model name on that server ('' = whisper-1)
    voice_oa_format: 'json',   // openai: json | verbose_json
    voice_oa_timeout: 30,   // openai: seconds to wait for the server
    // window
    bg_opacity: 1.0,   // background (the dark area)
    text_opacity: 1.0,   // text, title bar, scrollbar
    topmost: true,   // above every other window
    exit_with_game: false,   // quit this program 5 s after the game has been closed
    topmost_wow_only: false,   // only just above the game window, behind all other windows
    wow_window_title: 'World of Warcraft',
    interact_keys: ['Shift'],   // click-through: this window takes the mouse while ALL of these keys are held (Shift / Ctrl / Alt)
    click_through: false,
    font_size: 11,
    shadow_on: false,   // draw a copy of the text in shadow_color, shifted by (shadow_dx, shadow_dy)
    shadow_color: '#000000',
    shadow_dx: 1,
    shadow_dy: 1,
    translate_test_start: true,   // at start, send a tiny test request so the user sees whether the translation server answers
    check_updates: true,   // look for a newer GitHub release at start (a notice only, nothing is installed)
    font_family: '',   // '' = default (Malgun Gothic); else a font loaded from the fonts/ folder
    line_spacing: 0,   // pixels between an original line and its translation (inside a group)
    whole_groups: false,   // only whole groups are shown at the newest line: the one cut at the top edge of the window is hidden (reading above shows all)
    max_groups: 0,   // only this many of the newest groups are shown (0 = no limit; reading above shows all)
    line_height: 0,   // extra pixels between the rows of ONE text that is long enough to wrap onto several rows (1.x / 3.0.x: line_spacing did this too)
    indent: 4,   // left alignment: spaces the 2nd row of a long line and the translation line are pushed in
    group_spacing: 4,   // extra pixels between groups (an original line + its translation)
    trans_color: '',   // colour of the translated text ('' = default)
    swap_trans: false,   // translation above, the original below it (in the second-line colour / size)
    outline: 0,   // text outline in tenths of a pixel (0 off .. 30), drawn in outline_color
    outline_color: '#000000',
    bold_fix: 0,   // > 0: the glyphs grow by this many tenths of a pixel; < 0: a thin line in the outline colour over their edge, 0.03px a step (-10 .. 10, 0 off)
    letter_spacing: 0,   // extra space between letters, in tenths of a pixel (-10 .. 20)
    plain_text: false,   // no kerning / ligatures
    font_weight: 400,   // weight of the text, 100..900 (CSS font-weight; 400 = normal, 700 = bold)
    trans_font_size: 0,   // size of the translated text (0 = same as the original)
    class_colors: true,   // colour the speaker's name by class (needs the addon to send the class)
    bottom_stick: false,   // few lines sit at the bottom of the window (new lines push the older ones up)
    text_align: 'left',   // left | center | right: where the lines sit in the window
    head_mode: '',   // what stands before a line: detail | basic | nochan | body ('' = from channel_detail)
    channel_detail: false,   // show the line codes '(S) (W→) (C1) (!LT)' as before; off: only '(1)' for numbered channels
    show_time: true,   // prefix every line with the time it was read
    max_lines: 500,
    fade_sec: 0,   // a line (with its translation) older than this many seconds is hidden; scrolling up shows it again (0 = never)
    geometry: '560x420',
    options_geometry: '',   // the options window's own size and place ('WxH+X+Y'; empty = the default)
    // capture
    poll_hz: 30,
    last_pos: null,   // [x, y] where the matrix was found last time (looked at first, every second)
    full_scan_sec: 30,   // whole-screen search while the matrix is missing: at most this often (seconds)
    // plugins (docs/PLUGINS.md)
    plugins: {},                           // plugin id -> { enabled: bool, granted: [permission names] }
    widgets: {},                           // the widgets of the main window: { 'owner:name': { place, anchor, dx, dy, style, show, scale, opacity, opts } } (docs/WIDGETS.md)
    wheel_through: false,                  // click-through windows: the wheel over them may scroll (reading the earlier chat); off = nothing but the tooltip gets through
    through_tips: true,                    // click-through windows: the tip of a link (item, quest ...) under the mouse is shown (the page cannot see the mouse: the window loop does)
    auto_copy: false,                      // the text selected in a window is copied when the mouse leaves the window
    tuning: {},                            // options tab 고급: { NAME: value } of the timers in core/timings.js (missing = the default)
};

// keys that 1.x had and nothing has now
const OBSOLETE = new Set(['blur_experiment', 'blur_state', 'blur_tint', 'capture_method', 'capture_captureblt', 'options_pos', 'options_size',
  'opacity', 'voice_translate', 'glossary_inline', 'manual_pos', 'channel_detail_old']);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);

// Until 3.0.x "line_spacing" was the height of every row, so it also spread the rows of a long text. Now it is only the space between an original and its
// translation, and the new "line_height" is the row height. A file from before copies the old value into the new setting once, so nothing looks different.
function carryLineHeight(saved) {
  const out = structuredClone(saved);
  if (!own(out, 'line_height') && typeof out.line_spacing === 'number') out.line_height = out.line_spacing;
  if (Array.isArray(out.child_windows)) for (const w of out.child_windows) if (isObj(w) && !own(w, 'line_height') && typeof w.line_spacing === 'number') w.line_height = w.line_spacing;
  return out;
}

// what a file holds -> the settings the program uses: missing keys get their defaults, old spellings are brought up to date
export function normalize(saved) {
  const cfg = structuredClone(DEFAULTS);
  const s = isObj(saved) ? saved : {};
  Object.assign(cfg, structuredClone(s));
  if (own(cfg, 'opacity') && !own(s, 'bg_opacity')) { cfg.bg_opacity = cfg.text_opacity = cfg.opacity; }     // the older single-slider version
  delete cfg.opacity;
  const vt = own(cfg, 'voice_translate') ? cfg.voice_translate : true; delete cfg.voice_translate;
  if (vt === false && !(isObj(cfg.channel_route) && own(cfg.channel_route, '!VC'))) cfg.channel_route = { ...(isObj(cfg.channel_route) ? cfg.channel_route : {}), '!VC': 'off' };
  cfg.child_windows = winconf.normalize(cfg.child_windows);
  for (const w of cfg.child_windows) if (w.blur === 3) w.blur = 2;
  if (cfg.blur === 3) cfg.blur = 2;
  if (!Array.isArray(cfg.win1_off)) cfg.win1_off = [];
  if (!isObj(cfg.channel_route)) cfg.channel_route = {};
  if (!isObj(cfg.plugins)) cfg.plugins = {};
  cfg.widgets = normalizeWidgets(cfg.widgets);
  if (!isObj(cfg.tuning)) cfg.tuning = {};
  cfg.wheel_through = cfg.wheel_through === true;
  cfg.through_tips = cfg.through_tips !== false;
  cfg.auto_copy = cfg.auto_copy === true;
  const gi = cfg.glossary_inline; delete cfg.glossary_inline;
  if (truthy(gi)) cfg.glossary_mode = 'list';                 // (replaced by glossary_mode)
  const mp = cfg.manual_pos; delete cfg.manual_pos;           // (removed option) an old manual position becomes the first guess
  if (truthy(mp) && !truthy(cfg.last_pos)) {
    try { cfg.last_pos = [pyInt(mp[0]), pyInt(mp[1])]; } catch { /* ignore */ }
  }
  if (LEGACY_DEFAULT_PROMPTS.includes(cfg.prompt)) cfg.prompt = DEFAULT_PROMPT;     // an untouched old default -> the new one
  for (const gone of ['blur_experiment', 'blur_state', 'blur_tint', 'capture_method', 'capture_captureblt', 'options_pos', 'options_size']) delete cfg[gone];
  cfg.config_version = VERSION;
  return cfg;
}

function kindOk(value, dflt) {
  if (dflt === null) return true;
  if (typeof dflt === 'boolean') return typeof value === 'boolean';
  if (typeof dflt === 'number') return typeof value === 'number';
  if (typeof dflt === 'string') return typeof value === 'string';
  if (Array.isArray(dflt)) return Array.isArray(value);
  return isObj(value);
}

// the settings of 1.x -> [settings, notes]. Leaves out what is gone, turns the old blur choice into the new one, puts a value of
// the wrong kind (a hand-edited file) back to its default, and lists in plain words what it did.
export function migrate(oldIn) {
  const notes = [];
  const old = isObj(oldIn) ? { ...oldIn } : {};
  const keep = k => own(DEFAULTS, k) || OBSOLETE.has(k) || k === 'child_windows' || k === 'win1_off';
  const work = Object.fromEntries(Object.entries(old).filter(([k]) => keep(k)));
  if (!own(old, 'blur') && truthy(old.blur_experiment)) {            // 1.x: a switch and 3 = light / 4 = acrylic
    work.blur = old.blur_state === 4 ? 2 : 1;
    notes.push(fmt(tr('배경 흐림 설정을 새 방식(%s)으로 옮겼습니다.'), work.blur === 2 ? tr('강하게') : tr('약하게')));
  }
  const wrong = [];
  for (const k of Object.keys(work)) if (own(DEFAULTS, k) && !kindOk(work[k], DEFAULTS[k])) { wrong.push(k); delete work[k]; }
  if (wrong.length) notes.push(tr('형식이 맞지 않는 설정은 기본값으로 두었습니다:') + ' ' + wrong.sort().join(', '));
  const cfg = normalize(carryLineHeight(work));
  if (!(cfg.send_prompt || '').trim()) cfg.send_prompt = DEFAULT_SEND_PROMPT;                 // an empty send prompt meant "the default"
  if ((cfg.prompt || '').trim() === DEFAULT_PROMPT.trim()) cfg.prompt = DEFAULT_PROMPT;       // 1.x saved it without the last line break
  const unknown = Object.keys(old).filter(k => !keep(k)).sort();
  if (unknown.length) notes.push(fmt(tr('2.0에서 쓰지 않는 설정 %d개는 옮기지 않았습니다 (원래 파일은 config.1x.json에 있습니다): %s'), unknown.length, unknown.join(', ')));
  const dropped = Object.keys(old).filter(k => OBSOLETE.has(k) && !['opacity', 'voice_translate', 'glossary_inline', 'manual_pos'].includes(k)).sort();
  log.info(`1.x 설정을 가져왔습니다 (${Object.keys(old).length}개 항목). 옮기지 않음: ${[...dropped, ...unknown].join(', ') || '-'}`);
  notes.unshift(tr('1.x 설정을 가져왔습니다. 원래 파일은 config.1x.json 으로 보관했습니다.'));
  return [cfg, notes];
}

// the settings in config.json (through the files API). A file from 1.x is brought over first; the old file is kept as config.1x.json.
export class ConfigStore {
  // readOnly: a window that only reads the settings (never moves a 1.x file over, never writes): only one window owns config.json
  constructor(files, { readOnly = false } = {}) { this.files = files; this.readOnly = readOnly; this.cfg = normalize(null); this.notes = []; }

  async load() {
    let saved = null;
    try { saved = JSON.parse(await this.files.read(PATH)); } catch { /* missing or broken: defaults */ }
    if (isObj(saved) && saved.config_version === 2) {              // 3.0.x: only the new setting is added (nothing is moved or backed up)
      this.cfg = normalize(carryLineHeight(saved));
      if (!this.readOnly) await this.save();
      return this.cfg;
    }
    if (isObj(saved) && saved.config_version !== VERSION) {
      [this.cfg, this.notes] = migrate(saved);
      if (!this.readOnly) { await this.backup(); await this.save(); }
      return this.cfg;
    }
    this.cfg = normalize(saved);
    return this.cfg;
  }

  // config.json -> config.1x.json (an existing backup is kept: the first one is the 1.x original)
  async backup() {
    try {
      if (await this.files.kind('config.1x.json')) return;
      const text = await this.files.read(PATH);
      if (text != null) await this.files.write('config.1x.json', text);
    } catch (e) { log.error('config.1x.json 을 만들지 못했습니다 ' + (e?.message || e)); }
  }

  async save(cfg = this.cfg) {
    this.cfg = cfg;
    if (this.readOnly) return false;
    try { await this.files.write(PATH, JSON.stringify(cfg, null, 2)); return true; }
    catch (e) { log.warn('설정을 저장하지 못했습니다: ' + (e?.message || e)); return false; }
  }
}
