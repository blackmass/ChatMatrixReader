// node tests/run.mjs  -> runs every tests/test_*.mjs
import fs from 'node:fs';
import { HERE, summary } from './helpers.mjs';

let failed = 0;
for (const f of fs.readdirSync(HERE).filter(n => /^test_.*\.mjs$/.test(n)).sort()) {
  const before = summary();
  console.log('== ' + f);
  try { await import('./' + f); } catch (e) { console.log('  ERROR: ' + (e.stack || e)); failed++; }
  const after = summary();
  console.log(`   ${after.passed - before.passed} ok, ${after.failed - before.failed} failed`);
}
const s = summary();
console.log(`\n${s.passed} checks passed, ${s.failed + failed} failed`);
process.exit(s.failed + failed ? 1 : 0);
