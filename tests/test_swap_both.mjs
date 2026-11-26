// "Translation above" and a line that is shown in both names (a link with an original name, nothing to translate): the local name is above and the original below, the same way round as
// the lines that are translated (before, such a line stayed "original above" in this mode, the other way round from its neighbours).
import { check, eq } from './helpers.mjs';
const { Pipeline, MAIN } = await import('../app/core/pipeline.js');
const { WindowFeed } = await import('../app/core/windowfeed.js');
const { DEFAULTS } = await import('../app/core/config.js');
const { log } = await import('../app/core/log.js'); log.quiet = true;
const Y = String.fromCharCode(48 + 10);
const link = (loc, orig) => `\x02${Y}${loc}\x04${orig}\x03`;
function show(swap, text) {
  const cfg = { ...structuredClone(DEFAULTS), translator: 'google', target_lang: '한국어', swap_trans: swap, pending_mark: false };
  const p = new Pipeline({ getCfg: () => cfg, translations: { submit: () => true }, getWindows: () => [], clock: () => '12:00:00' });
  const feed = new WindowFeed(MAIN, () => cfg);
  for (const e of p.onLine({ channel: 'G', text, sender: 'Bob', id: 1, cls: '', base: -1 })) feed.handle(e);
  return feed.model.blocks.map(b => b.pieces.map(x => x.text).join('').replace(/^\d\d:\d\d:\d\d /, ''));
}
const only = link('[아가만드가 납골당]', '[The Family Crypt]');
eq(show(false, only), ['[Bob]: [The Family Crypt]', '[아가만드가 납골당]'], 'original above: the original name, then the local name');
eq(show(true, only), ['[Bob]: [아가만드가 납골당]', '[The Family Crypt]'], 'translation above: the local name above, the original below');
eq(show(true, only + ' 테스트').length, 2, 'with words: two lines too');
check(show(true, only + ' 테스트')[0].includes('아가만드가'), 'with words: the local name above');
