// outgoing.js / hotkeys.js / upkeep.js: the 2.0 answers (tests/golden/send.json) and the 2.0 scenario tests
import fs from 'node:fs';
import path from 'node:path';
import { HERE, check, eq, canon } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import { log } from '../app/core/log.js';
import * as o from '../app/core/outgoing.js';
import * as hk from '../app/core/hotkeys.js';
import * as up from '../app/core/upkeep.js';
import { DEFAULTS } from '../app/core/config.js';
import { Glossary } from '../app/core/glossary.js';
import { TranslateError } from '../app/core/translate_rules.js';

log.quiet = true;
const G = JSON.parse(fs.readFileSync(path.join(HERE, 'golden', 'send.json'), 'utf8'));
const same = (a, b, msg) => { const x = canon(a), y = canon(b); if (x === y) check(true, msg); else { check(false, msg); console.log('   got     ', x.slice(0, 400)); console.log('   expected', y.slice(0, 400)); } };

for (const [raw, want] of G.clean) eq(o.cleanTranslation(raw), want, 'clean ' + JSON.stringify(raw));
for (const [raw, want] of G.pipes) eq(o.escapePipes(raw), want, 'pipes ' + JSON.stringify(raw));
for (const [text, want] of G.hotkeys) {
  let got;
  try { const [mods, vk] = hk.parse(text); got = { mods: [...mods].sort(), vk, norm: hk.normalize(text) }; } catch { got = 'error'; }
  same(got, want, 'hotkey ' + JSON.stringify(text));
}
for (const [raw, fake, want] of G.prepare.filter(c => !c[0].trim().startsWith('/'))) {     // (2.0 also understood chat commands; 3.0 has a separate prefix field)
  const fn = async () => { if (fake === 'TRANSLATE_ERROR') throw new TranslateError('HTTP 500 boom'); return fake; };
  let got;
  try { const r = await o.prepare({ send_lang: 'English' }, raw, fn); got = { text: r.text, translated: r.translated, note: r.note }; }
  catch (e) { if (!(e instanceof o.OutgoingError)) throw e; got = { error: e.message }; }
  same(got, want, 'prepare ' + JSON.stringify(raw).slice(0, 30) + ' <- ' + JSON.stringify(fake).slice(0, 20));
}
for (const [sub, want] of G.upkeep) {
  const cfg = { ...DEFAULTS, ...sub };
  same({ ai_mode: up.aiMode(cfg), conn_key: up.connKey(cfg), mode_key: Object.fromEntries(['openai', 'google', 'custom', 'none'].map(m => [m, up.modeKey(cfg, m)])), start: new up.ConnWatch().startModes(cfg) }, want, 'upkeep keys ' + sub.translator);
}

// the prepare() path with the prefix field: what the translator is asked, and that nothing is asked for commands / numbers
{
  const asked = [], fn = async (c, t) => { asked.push([c.send_lang, t]); return 'EN:' + t; };
  const r1 = await o.prepare({ send_lang: 'English' }, '탱커 구함', fn, '/w Bob Smith');
  eq([r1.text, r1.translated], ['/w Bob Smith EN:탱커 구함', true], 'the prefix is joined by one space (a two-word name is no problem)');
  eq(asked, [['English', '탱커 구함']], 'only the sentence was translated');
  eq((await o.prepare({}, '탱커 구함', fn, '  /p  ')).text, '/p EN:탱커 구함', 'the prefix is trimmed');
  eq((await o.prepare({}, '탱커 구함', fn, '')).text, 'EN:탱커 구함', 'no prefix: just the translation');
  const n = asked.length, r = await o.prepare({}, '/dance', fn); eq([r.text, r.translated, !!r.note, asked.length - n], ['/dance', false, true, 0], 'a sentence starting with / is a command: copied, no request');
  eq((await o.prepare({}, '/dance', fn, '/p')).text, '/p /dance', 'a command with a prefix is still copied as it is');
  eq((await o.prepare({}, '12345', fn, '/g')).text, '/g 12345', 'numbers: nothing to translate');
  eq((await o.prepare({}, 'a|b 안녕', async () => 'a|b hi', '/p|x')).text, '/p|x a||b hi', 'pipes are doubled in the translation only');
  try { await o.prepare({}, '길게', async () => 'x'.repeat(300)); check(false, 'too long'); } catch (e) { check(e.message.includes('300/255'), 'too long says 300/255'); }
  try { await o.prepare({}, '길게', async () => 'x'.repeat(250), '/w Someone Longname'); check(false, 'prefix counts'); } catch (e) { check(e.message.includes('/255'), 'the prefix counts for the 255 bytes'); }
  try { await o.prepare({}, '  ', fn, '/p'); check(false, 'empty'); } catch (e) { check(e instanceof o.OutgoingError, 'an empty sentence is refused'); }
}

// ---- upkeep (the scenarios of test_upkeep.py)
const base = { ...DEFAULTS };
const oa = { ...base, translator: 'openai', api_url: 'http://x/v1', api_model: 'm' };
const mkG = (text = 'a=b\n') => { const files = memoryFiles({ 'g.txt': text }); return { files, g: new Glossary(files, { now: () => 0, recheckMs: 0 }) }; };
{
  const { g } = mkG();
  eq(up.aiMode({ ...base, translator: 'google' }), null, 'google is no AI');
  eq(up.aiMode(oa), 'openai', 'openai is AI');
  eq(up.aiMode({ ...base, translator: 'google', channel_route: { guild: 'openai' } }), 'openai', 'a channel using openai');
  eq(await up.warmKey(g, { ...base, translator: 'google' }), null, 'nothing to warm for google');
  check(await up.warmKey(g, oa) !== await up.warmKey(g, { ...oa, api_model: 'n' }), 'warm key: model');
  check(await up.warmKey(g, oa) !== await up.warmKey(g, { ...oa, extra_prompt: 'hi' }), 'warm key: extra prompt');
  eq(Object.keys(up.connKey(oa)), ['openai'], 'conn key openai');
  eq(Object.keys(up.connKey({ ...oa, translator: 'google', channel_route: { guild: 'openai' } })).sort(), ['google', 'openai'], 'conn key google + openai');

  let c = new up.ConnWatch(oa);
  eq(c.check(oa), [], 'ConnWatch unchanged');
  const nw = { ...oa, api_model: 'other' };
  eq([c.check(nw), c.check(nw), c.check(nw)], [[], ['openai'], []], 'ConnWatch: waits one round, acts once');
  eq(new up.ConnWatch().startModes(oa), ['openai'], 'start modes');
  eq(new up.ConnWatch().startModes({ ...oa, translate_test_start: false }), [], 'start test off');
  eq(new up.ConnWatch().startModes(base), ['google'], 'start google');
  eq(new up.ConnWatch().startModes({ ...base, translator: 'none' }), [], 'start none');
  c = new up.ConnWatch(oa); c.check({ ...oa, api_model: 'z' });
  eq([c.check(oa), c.pending], [[], null], 'changed back in time: nothing');

  const w = new up.WarmWatch(g, oa);
  eq(await w.check(oa), false, 'warm: unchanged');
  const p = { ...oa, extra_prompt: 'new' };
  eq([await w.check(p), await w.check(p), await w.check(p)], [false, true, false], 'warm: waits one round, fires once');
  const q = { ...oa, extra_prompt: 'newer' };
  eq([await w.check(q, true), await w.check(q)], [false, false], 'warm: carried by the connection check');
  eq(await new up.WarmWatch(g, { ...base, translator: 'google' }).check({ ...base, translator: 'google' }), false, 'warm: google never');
}
{
  const { files, g } = mkG();
  const cfg = { ...oa, glossary_file: 'g.txt' };
  const w = new up.GlossWatch(g, cfg);
  eq(await w.check(cfg), null, 'glossary unchanged');
  await files.write('g.txt', 'a=b\nc=d\n');
  eq([await w.check(cfg), await w.check(cfg), await w.check(cfg)], [null, 2, null], 'glossary saved: waits one round, says the entry count once');
  await files.write('g.txt', 'a=b\n');
  eq(await w.check({ ...cfg, translator: 'none' }), null, 'no method on: nothing to say');
}
{
  const h = new up.LostHint();
  eq(h.check(base, null, false, 0), ['show', true], 'lost: never found -> the first-start guide at once, even with no game');
  eq(h.check(base, null, false, 1), null, 'lost: only once');
  eq(h.check(base, {}, false, 2), null, 'lost: the game starts and it is still not found: no second message');
  eq(h.check(base, {}, true, 3), ['hide', false], 'lost: hidden when read');
  const h2 = new up.LostHint(), seen = { ...base, last_pos: [1, 2, 3, 4] };
  eq([h2.check(seen, {}, false, 10), h2.check(seen, {}, false, 14), h2.check(seen, {}, false, 15.5)], [null, null, ['show', false]], 'lost: after 5 seconds when a position is known');
  eq(h2.check(seen, null, false, 20), ['hide', false], 'lost: the game was closed: the hint goes');
  const h3 = new up.LostHint();
  eq([h3.check(seen, null, false, 0), h3.check(seen, null, false, 30), h3.check(seen, {}, false, 31)], [null, null, null], 'lost: a position is known and there is no game: nothing to say, and the wait starts when the game appears');
}
