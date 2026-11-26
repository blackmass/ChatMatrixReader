// config.js against the 2.0 Python (tests/golden/config*.json), the file round trip, and the event bus
import fs from 'node:fs';
import path from 'node:path';
import { HERE, check, eq, canon } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import { log } from '../app/core/log.js';
import { DEFAULTS, normalize, migrate, ConfigStore, VERSION } from '../app/core/config.js';
import { Events } from '../app/core/events.js';

log.quiet = true;
const no3 = c => { for (const w of (c && c.child_windows) || []) { delete w.clear_on_open; delete w.dock_to; delete w.tab_opacity; delete w.owner; delete w.owner_win; delete w.kind; delete w.page; } if (c) { delete c.whole_groups; delete c.hide_tools; delete c.hide_tabs; delete c.hide_frame; delete c.tab_alert; delete c.lock_window; delete c.tab_opacity; delete c.max_groups; delete c.send_place; delete c.main_name; } return c; };      // (3.x only: an extra window can start empty)
const G = JSON.parse(fs.readFileSync(path.join(HERE, 'golden', 'config.json'), 'utf8'));
const D = JSON.parse(fs.readFileSync(path.join(HERE, 'golden', 'config_defaults.json'), 'utf8'));
// (the background of a window is at most 99 % now, winconf.js MAX_BG_OPACITY; the 2.0 answers say 100 %: they are compared as 99 %)
const cap = c => { const o = structuredClone(c); const f = w => { if (w && typeof w === 'object' && typeof w.bg_opacity === 'number') w.bg_opacity = Math.min(0.99, w.bg_opacity); }; f(o); for (const w of (o && o.child_windows) || []) f(w); return o; };
const same = (a, b, msg) => { const x = canon(cap(a)), y = canon(cap(b)); if (x === y) check(true, msg); else { check(false, msg); console.log('   got     ', x.slice(0, 500)); console.log('   expected', y.slice(0, 500)); } };

// the defaults: everything of 2.0, plus the add-on slot
const mine = { ...DEFAULTS }; no3(mine); const added = Object.keys(mine).filter(k => !(k in D));
eq(added.slice().sort(), ['auto_copy', 'bar_style', 'bold_fix', 'bookmarks', 'browser_windows', 'by_method', 'capture_mode', 'center_scale', 'chat_links', 'debug_log', 'font_weight', 'letter_spacing', 'line_height', 'ocr_ai_key', 'ocr_ai_model', 'ocr_ai_parallel', 'ocr_ai_url', 'ocr_cap_hotkey', 'ocr_cap_prompt', 'ocr_enabled', 'ocr_prompt', 'ocr_read', 'ocr_region', 'ocr_when', 'ocr_win_lang', 'ocr_x2', 'outline', 'outline_color', 'plain_text', 'plugins', 'read_matrix', 'snip_hide', 'through_tips', 'tools', 'tuning', 'voice_capture', 'voice_min_db', 'voice_prompt', 'web_render', 'wheel_through', 'widgets'], 'only `auto_copy`, `font_weight`, `plugins`, `tuning`, `voice_capture`, `voice_min_db`, `voice_prompt`, `through_tips`, `wheel_through`, `center_scale`, `bar_fullscreen`, `browser_windows`, `by_method`, `bookmarks`, `web_render`, `read_matrix`, `chat_links`, `debug_log` and `widgets` are new in the defaults');
delete mine.plugins; delete mine.line_height; delete mine.snip_hide; delete mine.tools; delete mine.tuning; delete mine.wheel_through; delete mine.center_scale; delete mine.browser_windows; delete mine.bookmarks; delete mine.web_render; delete mine.auto_copy; delete mine.read_matrix; delete mine.chat_links; delete mine.by_method; delete mine.bar_style; delete mine.capture_mode; delete mine.debug_log; delete mine.font_weight; delete mine.voice_prompt; delete mine.voice_capture; delete mine.voice_min_db; delete mine.widgets; for (const k of ['ocr_ai_key', 'ocr_ai_model', 'ocr_ai_parallel', 'ocr_ai_url', 'ocr_cap_hotkey', 'ocr_cap_prompt', 'ocr_enabled', 'ocr_prompt', 'ocr_read', 'ocr_region', 'ocr_x2', 'ocr_when', 'ocr_win_lang']) delete mine[k]; delete mine.through_tips; for (const k of ['bold_fix', 'letter_spacing', 'outline', 'outline_color', 'plain_text']) delete mine[k];
same(mine, D, 'defaults equal 2.0');

const noAcrylic = c => { for (const w of c.child_windows || []) if (w.blur === 3) w.blur = 2; if (c.blur === 3) c.blur = 2; return c; };      // 3.0 reads blur 3 as 2
for (const [saved, want] of G.normalize) { noAcrylic(want); const got = no3(normalize(saved)); got.config_version = 2; delete got.plugins; delete got.line_height; delete got.snip_hide; delete got.tools; delete got.tuning; delete got.wheel_through; delete got.center_scale; delete got.browser_windows; delete got.bookmarks; delete got.web_render; delete got.auto_copy; delete got.read_matrix; delete got.chat_links; delete got.by_method; delete got.bar_style; delete got.capture_mode; delete got.debug_log; delete got.font_weight; delete got.voice_prompt; delete got.voice_capture; delete got.voice_min_db; delete got.widgets; for (const k of ['ocr_ai_key', 'ocr_ai_model', 'ocr_ai_parallel', 'ocr_ai_url', 'ocr_cap_hotkey', 'ocr_cap_prompt', 'ocr_enabled', 'ocr_prompt', 'ocr_read', 'ocr_region', 'ocr_x2', 'ocr_when', 'ocr_win_lang']) delete got[k]; delete got.through_tips; for (const k of ['bold_fix', 'letter_spacing', 'outline', 'outline_color', 'plain_text']) delete got[k]; same(got, want, 'normalize ' + JSON.stringify(saved)?.slice(0, 70)); }
for (const [old, wantCfg, wantNotes] of G.migrate) {
  const [cfg, notes] = migrate(old); no3(cfg); cfg.config_version = 2; delete cfg.plugins; delete cfg.line_height; delete cfg.snip_hide; delete cfg.tools; delete cfg.tuning; delete cfg.wheel_through; delete cfg.center_scale; delete cfg.browser_windows; delete cfg.bookmarks; delete cfg.web_render; delete cfg.auto_copy; delete cfg.read_matrix; delete cfg.chat_links; delete cfg.by_method; delete cfg.bar_style; delete cfg.capture_mode; delete cfg.debug_log; delete cfg.font_weight; delete cfg.voice_prompt; delete cfg.voice_capture; delete cfg.voice_min_db; delete cfg.widgets; for (const k of ['ocr_ai_key', 'ocr_ai_model', 'ocr_ai_parallel', 'ocr_ai_url', 'ocr_cap_hotkey', 'ocr_cap_prompt', 'ocr_enabled', 'ocr_prompt', 'ocr_read', 'ocr_region', 'ocr_x2', 'ocr_when', 'ocr_win_lang']) delete cfg[k]; delete cfg.through_tips; for (const k of ['bold_fix', 'letter_spacing', 'outline', 'outline_color', 'plain_text']) delete cfg[k]; noAcrylic(wantCfg);
  same(cfg, wantCfg, 'migrate settings ' + JSON.stringify(old)?.slice(0, 60));
  same(notes, wantNotes, 'migrate notes ' + JSON.stringify(old)?.slice(0, 60));
}

// 3.0: the Windows 11 acrylic level is gone
eq(normalize({ blur: 3 }).blur, 2, 'blur 3 is read as 2');
eq(normalize({ child_windows: [{ id: 3, channels: ['S'], blur: 3 }] }).child_windows.find(w => w.id === 3).blur, 2, 'a child window with blur 3 is read as 2');
eq(normalize({ plugins: 5 }).plugins, {}, 'a broken plugins entry becomes {}');
eq(normalize({ plugins: { x: { enabled: true, granted: [] } } }).plugins, { x: { enabled: true, granted: [] } }, 'plugins are kept');

// the file: missing -> defaults; saved -> read back; a 1.x file is moved over once and backed up
{
  const files = memoryFiles(); const s = new ConfigStore(files);
  eq((await s.load()).font_size, 11, 'no file: defaults');
  s.cfg.font_size = 17; check(await s.save(), 'saved');
  const s2 = new ConfigStore(files);
  eq((await s2.load()).font_size, 17, 'read back');
  eq(JSON.parse(await files.read('config.json')).config_version, VERSION, 'file carries the version');
  await files.write('config.json', '{ broken');
  eq((await new ConfigStore(files).load()).font_size, 11, 'broken file: defaults (not a crash)');
}
{
  const old = JSON.stringify({ font_size: 15, blur_experiment: true, zzz: 1 });
  const files = memoryFiles({ 'config.json': old }); const s = new ConfigStore(files);
  const cfg = await s.load();
  eq([cfg.font_size, cfg.blur, s.notes.length > 0], [15, 1, true], '1.x file is migrated');
  eq(await files.read('config.1x.json'), old, 'the original is kept as config.1x.json');
  eq(JSON.parse(await files.read('config.json')).config_version, VERSION, 'config.json is rewritten in the new format');
  const s2 = new ConfigStore(files); await s2.load();
  eq([s2.notes.length, await files.read('config.1x.json')], [0, old], 'second start: no migration, backup untouched');
}

// a read-only store never writes (the other windows of the program only read)
{
  const files = memoryFiles({ 'config.json': JSON.stringify({ font_size: 15 }) }); const s = new ConfigStore(files, { readOnly: true });
  eq((await s.load()).font_size, 15, 'read-only: reads a 1.x file');
  eq([await files.read('config.1x.json'), JSON.parse(await files.read('config.json')).config_version, await s.save()], [null, undefined, false], 'read-only: no backup, no write');
}

// ---- events
{
  const ev = new Events(), seen = [];
  const off = ev.on('line:added', d => seen.push(['a', d]));
  ev.on('line:added', () => { throw new Error('bad listener'); });
  ev.on('line:added', d => seen.push(['c', d]));
  ev.once('app:ready', d => seen.push(['once', d]));
  ev.emit('line:added', 1); off(); ev.emit('line:added', 2); ev.emit('app:ready', 'go'); ev.emit('app:ready', 'again'); ev.emit('nobody', 0);
  eq(seen, [['a', 1], ['c', 1], ['c', 2], ['once', 'go']], 'events: order, off, once, a throwing listener does not stop the others');
}
eq(normalize({ tuning: 5 }).tuning, {}, 'a broken tuning entry becomes {}');

// 3.0.x -> 3.1: line_spacing used to be the row height; the new line_height takes over that value once, so nothing looks different
{
  eq(DEFAULTS.line_height, 0, 'line_height: 0 by default');
  const old = { config_version: 2, font_size: 15, line_spacing: 6, child_windows: [{ id: 3, channels: ['S'], line_spacing: 4 }, { id: 4, channels: ['Y'] }] };
  const files = memoryFiles({ 'config.json': JSON.stringify(old) }); const st = new ConfigStore(files);
  const c = await st.load();
  eq([c.line_height, c.line_spacing, c.child_windows.find(w => w.id === 3).line_height, c.child_windows.find(w => w.id === 3).line_spacing, 'line_height' in c.child_windows.find(w => w.id === 4)],
    [6, 6, 4, 4, false], '2 -> 3: the old line_spacing is copied into line_height (main and an extra window that had its own); a window that followed keeps following');
  eq([JSON.parse(await files.read('config.json')).config_version, await files.read('config.1x.json'), st.notes.length], [VERSION, null, 0], '2 -> 3: the file is rewritten in the new format, no 1.x backup, no notes');
  const again = new ConfigStore(files); const c2 = await again.load();
  eq([c2.line_height, c2.line_spacing], [6, 6], 'second start: the same');
  st.cfg.line_height = 0; await st.save();                                  // the user sets the row height to 0 on purpose: it stays
  eq((await new ConfigStore(files).load()).line_height, 0, 'a value the user set is not copied over again');
  const ro = new ConfigStore(memoryFiles({ 'config.json': JSON.stringify(old) }), { readOnly: true });
  eq([(await ro.load()).line_height, await ro.files.read('config.1x.json')], [6, null], 'read-only: the same values, nothing written');
  eq(migrate({ line_spacing: 5, font_size: 12 })[0].line_height, 5, 'a 1.x file: line_height takes the old line_spacing too');
  eq(normalize({}).line_height, 0, 'no file: 0');
}

{
  const n = o => normalize(o).read_matrix;
  eq([n({}), n({ read_matrix: false }), n({ read_matrix: 0 }), n({ read_matrix: true })], [true, false, true, true], 'read_matrix: on unless it is exactly false');
}

eq([normalize({}).chat_links, normalize({ chat_links: false }).chat_links, normalize({ chat_links: 0 }).chat_links], [true, false, true], 'chat_links: on unless it is exactly false');

eq([normalize({ bg_opacity: 1 }).bg_opacity, normalize({ bg_opacity: 0.17 }).bg_opacity, normalize({}).bg_opacity], [0.99, 0.17, 0.99], 'bg_opacity (window 1): at most 99 %, a lower value stays, the default is 99 %');
// the way the screen is read: a choice that is kept; anything else is the screen
eq([normalize({ capture_mode: 'window' }).capture_mode, normalize({ capture_mode: 'x' }).capture_mode, normalize({}).capture_mode], ['window', 'screen', 'screen'], 'capture_mode: "window" is kept, anything else (and nothing) is "screen"');

// 3.3: OCR assist settings: off by default; a wrong value goes back to its default
{
  const n = o => normalize(o);
  eq([n({}).ocr_enabled, n({ ocr_enabled: 1 }).ocr_enabled, n({ ocr_enabled: true }).ocr_enabled], [false, false, true], 'ocr_enabled: off unless exactly true');
  eq([n({}).ocr_when, n({ ocr_when: 'resident' }).ocr_when, n({ ocr_when: 'x' }).ocr_when], ['ondemand', 'resident', 'ondemand'], 'ocr_when: a wrong value is "ondemand"');
  eq([n({}).ocr_ai_parallel, n({ ocr_ai_parallel: 3 }).ocr_ai_parallel, n({ ocr_ai_parallel: 9 }).ocr_ai_parallel, n({ ocr_ai_parallel: 0 }).ocr_ai_parallel, n({ ocr_ai_parallel: 'x' }).ocr_ai_parallel], [1, 3, 4, 1, 1], 'ocr_ai_parallel: 1 to 4, anything else goes to the nearest / 1');
  eq([n({}).ocr_win_lang, n({ ocr_win_lang: '  ko ' }).ocr_win_lang, n({ ocr_win_lang: 5 }).ocr_win_lang, n({ ocr_win_lang: 'x'.repeat(40) }).ocr_win_lang.length], ['', 'ko', '', 20], 'ocr_win_lang: a language tag, trimmed; anything else is empty');
  eq([n({ ocr_read: 'ai' }).ocr_read, n({ ocr_read: 'x' }).ocr_read, n({}).ocr_read, 'ocr_split' in n({ ocr_split: 'ocr' })], ['ai', DEFAULTS.ocr_read, DEFAULTS.ocr_read, false], 'ocr_read: a known value is kept, another goes back; the taken-out ocr_split is dropped from an old file');
  eq([n({}).ocr_region, n({ ocr_region: { x: 1, y: 2, w: 30, h: 40, gw: 100, gh: 100 } }).ocr_region, n({ ocr_region: { x: 'a' } }).ocr_region], [null, { x: 1, y: 2, w: 30, h: 40, gw: 100, gh: 100 }, null], 'ocr_region: a good one is kept, a wrong one is null');
  check(n({ ocr_prompt: '   ' }).ocr_prompt.includes('picture of a game chat window'), 'ocr_prompt: an empty prompt means the default');
  check(n({ ocr_cap_prompt: '   ' }).ocr_cap_prompt.includes('Read all the text in the picture') && n({}).ocr_cap_prompt.includes('Do not translate'), 'ocr_cap_prompt: an empty prompt means the default (the model only reads; the translation is the translation tab\'s)');
}
