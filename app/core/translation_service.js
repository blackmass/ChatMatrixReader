// The translation queue: submit() never blocks; the answer comes through onResult(token, result, error).
//   result null with no error = "nothing to add" (the translation equals the original).
// Two memories (short: the last 500 different lines; long: lines that came up again while still in the short one), identical lines
// that arrive while one is being translated share its answer, at most `max_pending` lines wait at once, a rate limit puts the line
// aside and retries it later, a transient error gets one more try. Port of TranslationService in translator.py.
import { log } from './log.js';
import { RateLimited, TransientError, applyRoute } from './translate_rules.js';
import { googleKey, customSignature } from './translate.js';

const short = (text, n = 80) => (text || '').replace(/\n/g, ' ').slice(0, n);

export class TranslationService {
  static SHORT_MAX = 500;          // short-term memory: distinct recent lines
  static LONG_MAX = 100;           // long-term memory
  static MAX_RETRIES = 3;          // after a rate limit: how often one line is retried
  static MAX_WAIT = 150;           // ... and the longest pause worth waiting for (seconds); longer -> show the error
  static SOFT_RETRY_DELAY = 3.0;   // seconds before the one extra try after a transient error

  // translator: Translator; glossary: Glossary (for the cache key); getCfg(): the current settings
  constructor({ translator, glossary, getCfg, onResult, workers = 2, now = () => performance.now() / 1000,
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = h => clearTimeout(h), random = Math.random }) {
    Object.assign(this, { translator, glossary, getCfg, onResult, workers, now, schedule, cancel, random });
    this.short = new Map();        // key -> result (insertion order = age)
    this.long = new Map();
    this.inflight = new Map();     // key -> tokens of identical lines that arrived while it is being translated
    this.pending = 0;
    this.active = 0; this.queue = [];
    this.timers = new Set();
    this.hits = { long: 0, short: 0, wait: 0, new: 0 };
    this.hitsLog = now();
  }

  count(kind) {
    this.hits[kind]++;
    const t = this.now();
    if (t - this.hitsLog >= 60) {
      const h = this.hits; this.hitsLog = t; this.hits = { long: 0, short: 0, wait: 0, new: 0 };
      const total = h.long + h.short + h.wait + h.new;
      log.info(`번역 캐시 1분: 새 요청 ${h.new} | 장기기억 ${h.long} | 단기기억 ${h.short} | 진행중 합류 ${h.wait} (재사용 ${Math.floor(100 * (total - h.new) / Math.max(total, 1))}%) | 기억 단기 ${this.short.size}/장기 ${this.long.size}`);
    }
  }

  // at most `workers` requests run at the same time
  async limited(fn) {
    if (this.active >= this.workers) await new Promise(r => this.queue.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; this.queue.shift()?.(); }
  }

  // true = taken (or answered from memory), false = too many lines waiting. Decides at once (the pipeline needs the answer to its line);
  // the glossary files are looked at again in the background, so an edited glossary is noticed from the next line on.
  submit(token, text, route = null) {
    const cfg = applyRoute({ ...this.getCfg() }, route);          // snapshot: later option changes don't affect this request
    this.glossary.refreshKeys(cfg).catch(() => {});
    const key = JSON.stringify([cfg.translator, !!googleKey(cfg), cfg.skip_same_lang ?? true, cfg.target_lang, cfg.api_model, cfg.prompt ?? null,
      (cfg.extra_prompt || '').trim(), this.glossary.cacheKeySync(cfg), customSignature(cfg), text]);
    if (this.long.has(key)) {                                      // long-term first
      const v = this.long.get(key); this.long.delete(key); this.long.set(key, v);
      this.count('long');
      log.info(`캐시 재사용 [장기기억] | ${short(text, 50)}`);
      this.onResult(token, v, null);
      return true;
    }
    if (this.short.has(key)) {                                     // seen twice -> worth keeping longer
      const v = this.short.get(key); this.short.delete(key);
      this.long.set(key, v);
      while (this.long.size > TranslationService.LONG_MAX) this.long.delete(this.long.keys().next().value);
      this.count('short');
      log.info(`캐시 재사용 [단기기억 -> 장기기억으로 승격] | ${short(text, 50)}`);
      this.onResult(token, v, null);
      return true;
    }
    if (this.inflight.has(key)) {                                  // the same line is being translated right now: share its answer
      this.inflight.get(key).push(token);
      this.count('wait');
      log.info(`캐시 재사용 [같은 문장 번역 중, 결과 공유] | ${short(text, 50)}`);
      return true;
    }
    if (this.pending >= Math.trunc(Number(cfg.max_pending ?? 20))) return false;
    this.pending++;
    this.inflight.set(key, []);
    this.count('new');
    this.run(token, text, cfg, key);
    return true;
  }

  later(fn, seconds) {
    const h = this.schedule(() => { this.timers.delete(h); fn(); }, seconds * 1000);
    this.timers.add(h);
  }

  async run(token, text, cfg, key, attempt = 0, soft = 0) {
    let retry = false;
    try {
      const result0 = await this.limited(() => this.translator.translate(cfg, text));
      // an answer equal to the original says nothing new: no translation line - unless the user turned "skip lines already in the target language"
      // off (then they want to see what comes back, e.g. to test Korean -> Korean)
      const result = (cfg.skip_same_lang ?? true) && result0.trim().toLowerCase() === text.trim().toLowerCase() ? null : result0;
      if (result === null) log.info(`번역 결과가 원문과 같아 번역줄을 숨김 | ${short(text, 50)}`);
      this.short.set(key, result);
      while (this.short.size > TranslationService.SHORT_MAX) this.short.delete(this.short.keys().next().value);
      this.deliver(key, token, result, null);
    } catch (e) {
      const S = TranslationService;
      if (e instanceof RateLimited) {                              // keep the line waiting instead of failing it
        if (attempt < S.MAX_RETRIES && e.delay <= S.MAX_WAIT) {
          retry = true;
          const delay = e.delay + 0.5 + this.random() * (2.5 + 0.3 * this.pending);     // spread the retries out
          log.info(`제한 해제 대기 후 다시 시도 (${attempt + 1}/${S.MAX_RETRIES}, ${Math.round(delay)}초 뒤): ${short(text, 40)}`);
          this.later(() => this.run(token, text, cfg, key, attempt + 1, soft), delay);
        } else this.deliver(key, token, null, String(e.message));
      } else if (e instanceof TransientError) {                    // a hiccup: one more try after a short pause, then show the error
        if (soft < 1) {
          retry = true;
          const delay = S.SOFT_RETRY_DELAY + this.random();
          log.info(`일시적 오류, ${delay.toFixed(1)}초 뒤 한 번 더 시도: ${short(text, 40)} | ${(String(e.message) || '').slice(0, 80)}`);
          this.later(() => this.run(token, text, cfg, key, attempt, soft + 1), delay);
        } else this.deliver(key, token, null, String(e.message));
      } else this.deliver(key, token, null, String(e?.message) || e?.name || 'Error');     // TranslateError or anything unexpected
    } finally {
      if (!retry) this.pending--;
    }
  }

  // hand the outcome to the line that started the request and to identical lines that waited for it
  deliver(key, token, result, err) {
    const waiting = this.inflight.get(key) || [];
    this.inflight.delete(key);
    for (const t of [token, ...waiting]) this.onResult(t, result, err);
  }

  shutdown() { for (const h of this.timers) this.cancel(h); this.timers.clear(); this.queue.length = 0; }
}
