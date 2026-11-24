// What the program keeps an eye on while it runs (no screen): did a setting change that needs a new connection check or a warm-up,
// was the glossary saved, is the matrix missing. Each `check` is called once in a while and says what to do; the program does it.
//   conn = new ConnWatch(cfg);   modes = conn.check(cfg)              the translation methods whose server / key changed (one check each)
//   warm = new WarmWatch(g, cfg); await warm.check(cfg, connSent)     true: send the tiny request once (the prompt / glossary changed)
//   gloss = new GlossWatch(g, cfg); n = await gloss.check(cfg)        the number of entries when the glossary file was saved (null = nothing to say)
//   lost = new LostHint();       text = lost.check(cfg, game, connected, now)   the hint to show when the matrix is not being read
// Every check waits one more round before it acts: a file or a setting may still be being written when it is first seen to differ.
// Port of upkeep.py. Keys are compared as JSON text (the Python tuples).
import { modesInUse, onlySendingUses, withMethod, glossaryFiles } from './translate_rules.js';
import { googleKey, sendCfg } from './translate.js';

export const LOST_AFTER = 5.0;           // seconds without a matrix before the hint shows (first start: at once)
const J = JSON.stringify;
const truthy = v => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length));

// the AI translation method to keep warm: the translation section's, or - when that is something else - "openai" if a channel or the
// sending uses it. null = no AI in use.
export function aiMode(cfg) {
  const mode = cfg.translator ?? 'none';
  if (mode === 'openai' || (mode === 'custom' && (cfg.custom_body || '').includes('{system}'))) return mode;
  if (modesInUse(cfg).has('openai')) return 'openai';
  return null;
}

// the settings that decide which server answers for one translation method
export function modeKey(cfg, mode) {
  if (mode === 'openai') return [mode, cfg.api_url ?? null, cfg.api_model ?? null, cfg.api_key ?? null];
  if (mode === 'google') return [mode, googleKey(cfg)];
  if (mode === 'custom') return [mode, cfg.custom_url ?? null, cfg.custom_key ?? null, cfg.custom_headers ?? null, cfg.custom_body ?? null];
  return [mode];
}

// { method: its server settings }: the section's method, and "openai" when a channel or the sending uses it
export function connKey(cfg) {
  const mode = cfg.translator ?? 'none';
  const out = { [mode]: modeKey(cfg, mode) };
  if (modesInUse(cfg).has('openai')) out.openai = modeKey(cfg, 'openai');
  return out;
}

// what the AI server has to read again when it changes: the prompt, the glossary file, the model / server. null = nothing to warm up
export async function warmKey(glossary, cfg) {
  const mode = aiMode(cfg);
  let extra;
  if (mode === 'openai') extra = [cfg.api_url ?? null, cfg.api_model ?? null];
  else if (mode === 'custom') extra = [cfg.custom_url ?? null, cfg.custom_body ?? null];
  else return null;
  if (onlySendingUses(cfg, mode)) {                           // only the sending uses it: its prompt is the one to warm up
    const c2 = sendCfg(cfg);
    return J([mode, 'send', c2.prompt ?? null, (c2.extra_prompt || '').trim(), extra]);
  }
  const c = withMethod({ ...cfg, translator: mode });          // (what the method has of its own: its prompt and glossary)
  return J([mode, c.prompt ?? null, (c.extra_prompt || '').trim(), await glossary.cacheKey(c), extra]);
}

export class ConnWatch {
  constructor(cfg = null) { this.last = cfg !== null ? J(connKey(cfg)) : null; this.lastObj = cfg !== null ? connKey(cfg) : null; this.pending = null; }

  // at start: the methods to test (when the option is on): the section's, and OpenAI when channels / sending use it. Once each.
  startModes(cfg) {
    if (!(cfg.translate_test_start ?? true)) return [];
    return Object.keys(connKey(cfg)).filter(m => m !== 'none');
  }

  check(cfg) {
    const obj = connKey(cfg), key = J(obj);
    if (key === this.last) { this.pending = null; return []; }
    if (this.pending !== key) { this.pending = key; return []; }          // wait one round: the options may still be being saved
    const old = this.lastObj || {};
    this.last = key; this.lastObj = obj; this.pending = null;
    if (!(cfg.translate_test_start ?? true)) return [];
    return Object.keys(obj).filter(m => m !== 'none' && J(old[m] ?? null) !== J(obj[m]));
  }
}

export class WarmWatch {
  constructor(glossary, cfg = null) { this.glossary = glossary; this.last = null; this.pending = null; this.ready = cfg !== null ? warmKey(glossary, cfg).then(k => { this.last = k; }) : Promise.resolve(); }

  async check(cfg, connSent = false) {
    await this.ready;
    const key = await warmKey(this.glossary, cfg);
    if (connSent || key === null || !(cfg.translate_test_start ?? true)) { this.last = key; this.pending = null; return false; }   // (a connection check carried the prompt too)
    if (key === this.last) { this.pending = null; return false; }
    if (this.pending === key) { this.last = key; this.pending = null; return true; }       // unchanged for a whole round: the file is saved completely
    this.pending = key;
    return false;
  }
}

export class GlossWatch {
  constructor(glossary, cfg = null) { this.glossary = glossary; this.last = null; this.pending = null; this.ready = cfg !== null ? this.sig(cfg).then(s => { this.last = s; }) : Promise.resolve(); }
  // the files of every glossary in use, as one text (the shared one and the ones of the methods: one name = what its file says)
  async sig(cfg) { return (await Promise.all(glossaryFiles(cfg).map(n => this.glossary.signature(n)))).join('|'); }

  // -> the number of entries when the file was saved (and a translation method is on), else null
  async check(cfg) {
    await this.ready;
    const sig = await this.sig(cfg);
    const none = (cfg.translator ?? 'none') === 'none';
    if (sig === this.last || none) { this.pending = null; if (none) this.last = sig; return null; }
    if (this.pending !== sig) { this.pending = sig; return null; }
    this.last = sig; this.pending = null;
    let n = 0; for (const name of glossaryFiles(cfg)) n += (await this.glossary.entries(name, true)).length;
    return n;
  }
}

// The matrix is not being read: say what to do.
//   no position was ever found (first start): at once, the game running or not (the first-start guide: install the addon, look for the box, lower the colour levels)
//   a position is known: only while the game runs, and after a few seconds (a loading screen or a reload ends by itself); with no game there is nothing to say
//   (the program is often started before the game), and a hint that was shown goes when the game is closed.
// Gone again as soon as the matrix is read.
export class LostHint {
  constructor() { this.since = null; this.shown = false; }

  // -> ['show', first] when the hint is to be shown now, ['hide', false] when it is to go, else null
  check(cfg, game, connected, now) {
    if (connected) {
      this.since = null;
      if (this.shown) { this.shown = false; return ['hide', false]; }
      return null;
    }
    const first = !truthy(cfg.last_pos), noGame = game === null || game === undefined;
    if (this.shown) {
      if (noGame && !first) { this.shown = false; this.since = null; return ['hide', false]; }
      return null;
    }
    if (noGame) {
      this.since = null;
      if (first) { this.shown = true; return ['show', true]; }
      return null;
    }
    if (this.since === null) this.since = now;
    if (first || now - this.since >= LOST_AFTER) { this.shown = true; return ['show', first]; }
    return null;
  }
}
