// The ledger: the messages of the chat window in the order they came, as the addon gives them (a message it cannot read is "[restricted]": R; a readable one: A), and the matching of
// the bars on the screen (red R, green G, from the top to the bottom) with the end of it.

// lines that are not messages of the chat window: the messages of the program itself and the control lines
export const NOT_CHAT = new Set(['@RS', '@CS', '@RT', '!VC', '!OCR', '!PLG']);

export class Ledger {
  constructor(max = 400) { this.max = max; this.list = []; this.n = 0; }
  // a line of the pipeline (before anything is done with it) -> its entry, or null when it is no message of the chat window
  add(line, now) {
    const ch = String(line.channel ?? '');
    if (NOT_CHAT.has(ch) || ch.startsWith('@')) return null;
    const text = String(line.text ?? '');
    const e = { seq: ++this.n, id: line.id, kind: text === '[restricted]' ? 'R' : 'A', channel: ch, text, t: now };
    this.list.push(e);
    if (this.list.length > this.max) this.list.shift();
    return e;
  }
}

// screen: [{ kind: 'R' | 'G' }] from the top to the bottom; ledger: entries, the oldest first
// The newest messages are at the bottom on both sides. The picture may be a moment ahead (a message is drawn that the ledger has not got yet: `ahead` bottom bars wait) or behind
// (the ledger has a message that is not drawn yet: `behind` newest entries wait). Between, a bar that is no entry (a readable message that the ledger has not: another addon wrote it,
// or its channel is not shown here) and an entry that is no bar (a message of another chat window) are skipped, up to `maxSkip`.
// -> { ok, ahead, behind, pairs: [{ si (index in screen), entry }], skipped } the pairs for the bars that have an entry
export function matchTail(screen, ledger, maxSkip = 6) {
  let best = null;
  for (let ahead = 0; ahead <= 2; ahead++) {
    for (let behind = 0; behind <= 2; behind++) {
      const t = alignFrom(screen, ledger, ahead, behind, maxSkip);
      if (!t) continue;
      t.cost = t.skipped + ahead + behind;                                // (the fewest things that do not fit is the best: a bar that waits counts as one, like a skipped one)
      if (!best || t.cost < best.cost) best = t;
    }
  }
  return best || { ok: false, ahead: 0, behind: 0, pairs: [], skipped: 0, cost: 0 };
}

function alignFrom(screen, ledger, ahead, behind, maxSkip) {
  let i = screen.length - 1 - ahead, j = ledger.length - 1 - behind, skipped = 0;
  if (i < 0 && ahead) return null;
  const pairs = [];
  while (i >= 0 && j >= 0) {
    const s = screen[i].kind === 'R' ? 'R' : 'A', l = ledger[j].kind;
    if (s === l) { pairs.push({ si: i, entry: ledger[j] }); i--; j--; continue; }
    if (s === 'A') { skipped++; i--; }                                   // a readable message on the screen that the ledger has not
    else { skipped++; j--; }                                             // an entry that is not on the screen (R on the screen, A in the ledger)
    if (skipped > maxSkip) return null;
  }
  // the bars above the last pair are older than the ledger: nothing to pair
  return { ok: true, ahead, behind, pairs: pairs.reverse(), skipped };
}
