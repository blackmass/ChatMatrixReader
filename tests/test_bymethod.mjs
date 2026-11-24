// 3.2.1: what a translation method has of its own (by_method): the glossary and the prompt. Everything else follows the shared settings.
import { check, eq } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import { log } from '../app/core/log.js';
import { Glossary, LIST_PLACEHOLDER } from '../app/core/glossary.js';
import { renderPrompt } from '../app/core/translate.js';
import { withMethod, applyRoute, glossaryFiles, cleanByMethod, glossaryInPrompt } from '../app/core/translate_rules.js';
import { normalize } from '../app/core/config.js';
import { GlossWatch } from '../app/core/upkeep.js';

log.quiet = true;
const base = { translator: 'openai', glossary_file: 'Glossary.txt', glossary_mode: 'full', glossary_style: 'paren', glossary_google: true, prompt: 'P {{Glossary.txt}}', extra_prompt: 'E' };

// nothing of its own: the same settings (not even a copy)
check(withMethod(base) === base && withMethod({ ...base, by_method: {} }).prompt === 'P {{Glossary.txt}}', 'by_method: nothing of its own = the shared settings');
// a method with its own keys: only those keys change, only for that method
{
  const cfg = { ...base, by_method: { openai: { glossary_file: 'AI.txt', prompt: 'Q {{AI.txt}}' }, google: { glossary_file: 'G.txt', glossary_style: 'replace' } } };
  const ai = withMethod(cfg);
  eq([ai.glossary_file, ai.prompt, ai.extra_prompt, ai.glossary_mode], ['AI.txt', 'Q {{AI.txt}}', 'E', 'full'], 'by_method: the keys of the method are its own, the others follow');
  eq(withMethod({ ...cfg, translator: 'custom' }).glossary_file, 'Glossary.txt', 'by_method: a method without an entry follows');
  eq([withMethod({ ...cfg, translator: 'google' }).glossary_file, withMethod({ ...cfg, translator: 'google' }).glossary_style], ['G.txt', 'replace'], 'by_method: google');
  eq(withMethod({ ...cfg, translator: 'none' }).glossary_file, 'Glossary.txt', 'by_method: no method, nothing');
  // the routes: both Google routes are the method google; a channel that goes to the AI server has the AI settings whatever the translation tab says
  const g1 = applyRoute({ ...cfg, translator: 'custom' }, 'google_free'), g2 = applyRoute({ ...cfg, translator: 'custom' }, 'google');
  eq([g1.glossary_file, g2.glossary_file, g1.google_free, g2.google_free], ['G.txt', 'G.txt', true, false], 'by_method: the two Google routes are one method');
  eq(applyRoute({ ...cfg, translator: 'google' }, 'openai').glossary_file, 'AI.txt', 'by_method: a route to the AI server has the AI settings');
  eq(applyRoute({ ...cfg, translator: 'google' }, null).glossary_file, 'G.txt', 'by_method: no route: the method of the translation tab');
  // sending: its own prompt and no glossary: what a method has of its own does not apply
  const s = applyRoute({ ...cfg, prompt: 'SEND' }, 'openai', true);
  eq([s.prompt, s.glossary_file], ['SEND', 'Glossary.txt'], 'by_method: the sending does not take it');
}
// the saved file: cleaned
{
  eq(cleanByMethod(undefined), {}, 'clean: nothing'); eq(cleanByMethod([]), {}, 'clean: a list is nothing'); eq(cleanByMethod('x'), {}, 'clean: a text is nothing');
  eq(cleanByMethod({ openai: { glossary_file: ' AI.txt ', glossary_mode: 'list', prompt: 'p', junk: 1 }, deepl: { prompt: 'x' }, google: { glossary_mode: 'bad', prompt: 5, glossary_style: 'replace', glossary_google: false } }),
    { google: { glossary_google: false, glossary_style: 'replace' }, openai: { glossary_file: 'AI.txt', glossary_mode: 'list', prompt: 'p' } }, 'clean: only the three methods and the known keys of the right kind');
  eq(cleanByMethod({ custom: { glossary_file: '  ' }, openai: null }), {}, 'clean: a method with nothing left is gone');
  eq(normalize({ by_method: { google: { glossary_file: 'G.txt', evil: 1 } } }).by_method, { google: { glossary_file: 'G.txt' } }, 'normalize: by_method is cleaned');
  eq(normalize({}).by_method, {}, 'normalize: by_method is empty by default');
}
// the glossary files in use
{
  eq(glossaryFiles({}), ['Glossary.txt'], 'files: the default');
  eq(glossaryFiles({ glossary_file: 'A.txt', by_method: { google: { glossary_file: 'A.txt' }, openai: { glossary_file: 'B.txt' } } }), ['A.txt', 'B.txt'], 'files: every file once');
}
// the placeholder of the glossary in a prompt: with "list" / "mixed" the entries travel with the line, so the glossary that is in use is a hint, whatever its name
{
  const g = new Glossary(memoryFiles({ 'Glossary.txt': 'a = b\n', 'AI.txt': 'c = d\n' }), { now: () => 0 });
  const p = 'Start {{AI.txt}} end';
  check((await renderPrompt(g, p, '한국어', 'list', '', 'AI.txt')).includes(LIST_PLACEHOLDER), 'placeholder: list mode: the file in use is a hint');
  check(!(await renderPrompt(g, p, '한국어', 'full', '', 'AI.txt')).includes(LIST_PLACEHOLDER) && (await renderPrompt(g, p, '한국어', 'full', '', 'AI.txt')).includes('c = d'), 'placeholder: full mode: the file');
  check(!(await renderPrompt(g, p, '한국어', 'list', '')).includes(LIST_PLACEHOLDER), 'placeholder: list mode, another file than the one in use: its content (as before)');
  check((await renderPrompt(g, 'X {{Glossary.txt}}', '한국어', 'list', '', 'AI.txt')).includes(LIST_PLACEHOLDER), 'placeholder: Glossary.txt stays a hint (as before)');
}
// the glossary watch looks at every file in use
{
  const files = memoryFiles({ 'Glossary.txt': 'a = b\n', 'AI.txt': 'c = d\n' });
  const g = new Glossary(files, { now: () => 0 });
  const cfg = { translator: 'google', glossary_file: 'Glossary.txt', by_method: { openai: { glossary_file: 'AI.txt' } } };
  const w = new GlossWatch(g, cfg);
  eq(await w.check(cfg), null, 'watch: nothing changed');
  await files.write('AI.txt', 'c = d\ne = f\n'); g.sigChecked = -1e12; g.cache = new Map(); 
  let n = null; for (let i = 0; i < 3 && n === null; i++) n = await w.check(cfg);
  check(n !== null, 'watch: a saved file of a method is noticed');
}
// the glossary that is set against the glossary the prompt has (the options say so; the translation works either way)
{
  eq(glossaryInPrompt('x {{Glossary.txt}} y', 'Glossary.txt'), null, 'prompt check: the same file');
  eq(glossaryInPrompt('x {{glossary.TXT}} y', ' Glossary.txt '), null, 'prompt check: letters and spaces do not matter');
  eq(glossaryInPrompt('x {{Glossary.txt}} y', 'AI.txt'), { names: ['Glossary.txt'] }, 'prompt check: another file');
  eq(glossaryInPrompt('x {{ Glossary.txt }} {{Extra.txt}} {{extra_prompt}}', 'AI.txt'), { names: ['Glossary.txt', 'Extra.txt'] }, 'prompt check: every file of the prompt, not {{extra_prompt}}');
  eq(glossaryInPrompt('x {{extra_prompt}}', 'AI.txt'), { names: [] }, 'prompt check: no place for a glossary');
  eq(glossaryInPrompt('x', ''), { names: [] }, 'prompt check: an empty name is the default one');
  eq(glossaryInPrompt('x {{Glossary.txt}}', ''), null, 'prompt check: an empty name finds the default file');
  eq(glossaryInPrompt('x', 'AI.txt', 'list'), null, 'prompt check: "list": the entries travel with the line, nothing to say');
  eq(glossaryInPrompt('x', 'AI.txt', 'mixed'), null, 'prompt check: "mixed": the same');
}
