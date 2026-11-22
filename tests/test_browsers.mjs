// The browser windows and the bookmarks: what is read from the settings is made right, window 1 is always there.
import { check } from './helpers.mjs';
import * as b from '../app/core/browsers.js';

check(b.isWebUrl('https://m.dcinside.com') && b.isWebUrl('http://a.b/c?d=1') && !b.isWebUrl('ftp://a.b') && !b.isWebUrl('javascript:alert(1)') && !b.isWebUrl('file:///c:/x') && !b.isWebUrl('https://a b') && !b.isWebUrl('') && !b.isWebUrl(5), 'isWebUrl: http and https only, one piece of text');

{
  const l = b.normalizeBrowsers([]);
  check(l.length === 1 && l[0].id === 1 && l[0].mode === 'mobile' && l[0].start_kind === 'url' && l[0].start_url === b.START_URL && l[0].persist === false && l[0].topmost === true, 'no list: window 1 is made (mobile, Google, no login kept)');
  check(b.normalizeBrowsers(undefined).length === 1 && b.normalizeBrowsers('x').length === 1, 'not a list: the same');
}
{
  const l = b.normalizeBrowsers([{ id: 3, name: ' PC ', mode: 'pc', start_url: 'https://www.youtube.com' }, { id: 3, name: 'again' }, { id: 0 }, { id: 'x' }, null, { id: 2, mode: 'tv', start_kind: 'what', start_url: 'javascript:1', persist: 'yes' }]);
  check(l.map(x => x.id).join() === '1,2,3', 'the numbers are unique and in order, window 1 is added: ' + l.map(x => x.id));
  const w3 = l.find(x => x.id === 3), w2 = l.find(x => x.id === 2);
  check(w3.name === 'PC' && w3.mode === 'pc' && w3.start_url === 'https://www.youtube.com', 'a good window is kept (the name is trimmed)');
  check(b.normalizeBrowsers([{ id: 2, zoom: 1.26 }, { id: 3, zoom: 9 }, { id: 4, zoom: 'x' }, { id: 5, zoom: 0.01 }]).filter(x => x.id > 1).map(x => x.zoom).join() === '1.3,3,1,0.3', 'zoom: a step of 10 %, 30 % .. 300 %, a wrong value is 100 %');
  check(b.normalizeBrowsers([{ id: 2, idle_alpha: 0.5 }, { id: 3, idle_alpha: 0 }, { id: 4, idle_alpha: 'x' }]).filter(x => x.id > 1).map(x => x.idle_alpha).join() === '0.5,0.2,1', 'idle_alpha: 20 % .. 100 %, a wrong value is 100 %');
  check(w2.mode === 'mobile' && w2.start_kind === 'url' && w2.start_url === b.START_URL && w2.persist === false, 'a wrong value is the default');
}
{
  const many = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
  const l = b.normalizeBrowsers(many);
  check(l.length === b.MAX_BROWSERS && l[0].id === 1, 'no more than ' + b.MAX_BROWSERS + ' windows, window 1 stays');
  check(!b.canAddBrowser(l) && b.canAddBrowser([{ id: 1 }]), 'canAddBrowser follows the limit');
  check(b.nextBrowserId([{ id: 1 }, { id: 5 }]) === 6 && b.nextBrowserId([]) === 2, 'the next number is after the biggest');
}
{
  const l = b.normalizeBrowsers([{ id: 1, topmost: true, topmost_wow_only: true, geometry: 'bad' }, { id: 2, geometry: '360x640+10+-20', last_url: 'https://a.b/' }]);
  check(l[0].topmost === false && l[0].topmost_wow_only === true && l[0].geometry === '', '"above the game only" takes "always on top" off; a wrong place is dropped');
  check(l[1].geometry === '360x640+10+-20' && l[1].last_url === 'https://a.b/', 'a good place and last address are kept');
}
{
  check(b.browserName([{ id: 1, name: '' }, { id: 4, name: '' }, { id: 5, name: '공략' }], 1) === '모바일' && b.browserName([{ id: 4, name: '' }], 4) === '브라우저 4' && b.browserName([{ id: 5, name: '공략' }], 5) === '공략', 'the names: window 1 is "모바일", the others "브라우저 N" until they are named');
  const m = b.normalizeBookmarks([{ name: ' 지도 ', url: 'https://map.kakao.com/' }, { url: 'https://a.b/c' }, { name: 'bad', url: 'javascript:1' }, { name: 'x' }, 5, null]);
  check(m.length === 2 && m[0].name === '지도' && m[1].name === 'a.b', 'bookmarks: bad ones are dropped, the host is the name when it was left empty');
  check(b.normalizeBookmarks(undefined).length === 0 && b.normalizeBookmarks(Array.from({ length: 300 }, (_, i) => ({ url: 'https://a.b/' + i }))).length === b.MAX_BOOKMARKS, 'no list: none; at most ' + b.MAX_BOOKMARKS);
}

// the address bar
check(b.addressFrom('https://a.b/c') === 'https://a.b/c' && b.addressFrom('namu.wiki/w/x') === 'https://namu.wiki/w/x' && b.addressFrom(' m.dcinside.com ') === 'https://m.dcinside.com' && b.addressFrom('localhost:3000/x') === 'https://localhost:3000/x', 'addressFrom: an address as it is, a site gets https://');
check(b.addressFrom('wow 레이드 공략') === 'https://www.google.com/search?q=' + encodeURIComponent('wow 레이드 공략') && b.addressFrom('hello') === 'https://www.google.com/search?q=hello' && b.addressFrom('') === '' && b.addressFrom('javascript:alert(1)').startsWith('https://www.google.com/search'), 'addressFrom: anything else is a search (also what looks like a script)');
