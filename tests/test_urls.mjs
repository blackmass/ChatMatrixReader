// The addresses in a line of the chat: which are found, which are refused, how they are shown.
import { check } from './helpers.mjs';
import * as U from '../app/core/urls.js';

const urls = t => U.findUrls(t).map(f => f.url);
const same = (got, want, msg) => check(JSON.stringify(got) === JSON.stringify(want), msg + ': ' + JSON.stringify(got));

same(urls('join https://discord.gg/abc123 now'), ['https://discord.gg/abc123'], 'a full address');
same(urls('디스코드 discord.gg/abc123로 오세요'), ['https://discord.gg/abc123'], 'a known place said without https, a Korean particle stuck to it is not part of it');
same(urls('see (https://www.wowhead.com/item=19019/thunderfury).'), ['https://www.wowhead.com/item=19019/thunderfury'], 'the bracket and the dot of the sentence are not part of it');
same(urls('https://youtube.com/watch?v=abc&t=10s!'), ['https://youtube.com/watch?v=abc&t=10s'], 'a query keeps its & and the ! at the end goes');
same(urls('youtu.be/xyz and blog.naver.com/eternalguard'), ['https://youtu.be/xyz', 'https://blog.naver.com/eternalguard'], 'two places, a sub-domain of a known one');
same(urls('Naxx.exe crashed, see foo.bar, discord.gg, mail bob@discord.gg'), [], 'a file name, an unknown place, a place with nothing after it, an e-mail: no links');
same(urls('http://192.168.0.1/admin https://1.2.3.4/x https://[::1]/ https://0x7f.1/ https://localhost/'), [], 'a number or a name without a dot is refused');
same(urls('https://user:pw@evil.com/ https://evil.com:8080/x'), [], 'a user name, a password, a port: refused');
same(urls('https://аpple.com/ https://xn--pple-43d.com/'), [], 'a disguised name is refused');
same(urls('ftp://a.b/c javascript:alert(1) file:///c:/x.exe'), [], 'not http or https: refused');
same(urls('https://a.b/' + 'x'.repeat(600)), [], 'too long: refused');
same(urls('https://example.com/a b'), ['https://example.com/a'], 'a space ends it');

same(U.label('https://www.discord.gg/abc123'), '[discord.gg/abc123]', 'the short form: no scheme, no www');
check(U.label('https://example.com/' + 'a'.repeat(80)).length === 42 && U.label('https://example.com/' + 'a'.repeat(80)).endsWith('…]'), 'a long one is cut with …');

{
  const s = U.split('go discord.gg/abc now');
  same(s, [{ text: 'go ' }, { text: '[discord.gg/abc]', url: 'https://discord.gg/abc' }, { text: ' now' }], 'split');
  same(U.split('nothing here'), [{ text: 'nothing here' }], 'split: no address');
  same(U.split(''), [{ text: '' }], 'split: empty');
}
check(U.safeUrl('https://ok.example/a?b=1&c=2#d') === 'https://ok.example/a?b=1&c=2#d' && U.safeUrl('http://ok.example') === 'http://ok.example/', 'safeUrl: https and http');
check(U.safeUrl('https://ok.example/\u0000') === null && U.safeUrl('https://ok.example/"x') === null && U.safeUrl(5) === null, 'safeUrl: hidden characters, quotes, not a text');
