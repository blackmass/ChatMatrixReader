// chattext.js and joiner.js against the answers of the 2.0 Python code (tests/golden)
import fs from 'node:fs';
import path from 'node:path';
import * as ct from '../app/core/chattext.js';
import { Joiner } from '../app/core/joiner.js';
import { log } from '../app/core/log.js';
import { HERE, eq } from './helpers.mjs';

log.quiet = true;
const read = n => JSON.parse(fs.readFileSync(path.join(HERE, 'golden', n), 'utf8'));
const camel = s => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
const special = {
  plain_orig: (t, o) => ct.plain(t, o), segments_local: (t, o) => ct.segments(t, o),
  split_translation_tips: (...a) => ct.splitTranslation(...a), color_brackets_tips: (...a) => ct.colorBrackets(...a),
};

let bad = 0;
for (const [fn, args, want] of read('chattext.json')) {
  const f = special[fn] || ct[camel(fn)];
  if (!f) { eq(`missing ${fn}`, 'present', fn); continue; }
  let got = f(...args);
  if (fn === 'hide_protected' || fn === 'mask_links' || fn === 'ensure_links') got = [...got];
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b && bad++ < 12) eq(got, want, `${fn}(${JSON.stringify(args)})`);
  else if (a === b) eq(1, 1, '');
}
console.log(`  chattext: ${read('chattext.json').length} golden cases, ${bad} differ`);

let jbad = 0;
for (const [steps, want] of read('joiner.json')) {
  const j = new Joiner(1.0);
  const got = steps.map(st => (st[0] === 'feed'
    ? j.feed({ channel: st[1], id: st[2], sender: st[3], text: st[4], cls: '', base: -1 }, st[5])
    : j.flushDue(st[1], st[2])));
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { jbad++; eq(got, want, 'joiner ' + JSON.stringify(steps)); } else eq(1, 1, '');
}
console.log(`  joiner: ${read('joiner.json').length} scenarios, ${jbad} differ`);
