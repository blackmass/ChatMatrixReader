// the window feed against the 2.0 answers (tests/golden/feed.json, 27 MB, not kept in git: tools/make_golden.py makes it)
import fs from 'node:fs';
import path from 'node:path';
import { HERE } from './helpers.mjs';

if (fs.existsSync(path.join(HERE, 'golden', 'feed.json'))) await import('./feed_check.mjs');
else console.log('  (tests/golden/feed.json is missing: skipped; python tools/make_golden.py <ChatMatrixReader2/app> makes it)');
