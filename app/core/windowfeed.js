// One window's share of the pipeline events: which of them it shows and how, turned into operations on its ChatModel.
// Port of windowfeed.py. wid = MAIN for the main window, else the id of the extra window.
import { ChatModel } from './chatmodel.js';
import { MAIN, headPieces } from './pipeline.js';
import * as winconf from './winconf.js';

export class WindowFeed {
  constructor(wid, getCfg, getConf = () => null, maxLines = null) {
    this.wid = wid;
    this.getCfg = getCfg;
    this.getConf = getConf;                            // the settings of this window (null for the main window)
    this.model = new ChatModel(maxLines || parseInt(this.opt('max_lines', 500), 10));
  }

  conf() { return this.wid === MAIN ? null : this.getConf(); }
  opt(key, dflt = null) { return winconf.opt(this.conf() || this.getCfg(), this.getCfg(), key, dflt); }

  handle(ev) {
    switch (ev.type) {
      case 'LineAdded': {
        if (!ev.targets.includes(this.wid)) return [];
        const head = headPieces(ev.line, this.conf(), this.getCfg());
        // ("translation above": a line that is waiting for its translation, and also a line that is shown in both names (a link that has an original name: the local name above, the original below), which has no translation to wait for)
        return this.model.addLine(ev.line, head, ev.pending, !!this.opt('swap_trans', false) && (ev.pending || ev.line.both), !!this.opt('pending_mark', true));
      }
      case 'LineUpdated': {                              // (the words of a line that had its place kept: the OCR lines)
        if (!ev.targets.includes(this.wid)) return [];
        const head = headPieces(ev.line, this.conf(), this.getCfg());
        return this.model.updateLine(ev.line, head, ev.pending, !!this.opt('swap_trans', false) && (ev.pending || ev.line.both), !!this.opt('pending_mark', true));
      }
      case 'Translated':
        return ev.targets.includes(this.wid) ? this.model.addTranslation(ev) : [];
      case 'Notice': {
        if (this.wid !== MAIN) return [];                // the notices of the program are in the main window only
        const stamp = ev.stamp && this.opt('show_time', true) ? ev.stamp + ' ' : '';
        if (ev.kind === 'system') return this.model.addNote(ev.text, 'system', ev.tag || null);
        if (ev.kind === 'remove') return this.model.removeNotes(ev.tag);
        if (ev.kind === 'restricted') return this.model.addRestricted(stamp + ev.text, ev.replace);
        if (ev.kind === 'restriction_over') return this.model.addNote(stamp + ev.text, 'restricted');
        return [];
      }
      default: return [];
    }
  }

  clear() { return this.model.clear(); }
  applySettings() { return this.model.setMaxLines(parseInt(this.opt('max_lines', 500), 10)); }
}
