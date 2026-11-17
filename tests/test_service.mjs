// the HTTP layer (makeHttp), the helpers around it, and the queue/cache/retry logic of TranslationService
import { check, eq } from './helpers.mjs';
import { memoryFiles } from './memoryfiles.mjs';
import { log } from '../app/core/log.js';
import { Glossary } from '../app/core/glossary.js';
import { makeHttp, quote, urlencode, openaiBase, cleanLlmOutput } from '../app/core/translate.js';
import { TranslationService } from '../app/core/translation_service.js';
import { TranslateError, TransientError, RateLimited } from '../app/core/translate_rules.js';

log.quiet = true;
const rejects = async (p, cls, msg, label) => { try { await p; check(false, label + ' (no error)'); } catch (e) { check(e instanceof cls && (msg === undefined || String(e.message).startsWith(msg)), `${label}: ${e.constructor.name} ${e.message}`.slice(0, 120)); } };

// ---- encoding like urllib
eq(urlencode([['a', "a b&c=d/é!'()*~_.-"]]), 'a=a+b%26c%3Dd%2F%C3%A9%21%27%28%29%2A~_.-', 'urlencode = quote_plus');
eq(quote('a b/é!~'), 'a%20b%2F%C3%A9%21~', 'quote(safe="")');

// ---- makeHttp
{
  const seen = [];
  let reply = { status: 200, body: '{"a":1}' };
  const transport = async req => { seen.push(req); if (typeof reply === 'function') return reply(req); return reply; };
  const http = makeHttp(transport);
  eq(await http.json('https://x.test/p', { q: 'é' }, { 'X-A': '1' }, 5), { a: 1 }, 'json post parsed');
  const r = seen[0], h = Object.fromEntries(r.headers);
  check(r.method === 'POST' && r.body === '{"q":"é"}' && h['Content-Type'] === 'application/json' && h['X-A'] === '1' && h.Accept === 'application/json' && h['User-Agent'].startsWith('ChatMatrixReader') && r.timeout === 5, 'json post request');
  await http.json('https://x.test/g', null, null, 5);
  check(seen[1].method === 'GET' && seen[1].body === null && !Object.fromEntries(seen[1].headers)['Content-Type'], 'json get request');
  await http.form('https://x.test/f', 'a=b', { 'Content-Type': 'application/x-www-form-urlencoded' }, 5);
  check(seen[2].method === 'POST' && seen[2].body === 'a=b', 'form post request');
  reply = { status: 429, body: '<html>slow down</html>' };
  await rejects(http.json('https://x.test/'), TranslateError, 'HTTP 429 <html>', '429 is a TranslateError');
  reply = { status: 503, body: 'down' };
  await rejects(http.json('https://x.test/'), TransientError, 'HTTP 503 down', '503 is transient');
  reply = { status: 408, body: '' };
  await rejects(http.json('https://x.test/'), TransientError, 'HTTP 408', '408 is transient');
  reply = { status: 404, body: 'x'.repeat(500) };
  try { await http.json('https://x.test/'); } catch (e) { eq(e.message.length, 'HTTP 404 '.length + 200, 'error snippet is 200 characters'); }
  reply = { status: 200, body: '<html>captcha' };
  await rejects(http.json('https://x.test/'), TranslateError, 'JSON이 아닌 응답', 'not JSON');
  reply = () => { throw 'error sending request for url'; };
  await rejects(http.json('https://x.test/'), TransientError, '연결 실패', 'network error is transient');
  reply = () => { throw Object.assign(new Error('operation timed out'), {}); };
  await rejects(http.json('https://x.test/'), TransientError, '응답 시간 초과', 'timeout');
  // the transport never answers: the wrapper gives up itself
  const slow = makeHttp(() => new Promise(() => {}), { timerSlack: 0 });
  await rejects(slow.json('https://x.test/', null, null, 0.05), TransientError, '응답 시간 초과', 'a transport that hangs');
  // localhost is connected as 127.0.0.1; if that fails the name is used (and remembered)
  seen.length = 0;
  reply = req => { if (req.url.includes('127.0.0.1')) throw 'connection refused'; return { status: 200, body: '{}' }; };
  await http.json('http://localhost:1234/v1/x', {}, null, 5);
  eq(seen.map(s => s.url), ['http://127.0.0.1:1234/v1/x', 'http://localhost:1234/v1/x'], 'localhost: IPv4 first, then the name');
  seen.length = 0;
  await http.json('http://localhost:1234/v1/x', {}, null, 5);
  eq(seen.map(s => s.url), ['http://localhost:1234/v1/x'], 'localhost: remembered per port');
  seen.length = 0; reply = { status: 200, body: '{}' };
  await http.json('http://localhost:9/v1/x', {}, null, 5);
  eq(seen.map(s => s.url), ['http://127.0.0.1:9/v1/x'], 'localhost: other port starts with IPv4');
}

eq([openaiBase('localhost:1234'), openaiBase('http://h:1/v1/'), openaiBase('http://h/chat/completions')], ['http://localhost:1234/v1', 'http://h:1/v1', 'http://h/v1'], 'openaiBase');
eq([cleanLlmOutput('<THINK>a</think> hi '), cleanLlmOutput('  <think>unfinished'), cleanLlmOutput('x<think>a\nb</think>y')], ['hi', '', 'xy'], 'cleanLlmOutput');

// ---- TranslationService
function rig(over = {}, cfg = {}) {
  const results = [], timers = [], calls = [];
  let behave = async () => 'T';
  const translator = { translate: async (c, text) => { calls.push(text); return behave(c, text); } };
  const files = memoryFiles({ 'Glossary.txt': 'LFM = 구인\n' });
  const svc = new TranslationService({
    translator, glossary: new Glossary(files, { now: () => 0 }), getCfg: () => ({ translator: 'google', target_lang: '한국어', max_pending: 20, ...cfg }),
    onResult: (token, result, err) => results.push([token, result, err]), schedule: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, cancel: () => {}, random: () => 0, ...over,
  });
  return { svc, results, timers, calls, set: f => { behave = f; } };
}
const tick = () => new Promise(r => setTimeout(r, 0));

{ // memory: new -> short -> long
  const R = rig(); R.set(async (c, t) => 'X:' + t);
  R.svc.submit(1, 'hi'); await tick();
  R.svc.submit(2, 'hi');                               // from the short memory (promoted)
  R.svc.submit(3, 'hi');                               // from the long memory
  eq(R.calls, ['hi'], 'only one request for the same line');
  eq(R.results, [[1, 'X:hi', null], [2, 'X:hi', null], [3, 'X:hi', null]], 'three answers');
  eq([R.svc.short.size, R.svc.long.size, R.svc.pending], [0, 1, 0], 'promoted to the long memory, nothing pending');
}
{ // identical lines share the request in flight
  const R = rig(); const gates = []; R.set(() => new Promise(r => gates.push(() => r('Y'))));
  R.svc.submit(1, 'same'); await R.svc.submit(2, 'same'); await R.svc.submit(3, 'other');
  check(R.svc.pending === 2, 'two requests pending');
  gates.forEach(g => g()); await tick(); await tick();
  eq(R.calls.length, 2, 'the shared line was requested once');
  eq(R.results.filter(r => r[1] === 'Y').map(r => r[0]).sort(), [1, 2, 3], 'all three tokens answered');
}
{ // the queue limit
  const R = rig({}, { max_pending: 2 }); R.set(() => new Promise(() => {}));
  eq([await R.svc.submit(1, 'a'), await R.svc.submit(2, 'b'), await R.svc.submit(3, 'c')], [true, true, false], 'third line is refused at max_pending 2');
}
{ // only `workers` requests at a time
  const R = rig({ workers: 2 }); let running = 0, peak = 0; const gates = [];
  R.set(() => new Promise(r => { running++; peak = Math.max(peak, running); gates.push(() => { running--; r('ok'); }); }));
  for (let i = 0; i < 5; i++) await R.svc.submit(i, 'line' + i);
  await tick(); check(running === 2, 'two running, three waiting');
  while (R.results.length < 5) { gates.shift()?.(); await tick(); }
  eq(peak, 2, 'never more than two at once');
}
{ // a translation equal to the original adds nothing
  const R = rig(); R.set(async (c, t) => ' ' + t.toUpperCase() + ' ');
  R.svc.submit(1, 'LFM'); await tick();
  eq(R.results, [[1, null, null]], 'same as the original -> null');
}
{ // ... except when "skip lines already in the target language" is off: then the user wants to see the answer
  const R = rig({}, { skip_same_lang: false }); R.set(async (c, t) => t);
  R.svc.submit(1, '안녕하세요'); await tick();
  eq(R.results, [[1, '안녕하세요', null]], 'skip off: an answer equal to the original is shown');
}
{ // the route is part of the key
  const R = rig(); R.set(async (c, t) => c.translator + ':' + t);
  R.svc.submit(1, 'x'); await tick(); await R.svc.submit(2, 'x', 'openai'); await tick();
  eq(R.results.map(r => r[1]), ['google:x', 'openai:x'], 'another route is another request');
}
{ // a glossary change means no stale answer
  const files = memoryFiles({ 'Glossary.txt': 'LFM = 구인\n' }); let t = 0;
  const R = rig({ glossary: new Glossary(files, { now: () => t, recheckMs: 0 }) }, { glossary_mode: 'list' }); R.set(async (c, x) => 'v' + R.calls.length);
  R.svc.submit(1, 'LFM'); await tick(); await files.write('Glossary.txt', 'LFM = 파티\n'); await R.svc.glossary.refreshKeys({ glossary_mode: 'list' }); R.svc.submit(2, 'LFM'); await tick(); await tick();
  eq(R.calls.length, 2, 'glossary changed: asked again');
}
{ // rate limit: the line waits and is retried
  const R = rig(); let n = 0;
  R.set(async () => { if (n++ < 1) throw new RateLimited('slow', 30); return 'late'; });
  R.svc.submit(1, 'a'); await tick();
  eq([R.results.length, R.timers.length, R.svc.pending], [0, 1, 1], 'waiting for the retry, still pending');
  check(R.timers[0].ms >= 30500, 'retry after the pause + jitter');
  R.timers[0].fn(); await tick();
  eq(R.results, [[1, 'late', null]], 'delivered after the retry'); eq(R.svc.pending, 0, 'no longer pending');
}
{ // rate limit that never ends: gives up after MAX_RETRIES; a pause that is too long is shown at once
  const R = rig(); R.set(async () => { throw new RateLimited('limit', 10); });
  R.svc.submit(1, 'a'); await tick();
  for (let i = 0; i < 3; i++) { R.timers.shift().fn(); await tick(); }
  eq(R.results, [[1, null, 'limit']], 'error after 3 retries'); eq(R.svc.pending, 0, 'pending cleared');
  const R2 = rig(); R2.set(async () => { throw new RateLimited('too long', 900); });
  R2.svc.submit(1, 'a'); await tick();
  eq([R2.results, R2.timers.length], [[[1, null, 'too long']], 0], 'a pause over 150 s is not waited for');
}
{ // transient error: one more try, then the error
  const R = rig(); let n = 0; R.set(async () => { if (n++ < 1) throw new TransientError('blip'); return 'fine'; });
  R.svc.submit(1, 'a'); await tick(); R.timers[0].fn(); await tick();
  eq(R.results, [[1, 'fine', null]], 'second try works');
  const R2 = rig(); R2.set(async () => { throw new TransientError('down'); });
  R2.svc.submit(1, 'a'); await tick(); R2.timers.shift().fn(); await tick();
  eq([R2.results, R2.timers.length, R2.svc.pending], [[[1, null, 'down']], 0, 0], 'two failures show the error');
}
{ // anything else is shown at once; an error is never cached
  const R = rig(); R.set(async () => { throw new TranslateError('HTTP 401 no'); });
  R.svc.submit(1, 'a'); await tick(); R.set(async () => 'now fine'); await R.svc.submit(2, 'a'); await tick();
  eq(R.results, [[1, null, 'HTTP 401 no'], [2, 'now fine', null]], 'an error is not remembered');
  const R2 = rig(); R2.set(async () => { throw new TypeError('boom'); });
  R2.svc.submit(1, 'a'); await tick();
  eq(R2.results, [[1, null, 'boom']], 'unexpected errors are reported too');
}
{ // shutdown cancels waiting retries
  let cancelled = 0; const R = rig({ cancel: () => cancelled++ }); R.set(async () => { throw new RateLimited('x', 5); });
  R.svc.submit(1, 'a'); await tick(); R.svc.shutdown(); eq(cancelled, 1, 'shutdown cancels timers');
}
