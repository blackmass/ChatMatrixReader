// node tools/locale_keys.mjs [locale/en-US.txt]
// Lists the Korean texts of the program (the keys of the locale files) that a locale file does not translate yet, so a translator sees what is missing.
// A text is any string literal with Hangul in app/ (JS) and the text / placeholder / title of app/*.html. Prompts and log lines are left out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLocale } from '../app/core/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAN = /[가-힣]/;
const SKIP_FILES = new Set(['prompts.js', 'prompts_legacy.js', 'control.js', 'control.html', 'joiner.js']);       // (the control window is a test page)
// texts that are data, not words of the user interface (language names, a grammar particle ...)
export const IGNORE = new Set(['한국어', '으', '한국어 (${DEFAULT_LANG})', 'Google v2(키)', 'Google gtx(키 없음)', '(위와 같음, ${[...content].length}글자)', '매트릭스:', '찾는 중...', '| 게임 창:', '최소화됨', '없음',
  '${cfg.api_url} model=${cfg.api_model || \'(기본)\'}', '| 토큰 입력 ${ctx.usage[0]} 출력 ${ctx.usage[1]}']);       // (log lines)

function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p, out); else if (/\.(js|html)$/.test(n) && !SKIP_FILES.has(n)) out.push(p);
  }
  return out;
}
const unescape = s => s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`').replace(/\\\\/g, '\\');

export function collect() {
  const keys = new Map();                                       // text -> first place
  const add = (t, where) => { t = t.trim(); if (t && HAN.test(t) && !IGNORE.has(t) && !keys.has(t)) keys.set(t, where); };
  for (const f of walk(path.join(ROOT, 'app'))) {
    const rel = path.relative(ROOT, f);
    const src = fs.readFileSync(f, 'utf8').replace(/'\s*\n?\s*\+\s*\n?\s*'/g, '');       // 'a' + 'b' (one text written over several lines) is one key
    if (f.endsWith('.html')) {
      for (const m of src.matchAll(/>([^<>]*[가-힣][^<>]*)</g)) add(m[1].replace(/\s+/g, ' '), rel);
      for (const m of src.matchAll(/(?:placeholder|title|aria-label)="([^"]*[가-힣][^"]*)"/g)) add(m[1], rel);
      continue;
    }
    for (const line of src.split('\n')) {
      if (/^\s*(\/\/|\*)/.test(line) || /\blog\.(info|warn|error|debug)\(/.test(line) || /console\./.test(line) || /hubLog\(|\$\('matrix'\)/.test(line)) continue;
      const code = line.replace(/\s\/\/ .*$/, '').replace(/keywords: '[^']*'/g, '').replace(/\b(hubLog|log)\(/g, 'LOG(');
      for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) { const t = unescape(m[1] ?? m[2] ?? m[3] ?? ''); if (/<[a-z][^>]*>/i.test(t)) { for (const h of t.matchAll(/>([^<>]*[가-힣][^<>]*)</g)) add(h[1], rel); } else add(t, rel); }
    }
  }
  return keys;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const have = file ? parseLocale(fs.readFileSync(file, 'utf8')).entries : {};
  let n = 0;
  for (const [t, where] of collect()) if (!Object.hasOwn(have, t)) { console.log(`${t.replace(/\n/g, '\\n')}\t${where}`); n++; }
  console.error(`${n} missing`);
}
