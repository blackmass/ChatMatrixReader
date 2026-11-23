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
const same = (a, b, msg) => { const x = canon(a), y = canon(b); if (x === y) check(true, msg); else { check(false, msg); console.log('   got     ', x.slice(0, 500)); console.log('   expected', y.slice(0, 500)); } };

// the defaults: everything of 2.0, plus the add-on slot
const mine = { ...DEFAULTS }; no3(mine); const added = Object.keys(mine).filter(k => !(k in D));
eq(added.slice().sort(), ['auto_copy', 'bold_fix', 'bookmarks', 'browser_windows', 'center_scale', 'chat_links', 'font_weight', 'letter_spacing', 'line_height', 'outline', 'outline_color', 'plain_text', 'plugins', 'read_matrix', 'through_tips', 'tuning', 'voice_capture', 'voice_min_db', 'voice_prompt', 'web_render', 'wheel_through', 'widgets'], 'only `auto_copy`, `font_weight`, `plugins`, `tuning`, `voice_capture`, `voice_min_db`, `voice_prompt`, `through_tips`, `wheel_through`, `center_scale`, `browser_windows`, `bookmarks`, `web_render`, `read_matrix`, `chat_links` and `widgets` are new in the defaults');
delete mine.plugins; delete mine.line_height; delete mine.tuning; delete mine.wheel_through; delete mine.center_scale; delete mine.browser_windows; delete mine.bookmarks; delete mine.web_render; delete mine.auto_copy; delete mine.read_matrix; delete mine.chat_links; delete mine.font_weight; delete mine.voice_prompt; delete mine.voice_capture; delete mine.voice_min_db; delete mine.widgets; delete mine.through_tips; for (const k of ['bold_fix', 'letter_spacing', 'outline', 'outline_color', 'plain_text']) delete mine[k];
same(mine, D, 'defaults equal 2.0');

const noAcrylic = c => { for (const w of c.child_windows || []) if (w.blur === 3) w.blur = 2; if (c.blur === 3) c.blur = 2; return c; };      // 3.0 reads blur 3 as 2
for (const [saved, want] of G.normalize) { noAcrylic(want); const got = no3(normalize(saved)); got.config_version = 2; delete got.plugins; delete got.line_height; delete got.tuning; delete got.wheel_through; delete got.center_scale; delete got.browser_windows; delete got.bookmarks; delete got.web_render; delete got.auto_copy; delete got.read_matrix; delete got.chat_links; delete got.font_weight; delete got.voice_prompt; delete got.voice_capture; delete got.voice_min_db; delete got.widgets; delete got.through_tips; for (const k of ['bold_fix', 'letter_spacing', 'outline', 'outline_color', 'plain_text']) delete got[k]; same(got, want, 'normalize ' + JSON.stringify(saved)?.slice(0, 70)); }
for (const [old, wantCfg, wantNotes] of G.migrate) {
  const [cfg, notes] = migrate(old); no3(cfg); cfg.config_version = 2; delete cfg.plugins; delete cfg.line_height; delete cfg.tuning; delete cfg.wheel_through; delete cfg.center_scale; delete cfg.browser_windows; delete cfg.bookmarks; delete cfg.web_render; delete cfg.auto_copy; delete cfg.read_matrix; delete cfg.chat_links; delete cfg.font_weight; delete cfg.voice_prompt; delete cfg.voice_capture; delete cfg.voice_min_db; delete cfg.widgets; delete cfg.through_tips; for (const k of ['bold_fix', 'letter_spacing', 'outline', 'outline_color', 'plain_text']) delete cfg[k]; noAcrylic(wantCfg);
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
