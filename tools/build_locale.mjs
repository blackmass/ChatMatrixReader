// node tools/build_locale.mjs <base.txt> <missing.txt> <new.txt> > locale/en-US.txt   (one-off helper that made locale/en-US.txt from the 2.0 file)
import fs from 'node:fs';
import { parseLocale } from '../app/core/i18n.js';
import { collect } from './locale_keys.mjs';
const [base, missing, news, extra] = process.argv.slice(2);
const old = parseLocale(fs.readFileSync(base, 'utf8')).entries;
const miss = fs.readFileSync(missing, 'utf8').split('\n').filter(Boolean), en = fs.readFileSync(news, 'utf8').split('\n').filter(Boolean);
if (miss.length !== en.length) throw new Error(`${miss.length} keys, ${en.length} translations`);
const add = Object.fromEntries(miss.map((k, i) => [k, en[i]]));
if (extra) Object.assign(add, parseLocale(fs.readFileSync(extra, 'utf8')).entries);       // 'ko = en' lines for texts added later
const esc = s => s.replace(/\n/g, '\\n');
const out = ['# ChatMatrix Reader language file.', '# Format:  Korean original = translation      (\\n = line break, keep {placeholders} unchanged)',
  '# To add a language: copy this file to e.g. ja-JP.txt, change @name, and translate the right-hand side.',
  '# Text without an entry is shown in Korean.  `node tools/locale_keys.mjs locale/xx-XX.txt` lists what is missing.', '', '@name = English (US)', ''];
for (const key of collect().keys()) {
  const v = Object.hasOwn(add, key) ? add[key] : old[key];
  if (v !== undefined) out.push(`${esc(key)} = ${esc(v)}`);
}
console.log(out.join('\n'));
