// A plugin page that stops answering (an endless loop in a piece of code the user pasted, for example): the program asks "are you there?" now and then ('ping'); the page answers
// ('pong') from its event loop, which a blocked page cannot. No answer for `timeoutMs` = it is started again; if that happens too often it is stopped for good and the user is told.
export const PING_MS = 5000;                 // how often the page is asked
export const TIMEOUT_MS = 20000;             // no answer for so long: unresponsive
export const MAX_RESTARTS = 3;               // this many restarts within RESTART_WINDOW_MS, then it is stopped
export const RESTART_WINDOW_MS = 5 * 60_000;

export class Watchdog {
  constructor({ timeoutMs = TIMEOUT_MS, maxRestarts = MAX_RESTARTS, windowMs = RESTART_WINDOW_MS } = {}) {
    this.timeoutMs = timeoutMs; this.maxRestarts = maxRestarts; this.windowMs = windowMs;
    this.last = new Map();                   // id -> when it was last heard (started counts)
    this.restarts = new Map();               // id -> the times of its restarts
  }
  start(id, now) { this.last.set(id, now); }
  pong(id, now) { if (this.last.has(id)) this.last.set(id, now); }
  forget(id) { this.last.delete(id); }
  // -> 'ok' | 'restart' | 'stop' ('restart' and 'stop' are counted: the caller does it)
  check(id, now) {
    const heard = this.last.get(id);
    if (heard === undefined || now - heard < this.timeoutMs) return 'ok';
    const times = (this.restarts.get(id) || []).filter(t => now - t < this.windowMs);
    if (times.length >= this.maxRestarts) { this.restarts.set(id, times); this.last.delete(id); return 'stop'; }
    times.push(now); this.restarts.set(id, times); this.last.delete(id);
    return 'restart';
  }
}
