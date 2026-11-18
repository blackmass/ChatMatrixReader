// Every character a glossary term can hold must compile (the pattern has the u flag: a wrong escape such as "\-" is a SyntaxError that
// stops every translation) and must match the term literally.
import { compile } from '../app/core/glossary.js';
import { eq, check } from './helpers.mjs';

const terms = ['Mal-Ganis', 'excavation site: wetlands', "krol'dok stronghold", 'M+', 'a/b', 'x.y', '(test)', '[x]', 'a|b', 'a^b$', '{1}', 'a\\b', 'a*b?', '+12', '-x-', '구인-파티', 'C++', 'Mal-Ganis-Prime'];
for (const t of terms) {
  let r;
  try { r = compile([[t, 'meaning']]); } catch (e) { check(false, `"${t}" compiles: ${e.message}`); continue; }
  const hit = `lf ${t} now`.match(r.regex);
  check(hit && hit[0].toLowerCase() === t.toLowerCase(), `"${t}" is found as written`);
}
eq('xx mal-ganis yy'.match(compile([['Mal-Ganis', 'a']]).regex)?.[0], 'mal-ganis', 'hyphen term, case-insensitive');
eq(compile([['Mal-Ganis', 'a']]).regex.test('mal ganis'), false, 'a hyphen is not "any character"');
const all = compile(terms.map(t => [t, 'm']));       // all in one pattern, as the glossary file does
check(all.regex, 'all terms in one pattern compile');
