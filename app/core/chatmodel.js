// What one chat window shows, as a list of text blocks. Port of chatmodel.py (see its header).
//
// A block is one paragraph (a chat line, its translation, an error, a notice). The model decides WHICH blocks there are and in
// what order; the window only turns blocks into DOM. Every change comes back as a list of operations the window applies:
//   ['insert', index, block]  ['replace', index, block]  ['delete', index, count]  ['clear']
// After applying them the window holds exactly `model.blocks`. A line and its translation are one GROUP: the first block of a
// group has a gap above it; when the oldest lines go, whole groups go.
import * as chattext from './chattext.js';
import { piece, withGuild } from './pipeline.js';
import * as theme from './theme.js';

export const block = (kind, pieces, style, group, indent, lineId = null) => ({ kind, pieces, style, group, indent, line_id: lineId });
const isTag = (b, tag) => Array.isArray(b.line_id) && b.line_id[0] === 'tag' && b.line_id[1] === tag;

export class ChatModel {
  constructor(maxLines = 500) {
    this.maxLines = maxLines;
    this.blocks = [];
    this.typeColors = {};           // channel code -> the colour the game's chat type has now
    this.swap = new Map();          // id -> [head pieces, original pieces, style]: "translation above" waits for its result
  }

  // the colour of a block (not of its pieces: see theme.pieceColor)
  color(b) {
    const st = b.style;
    if (st.startsWith('bc') && /^\d+$/.test(st.slice(2))) return chattext.QUALITY_COLORS[parseInt(st.slice(2), 10)] || theme.defaultColor('other');
    return this.typeColors[st] || theme.defaultColor(st);
  }

  // the game changed the colour of a chat type: the lines of that type already shown change with it -> operations
  noteColor(line) {
    if (line.per_line) return [];
    const color = theme.typeColor(line.code, line.base);
    if (this.typeColors[line.code] === color) return [];
    const first = !Object.hasOwn(this.typeColors, line.code);
    this.typeColors[line.code] = color;
    if (first) return [];
    const ops = [];
    this.blocks.forEach((b, i) => { if (b.style === line.code) ops.push(['replace', i, b]); });
    return ops;
  }

  static style(line) {
    return line.per_line && Object.hasOwn(chattext.QUALITY_COLORS, line.base) ? `bc${line.base}` : line.style;
  }

  // a chat line. head: the beginning of the line for this window (pipeline.headPieces). pending: a translation follows.
  // swap: "translation above" - the top block waits for the translation, the original is the block below
  // mark: a translation is on its way: a "…" line is put under the original at once, so the text does not jump when the answer comes
  addLine(line, head, pending, swap = false, mark = false) {
    let ops = this.noteColor(line);
    const style = ChatModel.style(line);
    const body = [...line.pieces];
    if (swap && pending) {
      this.swap.set(line.id, [[...head], body, style]);
      ops = ops.concat(this.append(block('line', [...head, piece('…')], style, true, false, line.id)));
      ops = ops.concat(this.append(block('trans', withGuild([piece(line.plain_original)]), 'trans', false, true, line.id)));
    } else if (swap && line.both) {
      ops = ops.concat(this.append(block('line', [...head, ...line.local], style, true, false, line.id)));
      ops = ops.concat(this.append(block('trans', withGuild([piece(line.plain_original)]), 'trans', false, true, line.id)));
    } else {
      ops = ops.concat(this.append(block('line', [...head, ...body], style, true, false, line.id)));
      if (line.both) ops = ops.concat(this.append(block('trans', withGuild([piece(line.plain)]), 'trans', false, true, line.id)));
      else if (pending && mark) { const b = block('trans', [piece('…')], 'trans', false, true, line.id); b.placeholder = true; ops = ops.concat(this.append(b)); }
    }
    return ops.concat(this.trim());
  }

  // a Translated event for this window -> operations
  addTranslation(tr) {
    const swapped = this.swap.get(tr.id);
    this.swap.delete(tr.id);
    let at = this.last(tr.id);
    if (at === null) return [];                       // the line is gone (older than the limit, or the window was cleared)
    let ops = [];
    if (swapped) {
      const [head, orig, style] = swapped;
      const top = this.first(tr.id);
      if (tr.pieces && tr.pieces.length) {            // the translation takes the place of the "…"
        ops = ops.concat(this.replace(top, block('line', [...head, ...tr.pieces], style, true, false, tr.id)));
      } else {                                        // none: the top block shows the original after all, the lower copy goes
        ops = ops.concat(this.replace(top, block('line', [...head, ...orig], style, true, false, tr.id)));
        const lower = this.first(tr.id) + 1;
        if (lower < this.blocks.length && this.blocks[lower].line_id === tr.id && this.blocks[lower].kind === 'trans') ops = ops.concat(this.delete(lower, 1));
      }
      at = this.last(tr.id);
    } else {
      const ph = this.blocks.findIndex(b => b.line_id === tr.id && b.placeholder);
      const has = tr.pieces && tr.pieces.length;
      if (ph >= 0) {                                  // the "…" takes the translation's place, or goes when there is none
        ops = ops.concat(has ? this.replace(ph, block('trans', [...tr.pieces], 'trans', false, true, tr.id)) : this.delete(ph, 1));
      } else if (has) {
        ops = ops.concat(this.insert(at + 1, block('trans', [...tr.pieces], 'trans', false, true, tr.id)));
      }
    }
    if (tr.error && tr.show_error) {
      at = this.last(tr.id);
      ops = ops.concat(this.insert(at + 1, block('error', [piece('⚠ ' + tr.error)], 'error', false, true, tr.id)));
    }
    return ops.concat(this.trim());
  }

  // a line of the program itself. tag: a name, so that removeNotes(tag) can take it away again
  addNote(text, style = 'system', tag = null) {
    return this.append(block('note', [piece(text)], style, true, false, tag ? ['tag', tag] : null)).concat(this.trim());
  }

  removeNotes(tag) {
    let ops = [];
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.kind === 'note' && isTag(b, tag)) ops = ops.concat(this.delete(i, 1));
    }
    return ops;
  }

  // the notice "chat is restricted"; in a run of them one notice with a counter: replace = it takes the place of the last one
  addRestricted(text, replace) {
    const b = block('restricted', [piece(text)], 'restricted', true, false);
    if (replace && this.blocks.length && this.blocks.at(-1).kind === 'restricted') return this.replace(this.blocks.length - 1, b);
    return this.append(b).concat(this.trim());
  }

  clear() { this.blocks = []; this.swap.clear(); return [['clear']]; }
  setMaxLines(n) { this.maxLines = n; return this.trim(); }

  first(id) { const i = this.blocks.findIndex(b => b.line_id === id && b.kind === 'line'); return i < 0 ? null : i; }
  last(id) { for (let i = this.blocks.length - 1; i >= 0; i--) if (this.blocks[i].line_id === id) return i; return null; }
  append(b) { return this.insert(this.blocks.length, b); }
  insert(i, b) { this.blocks.splice(i, 0, b); return [['insert', i, b]]; }
  replace(i, b) { this.blocks[i] = b; return [['replace', i, b]]; }
  delete(i, n) { this.blocks.splice(i, n); return [['delete', i, n]]; }

  // more blocks than the limit: the oldest groups go (a translation line is never left alone at the top)
  trim() {
    let n = 0;
    while (this.blocks.length - n > this.maxLines) n++;
    while (n < this.blocks.length && !this.blocks[n].group) n++;
    if (n >= this.blocks.length) {                    // (everything would go: keep the newest group at least)
      n = Math.max(0, this.blocks.length - 1);
      while (n > 0 && !this.blocks[n].group) n--;
    }
    if (n <= 0) return [];
    for (const b of this.blocks.slice(0, n)) if (this.swap.has(b.line_id) && b.kind === 'line') this.swap.delete(b.line_id);
    return this.delete(0, n);
  }
}
