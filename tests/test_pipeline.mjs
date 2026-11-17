// pipeline.js against the events the 2.0 Python pipeline produced for the same lines (tests/golden/pipeline.json)
import fs from 'node:fs';
import path from 'node:path';
import { Pipeline } from '../app/core/pipeline.js';
import { log } from '../app/core/log.js';
import { HERE, check, eq, canon } from './helpers.mjs';

log.quiet = true;
const G = JSON.parse(fs.readFileSync(path.join(HERE, 'golden', 'pipeline.json'), 'utf8').replace(/음성 인식이 종료되었습니다 \(코드/g, '음성 인식이 예상과 달리 종료되었습니다 (코드').replace(/자세한 내용: [^"]*chatmatrix_stt\.log/g, '자세한 내용: logs/chatmatrix.log'));       // (3.0 words: an engine that ends by itself; the log of 3.0)
const clock = () => '12:00:00';

class FakeService {
  constructor() { this.sent = []; this.ok = true; }
  submit(token, text, route = null) { if (this.ok) this.sent.push([token, text, route]); return this.ok; }
}

for (const run of G.runs) {
  const svc = new FakeService();
  const p = new Pipeline({ getCfg: () => run.cfg, translations: svc, getWindows: () => run.windows, clock });
  const got = [];
  for (const [ch, id, who, text, cls, base] of run.steps) {
    const evs = p.onLine({ channel: ch, id, sender: who, text, cls, base });
    got.push(evs);
    for (const e of evs) {
      if (e.type === 'LineAdded' && e.pending) {
        const sent = svc.sent.at(-1)[1], n = e.line.id;
        got.push(p.onTranslation(n, n % 11 === 0 ? null : '번역: ' + sent, n % 7 === 0 ? 'boom' : null));
      }
    }
  }
  let bad = 0;
  check(got.length === run.events.length, `${run.name}: ${got.length} event groups, want ${run.events.length}`);
  for (let i = 0; i < Math.min(got.length, run.events.length); i++) {
    if (canon(got[i]) !== canon(run.events[i]) && bad++ < 3) eq(got[i], run.events[i], `${run.name} group ${i}`);
    else if (!bad) check(true, '');
  }
  check(canon(svc.sent) === canon(run.sent), run.name + ' requests sent to the translator');
  console.log(`  ${run.name}: ${got.length} groups, ${bad} differ`);
}

{
  const p = new Pipeline({ getCfg: () => G.runs[0].cfg, translations: new FakeService(), getWindows: () => [], clock });
  const pieces = [['S', 1, 'A', 'first part \x05'], ['S', 2, 'A', '\x05second part'], ['S', 3, 'B', 'x\x05']].map(([channel, id, sender, text]) => ({ channel, id, sender, text, cls: '', base: -1 }));
  const evs = [...p.onLines(pieces, 10.0), ...p.tick(10.5), ...p.tick(12.0)];
  check(canon(evs) === canon(G.joined), 'long messages through onLines/tick');
  const vev = G.voice_in.map(m => p.onVoice(m));
  check(canon(vev) === canon(G.voice), 'voice messages');
  const stopped = p.onVoice({ type: 'exit', code: 0, expected: true }), crashed = p.onVoice({ type: 'exit', code: 3 });
  check(stopped.every(e => e.type !== 'Notice') && crashed.some(e => e.type === 'Notice' && e.text.includes('코드 3') && e.text.includes('logs/chatmatrix.log')), 'an engine that was stopped on purpose ends without a notice; one that ended by itself says so, with the code and the log');
}

// an answer from the cache arrives INSIDE submit(): the window must hear "LineAdded" first, then "Translated"
{
  let p;
  const svc = { submit(token) { published.push(...p.onTranslation(token, '캐시 번역', null)); return true; } };
  const published = [];
  p = new Pipeline({ getCfg: () => G.runs[0].cfg, translations: svc, getWindows: () => [], clock });
  const evs = p.onLine({ channel: 'S', id: 77, sender: 'A', text: 'hello there friend', cls: '', base: -1 });
  const kinds = evs.map(e => e.type);
  check(kinds[0] === 'LineAdded' && kinds.includes('Translated') && published.length === 0, 'a cached translation comes after its line: ' + kinds.join());
}
