// "Quit with the game": the program ends GRACE_SEC seconds after the game window was gone (it must have been seen once since the program
// started: starting the program before the game does not end it). Call tick() about once a second. Returns 'quit' when it is time.
import { T } from './timings.js';
export const GRACE_SEC = 5;                // (the default: the value in use is T.GRACE_SEC)

export class ExitWatch {
  constructor() { this.seen = false; this.goneSince = null; }
  tick(nowSec, enabled, gameFound) {
    if (gameFound) { this.seen = true; this.goneSince = null; return ''; }
    if (!enabled || !this.seen) { this.goneSince = null; return ''; }
    if (this.goneSince === null) this.goneSince = nowSec;
    return nowSec - this.goneSince >= T.GRACE_SEC ? 'quit' : '';
  }
}
