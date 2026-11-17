// The language files: every Korean text of the program is translated in locale/en-US.txt, the {placeholders} agree, and the choice of the
// language works (tools/locale_keys.mjs lists what is missing).
import fs from 'node:fs';
import path from 'node:path';
import { HERE, check } from './helpers.mjs';
import { parseLocale, pickLanguage, tr, setTable } from '../app/core/i18n.js';
import { collect } from '../tools/locale_keys.mjs';

const ROOT = path.join(HERE, '..');
const en = parseLocale(fs.readFileSync(path.join(ROOT, 'locale', 'en-US.txt'), 'utf8'));
check(en.name === 'English (US)', 'en-US has a name');
const missing = [...collect().keys()].filter(k => !Object.hasOwn(en.entries, k));
check(missing.length === 0, 'en-US translates every text of the program: ' + missing.slice(0, 3).map(k => k.slice(0, 40)).join(' | ') + (missing.length > 3 ? ` (+${missing.length - 3})` : ''));
const holders = s => (s.match(/\{[A-Za-z_]\w*\}/g) || []).sort().join();
const bad = Object.entries(en.entries).filter(([k, v]) => holders(k) !== holders(v));
check(bad.length === 0, 'the {placeholders} of a text and its translation agree: ' + bad.slice(0, 3).map(([k]) => k.slice(0, 40)).join(' | '));

// choosing the language
const codes = ['en-US', 'ja-JP'];
check(pickLanguage('ja-JP', codes, 'ko-KR') === 'ja-JP', 'the configured language wins');
check(pickLanguage('', codes, 'ko-KR') === 'ko-KR' && pickLanguage('', codes, 'ko') === 'ko-KR', 'system Korean -> the built-in language');
check(pickLanguage('', codes, 'ja-JP') === 'ja-JP' && pickLanguage('', codes, 'en-GB') === 'en-US', 'system language: exact, then the same primary language');
check(pickLanguage('', codes, 'fr-FR') === 'en-US' && pickLanguage('', [], 'fr-FR') === 'ko-KR', 'no file for the system language -> English, else Korean');
check(pickLanguage('xx-XX', codes, 'en-US') === 'en-US', 'a configured language that does not exist is ignored');

setTable(en.entries, 'en-US');
check(tr('열었을 때 값으로 되돌리기: {v}', { v: '켬' }) === 'Back to the value when opened: 켬', 'tr() with placeholders');
setTable({}, 'ko-KR');
check(tr('저장') === '저장', 'Korean is the built-in language');
