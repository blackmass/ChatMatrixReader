// translate.js / glossary.js / usage.js against the answers of the 2.0 Python (tests/golden/translate.json): same requests, same results.
import fs from 'node:fs';
import path from 'node:path';
import { HERE, check, eq, canon } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import { log } from '../app/core/log.js';
import { Glossary } from '../app/core/glossary.js';
import { Usage } from '../app/core/usage.js';
import { Translator, renderPrompt, sendCfg } from '../app/core/translate.js';
import { TranslateError, TransientError } from '../app/core/translate_rules.js';

log.quiet = true;
const G = JSON.parse(fs.readFileSync(path.join(HERE, 'golden', 'translate.json'), 'utf8'));
const GLOSSARY = G.glossary.find(c => c[0] === 'parse_rich')[1][0];
const EXTRA = '## Extra\nfoo = 푸\n# hidden\nbar = baz\n'.replace('baz', '바');
const mkFiles = () => memoryFiles({ 'Glossary.txt': GLOSSARY, 'Extra.txt': EXTRA });
const mkGlossary = files => new Glossary(files, { now: () => 0 });
const same = (a, b, msg) => { const x = canon(a), y = canon(b); if (x === y) check(true, msg); else { check(false, msg); console.log('   got     ', x.slice(0, 600)); console.log('   expected', y.slice(0, 600)); } };

// ---- glossary
{
  const g = mkGlossary(mkFiles());
  for (const [fn, args, want] of G.glossary) {
    let got;
    if (fn === 'apply_google') got = await g.applyGoogle(args[0], null, args[1]);
    else if (fn === 'apply_google_masked') got = await g.applyGoogleMasked(args[0], null, args[1], args[2]);
    else if (fn === 'matched_list') got = await g.matchedList(args[0]);
    else if (fn === 'matched_list2') got = await g.matchedList(args[0], null, 2);
    else if (fn === 'apply_mixed') got = await g.applyMixed(args[0]);
    else if (fn === 'apply_mixed_inline1') got = await g.applyMixed(args[0], null, 20, 1);
    else if (fn === 'entries') got = await g.entries();
    else if (fn === 'parse_rich') got = (await import('../app/core/glossary.js')).parseRich(args[0]);
    else if (fn === 'content_lines') got = (await import('../app/core/glossary.js')).contentLines(args[0], true);
    else if (fn === 'mode') got = (await import('../app/core/glossary.js')).mode(args[0]);
    else throw new Error('unknown ' + fn);
    same(got, want, `glossary ${fn} ${JSON.stringify(args).slice(0, 50)}`);
  }
  // the file is re-read when it changes, but not more often than every recheckMs
  const files = mkFiles(); let t = 0;
  const g2 = new Glossary(files, { now: () => t, recheckMs: 1000 });
  eq((await g2.applyGoogle('LFM', null)), 'LFM(구인)', 'glossary first read');
  await files.write('Glossary.txt', 'LFM = 파티찾음\n');
  eq((await g2.applyGoogle('LFM', null)), 'LFM(구인)', 'glossary not re-read within recheckMs');
  t = 1500;
  eq((await g2.applyGoogle('LFM', null)), 'LFM(파티찾음)', 'glossary re-read after the file changed');
  const k1 = await g2.cacheKey({ glossary_mode: 'list' });
  await files.write('Glossary.txt', 'LFM = 다른\n');
  const k2 = await g2.cacheKey({ glossary_mode: 'list' });
  check(k1 !== k2, 'cache key changes with the glossary file');
  const k3 = await g2.cacheKey({ prompt: '{{Extra.txt}}' }), k4 = (await files.write('Extra.txt', 'a = b'), await g2.cacheKey({ prompt: '{{Extra.txt}}' }));
  check(k3 !== k4, 'cache key changes with a file named in the prompt');
  // a missing glossary is just empty; a sample is copied on first start, never over an existing file
  const f3 = memoryFiles({ 'Glossary.sample.txt': 'A = b\n' });
  const g3 = mkGlossary(f3);
  eq(await g3.applyGoogle('A', null), 'A', 'missing glossary changes nothing');
  await g3.ensureDefault(); eq(await f3.read('Glossary.txt'), 'A = b\n', 'ensureDefault copies the sample');
  await f3.write('Glossary.txt', 'mine'); await g3.ensureDefault(); eq(await f3.read('Glossary.txt'), 'mine', 'ensureDefault never overwrites');
  eq(await mkGlossary(memoryFiles({ 'Glossary.txt': '﻿X = y\n' })).applyGoogle('X', null), 'X(y)', 'BOM is ignored');
}

// ---- prompts
for (const [p, lang, mode, extra, want] of G.prompt) same(await renderPrompt(mkGlossary(mkFiles()), p, lang, mode, extra), want, `render_prompt ${JSON.stringify(p)?.slice(0, 30)} ${mode} ${JSON.stringify(extra)}`);
for (const [cfg, want] of G.send_cfg) same(sendCfg(cfg), want, 'send_cfg ' + JSON.stringify(cfg).slice(0, 40));

// ---- scripted scenarios
const kinds = { T: TranslateError, X: TransientError };
async function scenario(group, sc) {
  const files = mkFiles(), clock = { now: 0, sleeps: [] }, queue = [], calls = [], notes = [];
  const next = () => { if (!queue.length) throw new Error('no canned answer left'); const r = queue.shift(); if (r.err) throw new kinds[r.err[0]](r.err[1]); return r.data; };
  const http = {
    json: async (url, payload, headers, timeout) => { calls.push(['json', url, payload, headers, timeout]); return next(); },
    form: async (url, body, headers, timeout) => { calls.push(['form', url, body, headers, timeout]); return next(); },
  };
  const usage = new Usage(files, { month: () => '2026-11' });
  const tzr = new Translator({ http, glossary: mkGlossary(files), usage, now: () => clock.now, sleep: async s => { clock.sleeps.push(Math.round(s * 1e6) / 1e6); clock.now += s; }, onUsage: n => notes.push(n) });
  for (let i = 0; i < sc.steps.length; i++) {
    const st = sc.steps[i], want = sc.expect[i];
    clock.now += st.advance || 0; calls.length = 0; clock.sleeps.length = 0; queue.splice(0, queue.length, ...(st.responses || []));
    let r;
    try { r = { ok: await (sc.outgoing ? tzr.translateOutgoing(sc.cfg, st.text) : tzr.translate(sc.cfg, st.text)) }; }
    catch (e) {
      const name = e.constructor.name === 'RateLimited' ? 'RateLimited' : e.constructor.name === 'TransientError' ? 'TransientError' : e.constructor.name === 'TranslateError' ? 'TranslateError' : 'OTHER ' + e.stack;
      r = { err: name, msg: e.message }; if (name === 'RateLimited') r.delay = Math.round(e.delay * 1e6) / 1e6;
    }
    const label = `${group} / ${sc.name} #${i}`;
    same(r, want.result, label + ' result');
    same(calls, want.calls, label + ' requests');
    same(clock.sleeps, want.sleeps, label + ' sleeps');
    eq(queue.length, want.left, label + ' answers used');
  }
  same(notes, sc.notes, `${group} / ${sc.name} usage notices`);
  eq(await usage.total(), sc.usage_total, `${group} / ${sc.name} usage total`);
}
for (const group of ['openai', 'google', 'custom']) for (const sc of G[group]) await scenario(group, sc);
