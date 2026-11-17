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

for (const f of G.feeds) {
  const feed = new WindowFeed(f.wid, () => ({ ...f.cfg, pending_mark: false }), () => f.conf);       // (the 2.0 answer key has no "…" line)
  let bad = 0, ops = 0;
  f.log.forEach(([ev, want], i) => {
    const got = feed.handle(ev);
    ops += got.length;
    if (canon(got) !== canon(want) && bad++ < 2) eq(got, want, `${f.name} wid ${f.wid} swap ${f.swap} max ${f.max_lines}: event ${i} (${ev.type})`);
  });
  check(bad === 0, `${f.name} wid ${f.wid}: ${bad} events gave other operations`);
  check(canon(feed.model.blocks) === canon(f.blocks), `${f.name} wid ${f.wid}: the final blocks are the same`);
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
