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
  eq(r.manifest.permissions, { net: ['example.com', 'api.example.com'], 'chat.inject': true, storage: true }, 'plugins: the permissions are cleaned');
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
  eq(p.effective(m, g), { net: ['example.com'], 'chat.inject': true, storage: true }, 'plugins: what may be done = asked AND allowed');
  eq(p.effective(m, { net: ['other.org', 'example.com'], storage: true }), { net: ['example.com'], 'chat.inject': false, storage: true }, 'plugins: an allowed host the manifest does not name is not used');
  const none = p.effective(parse({ ...good(), permissions: {} }).manifest, g);
  eq(none, { net: [], 'chat.inject': false, storage: false }, 'plugins: a permission removed from the manifest is not used any more');
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
  eq(p.optionValues(a, { interval: 100, stranger: 1, url: 'u' }), { url: 'u', interval: 100, on: false, mode: 'b' }, 'plugins: option values = the user\'s over the defaults, an undeclared one dropped');
}
