// The manifest of a plugin (plugin.json), the permissions and what is allowed (app/core/plugins.js)
import * as p from '../app/core/plugins.js';
import { check, eq } from './helpers.mjs';

const ID = 'community-watch-9f3a7c21b5';
const good = () => ({
  id: ID, name: '커뮤니티 새 글', version: '1.0.0', api: 1, author: 'me', description: 'x',
  permissions: { net: ['example.com', 'api.example.com'], 'chat.inject': true, storage: true },
  reasons: { net: 'a', 'chat.inject': 'b', storage: 'c' },
  options: [{ key: 'url', type: 'text', label: '주소', default: '' }, { key: 'interval', type: 'number', min: 30, default: 60 }, { key: 'on', type: 'check' },
    { key: 'mode', type: 'select', choices: [{ value: 'a', label: 'A' }, { value: 'b' }], default: 'b' }],
});
const parse = (o, folder = ID) => p.parseManifest(JSON.stringify(o), folder);

{ // a good manifest
  const r = parse(good());
  check(r.ok && r.errors.length === 0 && r.warnings.length === 0, 'plugins: a good manifest is accepted: ' + JSON.stringify(r.errors.concat(r.warnings)));
  eq(r.manifest.permissions, { net: ['example.com', 'api.example.com'], netAny: false, 'chat.inject': true, storage: true, widgets: false, windows: false, openUrl: false, web: "" }, 'plugins: the permissions are cleaned');
  eq(r.manifest.main, 'background.html', 'plugins: main defaults to background.html');
  eq(r.manifest.options.map(o => [o.key, o.type, o.default]), [['url', 'text', ''], ['interval', 'number', 60], ['on', 'check', false], ['mode', 'select', 'b']], 'plugins: the options with their defaults');
}
{ // the id
  check(!parse(good(), 'other-folder').ok && parse(good(), 'other-folder').errors[0].includes('folder'), 'plugins: the id must be the name of the folder');
  check(!parse({ ...good(), id: 'Big Name' }, 'Big Name').ok, 'plugins: a bad id is refused');
  const short = parse({ ...good(), id: 'abc' }, 'abc');
  check(short.ok && short.warnings.some(w => w.includes('short')), 'plugins: a short id is a warning, not an error');
}
{ // the other fields
  check(!parse({ ...good(), name: '' }).ok, 'plugins: name is needed');
  check(!parse({ ...good(), version: 'one' }).ok && parse({ ...good(), version: '2.1.0-beta.1' }).ok, 'plugins: version');
  check(!parse({ ...good(), api: 0 }).ok && !parse({ ...good(), api: 2 }).ok && parse({ ...good(), api: 1 }).ok, 'plugins: api 1 only (a newer one asks for a newer program)');
  check(!parse({ ...good(), main: '../x.html' }).ok && !parse({ ...good(), main: '/x.html' }).ok && !parse({ ...good(), main: 'a.js' }).ok && parse({ ...good(), main: 'ui/index.html' }).ok, 'plugins: main is an html file inside the folder');
  check(!p.parseManifest('{bad', ID).ok && !p.parseManifest('[]', ID).ok && p.parseManifest('﻿' + JSON.stringify(good()), ID).ok, 'plugins: bad JSON, a list, a BOM');
}
{ // permissions
  const bad = host => !parse({ ...good(), permissions: { net: [host] } }).ok;
  for (const h of ['*.example.com', 'example.com:8080', 'https://example.com', 'example.com/x', 'localhost', '10.0.0.1', '192.168.1.5', '[::1]', 'printer.local', 'nas.lan', 'Example.com', ' example.com', 'a', 'user@example.com'])
    check(bad(h), 'plugins: net host refused: ' + h);
  for (const h of ['example.com', 'api.example.co.kr', 'a-b.example.com', 'xn--abc.example.org']) check(!bad(h), 'plugins: net host accepted: ' + h);
  check(!parse({ ...good(), permissions: { files: true } }).ok, 'plugins: an unknown permission is an error');
  check(!parse({ ...good(), permissions: { storage: 'yes' } }).ok, 'plugins: a permission has its shape');
  eq(parse({ ...good(), permissions: { net: ['example.com', 'example.com'] } }).manifest.permissions.net, ['example.com'], 'plugins: a repeated host is kept once');
  check(!parse({ ...good(), permissions: { timer: true } }).ok, 'plugins: there is no timer permission');
  check(parse({ ...good(), reasons: {} }).warnings.length === 3, 'plugins: a permission without a reason is a warning');
  check(parse({ ...good(), strange: 1 }).warnings.some(w => w.includes('strange')), 'plugins: an unknown field is a warning');
}
{ // options
  check(!parse({ ...good(), options: [{ key: 'a b', type: 'text' }] }).ok && !parse({ ...good(), options: [{ key: 'a', type: 'color' }] }).ok, 'plugins: option key and type');
  check(!parse({ ...good(), options: [{ key: 'a', type: 'text' }, { key: 'a', type: 'text' }] }).ok, 'plugins: an option key is not repeated');
  check(!parse({ ...good(), options: [{ key: 'm', type: 'select' }] }).ok, 'plugins: a select needs choices');
  check(!parse({ ...good(), options: Array.from({ length: 51 }, (_, i) => ({ key: 'k' + i, type: 'check' })) }).ok, 'plugins: at most 50 options');
}
{ // approval: what is asked and not yet allowed, and what may really be done
  const m = parse(good()).manifest;
  eq(p.missing(m, null).map(x => x.perm + (x.host ? ':' + x.host : '')), ['net:example.com', 'net:api.example.com', 'chat.inject', 'storage'], 'plugins: nothing allowed yet: everything is missing');
  const g = { net: ['example.com'], 'chat.inject': true, storage: true };
  eq(p.missing(m, g).map(x => x.host), ['api.example.com'], 'plugins: one host is still to be allowed');
  eq(p.effective(m, g), { net: ['example.com'], netAny: false, 'chat.inject': true, storage: true, widgets: false, windows: false, openUrl: false, web: "" }, 'plugins: what may be done = asked AND allowed');
  eq(p.effective(m, { net: ['other.org', 'example.com'], storage: true }), { net: ['example.com'], netAny: false, 'chat.inject': false, storage: true, widgets: false, windows: false, openUrl: false, web: "" }, 'plugins: an allowed host the manifest does not name is not used');
  const none = p.effective(parse({ ...good(), permissions: {} }).manifest, g);
  eq(none, { net: [], netAny: false, 'chat.inject': false, storage: false, widgets: false, windows: false, openUrl: false, web: "" }, 'plugins: a permission removed from the manifest is not used any more');
  const eff = p.effective(m, g);
  check(p.netAllowed(eff, 'https://example.com/a?b=1') && !p.netAllowed(eff, 'http://example.com/') && !p.netAllowed(eff, 'https://api.example.com/') && !p.netAllowed(eff, 'https://example.com.evil.org/')
    && !p.netAllowed(eff, 'https://user:pw@example.com/') && !p.netAllowed(eff, 'not a url') && !p.netAllowed(eff, 'https://EXAMPLE.com@evil.org/'), 'plugins: an address is allowed only for an exact host over https');
}
{ // what the user is asked again about, and the values of the options
  const a = parse(good()).manifest;
  const b = parse({ ...good(), permissions: { ...good().permissions, net: ['example.com', 'api.example.com', 'new.example.com'] } }).manifest;
  const c = parse({ ...good(), name: 'another name', version: '2.0.0' }).manifest;
  check(p.permsKey(a) !== p.permsKey(b) && p.permsKey(a) === p.permsKey(c), 'plugins: the user is asked again when a permission or a host is new, not when only the name or the version changed');
  const def = k => a.options.find(o => o.key === k);
  eq([p.cleanOptionValue(def('interval'), '5'), p.cleanOptionValue(def('interval'), 1), p.cleanOptionValue(def('interval'), 'x'), p.cleanOptionValue(def('on'), 1), p.cleanOptionValue(def('mode'), 'zz'), p.cleanOptionValue(def('mode'), 'a'), p.cleanOptionValue(def('url'), 5), p.cleanOptionValue(def('url'), 'abc')],
    [30, 30, 60, false, 'b', 'a', '', 'abc'], 'plugins: option values are made right for their declaration');
  eq(p.optionValues(a, { interval: 100, stranger: 1, url: 'u' }), { url: 'u', interval: 100, on: false, mode: 'b', stranger: 1 }, 'plugins: option values = the user\'s over the defaults; a key of the plugin\'s own settings is kept');
  eq(Object.keys(p.optionValues(a, { 'bad key': 1, ok_key: { a: 1 }, fn: () => 1, big: 'x'.repeat(p.FREE_BYTES + 1) })).sort(), ['interval', 'mode', 'ok_key', 'on', 'url'], 'plugins: a bad key, a value JSON cannot hold, a value that is too big: dropped');
}
{ // the windows of a plugin
  const w = o => parse({ ...good(), permissions: { ...good().permissions, windows: true }, reasons: { ...good().reasons, windows: 'w' }, windows: o });
  const r = w([{ id: 'main', title: '내 창', page: 'ui/window.html', width: 500, height: 50 }]);
  check(r.ok && r.manifest.windows[0].width === 500 && r.manifest.windows[0].height === 120 && r.manifest.permissions.windows === true, 'plugins: a window is declared (the size is kept inside 120..2000)');
  eq(w([{ id: 'a', page: 'w.html' }]).manifest.windows[0], { id: 'a', title: 'a', page: 'w.html', width: 420, height: 300 }, 'plugins: a window: the title and the size have defaults');
  for (const bad of [[{ id: 'A b', page: 'w.html' }], [{ id: 'a', page: '../w.html' }], [{ id: 'a', page: 'w.js' }], [{ id: 'a', page: 'w.html' }, { id: 'a', page: 'w.html' }], 'x', Array.from({ length: 4 }, (_, i) => ({ id: 'w' + i, page: 'w.html' }))])
    check(!w(bad).ok, 'plugins: a bad windows list is refused: ' + JSON.stringify(bad).slice(0, 60));
  check(parse({ ...good(), windows: [{ id: 'a', page: 'w.html' }] }).warnings.some(x => x.includes('windows')), 'plugins: windows without the permission: a warning');
  const m1 = w([{ id: 'a', page: 'w.html' }]).manifest, m2 = w([{ id: 'a', page: 'w.html' }, { id: 'b', page: 'w.html' }]).manifest;
  check(p.permsKey(m1) !== p.permsKey(m2), 'plugins: a new window asks the user again');
}
{ // netAny: the hosts are not in the manifest, the user allows them one by one
  const m = parse({ ...good(), permissions: { ...good().permissions, netAny: true }, reasons: { ...good().reasons, netAny: 'x' } });
  check(m.ok && m.manifest.permissions.netAny === true && m.warnings.length === 0, 'plugins: netAny is accepted: ' + JSON.stringify(m.errors.concat(m.warnings)));
  const mm = m.manifest;
  eq(p.missing(mm, { net: ['example.com', 'api.example.com'], 'chat.inject': true, storage: true }).map(x => x.perm), ['netAny'], 'plugins: netAny is a permission to approve');
  eq(p.effective(mm, { net: ['example.com'], netAny: false }).net, ['example.com'], 'plugins: netAny not allowed: only the hosts of the manifest');
  eq(p.effective(mm, { net: ['example.com', 'forum.example.org', 'bad host', 'localhost'], netAny: true }).net, ['example.com', 'forum.example.org'], 'plugins: netAny allowed: the hosts the user allowed count (a wrong one does not)');
  check(p.effective(mm, { net: ['forum.example.org'], netAny: true }).netAny === true && p.effective(mm, { net: [], netAny: false }).netAny === false, 'plugins: effective tells netAny');
  const plain = parse(good()).manifest;
  eq(p.effective(plain, { net: ['example.com', 'forum.example.org'], netAny: true }).net, ['example.com'], 'plugins: without netAny in the manifest a granted host that it does not name is not used');
  check(p.permsKey(plain) !== p.permsKey(mm), 'plugins: netAny asks the user again');
}

// ---- the web permission
{
  const { registrableDomain, webPatterns, hostMatches, effective, parseManifest, missing } = await import('../app/core/plugins.js');
  check(registrableDomain('m.gall.dcinside.com') === 'dcinside.com' && registrableDomain('a.b.example.co.kr') === 'example.co.kr' && registrableDomain('example.com') === 'example.com', 'plugins: registrable domain');
  check(JSON.stringify(webPatterns(['gall.dcinside.com'], 'host')) === '["gall.dcinside.com"]' && JSON.stringify(webPatterns(['gall.dcinside.com', 'm.dcinside.com'], 'domain')) === '["*.dcinside.com"]' && webPatterns(['a.com'], '').length === 0, 'plugins: web patterns host / domain');
  check(hostMatches('m.dcinside.com', ['*.dcinside.com']) && hostMatches('dcinside.com', ['*.dcinside.com']) && !hostMatches('evildcinside.com', ['*.dcinside.com']) && !hostMatches('a.dcinside.com', ['dcinside.com']), 'plugins: pattern match');
  const base = { id: 'web-test', name: 'W', version: '1.0.0', api: 1, permissions: { net: ['a.example.com'], web: 'domain' } };
  const r = parseManifest(JSON.stringify(base), 'web-test');
  check(r.ok && r.manifest.permissions.web === 'domain', 'plugins: web is parsed');
  check(!parseManifest(JSON.stringify({ ...base, permissions: { web: 'all' } }), 'web-test').ok, 'plugins: web must be host or domain');
  check(missing(r.manifest, {}).some(x => x.perm === 'web'), 'plugins: web asked and not allowed is missing');
  check(effective(r.manifest, { net: ['a.example.com'], web: 'host' }).web === 'host' && effective(r.manifest, { net: ['a.example.com'], web: 'domain' }).web === 'domain'
    && effective(parseManifest(JSON.stringify({ ...base, permissions: { net: ['a.example.com'], web: 'host' } }), 'web-test').manifest, { net: ['a.example.com'], web: 'domain' }).web === 'host', 'plugins: the user may narrow domain to host, not widen host to domain');
}
