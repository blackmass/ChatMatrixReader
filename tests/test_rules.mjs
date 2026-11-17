import fs from 'node:fs';
import path from 'node:path';
import * as r from '../app/core/translate_rules.js';
import { HERE, eq } from './helpers.mjs';

for (const [fn, args, want] of JSON.parse(fs.readFileSync(path.join(HERE, 'golden', 'rules.json'), 'utf8'))) {
  let got;
  if (fn === 'langCode') { try { got = ['ok', r.langCode(...args)]; } catch (e) { if (!(e instanceof r.TranslateError)) throw e; got = ['err']; } }
  else if (fn === 'modesInUse') got = [...r.modesInUse(...args)].sort();
  else got = r[fn](...args);
  eq(got, want, `${fn}(${JSON.stringify(args)})`);
}
