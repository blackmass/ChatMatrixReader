// A tiny event bus: the core says what happened ('line:added', 'translation:done' ...), the screen code and the plugins
// (docs/PLUGINS.md) listen. A listener that throws never disturbs the others or the sender. Names are 'area:action'.
import { log } from './log.js';

export class Events {
  constructor() { this.handlers = new Map(); }

  // returns a function that removes the listener again
  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
    return () => this.off(name, fn);
  }
  once(name, fn) { const off = this.on(name, (...a) => { off(); fn(...a); }); return off; }
  off(name, fn) { this.handlers.get(name)?.delete(fn); }

  emit(name, data) {
    for (const fn of [...(this.handlers.get(name) || [])]) {
      try { fn(data); } catch (e) { log.error(`listener of '${name}' failed: ${e?.message || e}`); }
    }
  }
}
