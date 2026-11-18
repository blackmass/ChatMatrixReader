// chatmodel.js / windowfeed.js / theme.js / fade.js against the 2.0 Python answers (tests/golden/feed.json)
import fs from 'node:fs';
import path from 'node:path';
import { WindowFeed } from '../app/core/windowfeed.js';
import * as theme from '../app/core/theme.js';
import * as fade from '../app/core/fade.js';
import { log } from '../app/core/log.js';
import { HERE, check, eq, canon } from './helpers.mjs';

log.quiet = true;
const FILE = path.join(HERE, 'golden', 'feed.json');
// feed.json is 27 MB: it is not kept in git (tests/golden/.gitignore). `python tools/make_golden.py <ChatMatrixReader2/app>` makes it again.
const G = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// 3.x writes the mark of a channel in square brackets ("[1] [Name]: text", as the game does), 2.0 wrote round ones ("(1) [Name]: text"): the same answers with that one
// difference. (Only the beginning of a piece of text, after the time: "12:00:00 (1) " -> "12:00:00 [1] ", "(음성) " -> "[음성] ".)
const MARK = /^((?:\d\d:\d\d:\d\d )?)\(([^()\s]{1,6})\) /;
const brackets = v => (Array.isArray(v) ? v.map(brackets) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'text' && typeof x === 'string' ? x.replace(MARK, '$1[$2] ') : brackets(x)])) : v);
const sameAs2 = (got, want) => canon(got) === canon(want) || canon(got) === canon(brackets(want));

for (const f of G.feeds) {
  const feed = new WindowFeed(f.wid, () => ({ ...f.cfg, pending_mark: false }), () => f.conf);       // (the 2.0 answer key has no "…" line)
  let bad = 0, ops = 0;
  f.log.forEach(([ev, want], i) => {
    const got = feed.handle(ev);
    ops += got.length;
    if (!sameAs2(got, want) && bad++ < 2) eq(got, brackets(want), `${f.name} wid ${f.wid} swap ${f.swap} max ${f.max_lines}: event ${i} (${ev.type})`);
  });
  check(bad === 0, `${f.name} wid ${f.wid}: ${bad} events gave other operations`);
  check(sameAs2(feed.model.blocks, f.blocks), `${f.name} wid ${f.wid}: the final blocks are the same`);
  check(canon(feed.model.blocks.map(b => feed.model.color(b))) === canon(f.colors), `${f.name} wid ${f.wid}: the block colours are the same`);
  check(canon(feed.model.typeColors) === canon(f.type_colors), `${f.name} wid ${f.wid}: the chat type colours are the same`);
  console.log(`  ${f.name} wid ${f.wid} swap ${f.swap} max ${f.max_lines}: ${f.log.length} events, ${ops} operations, ${feed.model.blocks.length} blocks left`);
}

const camel = s => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
let bad = 0;
for (const [fn, args, want] of G.theme) {
  const mod = fn === 'alpha' ? fade : theme;
  const got = mod[camel(fn)](...args);
  if (JSON.stringify(got) !== JSON.stringify(want) && bad++ < 8) eq(got, want, `${fn}(${JSON.stringify(args)})`);
  else check(true, '');
}
check(bad === 0, `theme/fade: ${bad} of ${G.theme.length} differ`);
