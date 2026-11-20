// The watchdog of the plugin pages (app/core/watchdog.js)
import { Watchdog } from '../app/core/watchdog.js';
import { eq } from './helpers.mjs';

{
  const w = new Watchdog({ timeoutMs: 20_000, maxRestarts: 2, windowMs: 100_000 });
  w.start('a', 0);
  eq(w.check('a', 19_000), 'ok', 'watchdog: a page that was heard lately is fine');
  w.pong('a', 19_000);
  eq(w.check('a', 38_000), 'ok', 'watchdog: an answer starts the time again');
  eq(w.check('a', 40_000), 'restart', 'watchdog: no answer for too long: restart');
  eq(w.check('a', 41_000), 'ok', 'watchdog: after the restart it is not looked at until it is started again (nothing to decide)');
  w.start('a', 41_000); eq(w.check('a', 70_000), 'restart', 'watchdog: silent again: the second restart');
  w.start('a', 70_000); eq(w.check('a', 95_000), 'stop', 'watchdog: too many restarts in a short time: stop');
  w.start('a', 300_000); eq(w.check('a', 330_000), 'restart', 'watchdog: much later the count is clear again');
  eq(w.check('nobody', 1e9), 'ok', 'watchdog: a plugin that is not known is nothing to decide');
  w.start('b', 0); w.forget('b'); eq(w.check('b', 1e9), 'ok', 'watchdog: a plugin that was stopped is forgotten');
}
