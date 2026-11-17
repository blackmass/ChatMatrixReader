// the "…" line under an original that waits for its translation
import { ChatModel } from '../app/core/chatmodel.js';
import { piece } from '../app/core/pipeline.js';
import { check, eq } from './helpers.mjs';
const line = id => ({ id, code: 'P', style: 'P', pieces: [piece('hello')], plain: 'hello', plain_original: 'hello', both: false, per_line: false, base: -1, local: [] });
const txt = m => m.blocks.map(b => b.pieces.map(p => p.text).join(''));
{
  const m = new ChatModel();
  m.addLine(line(1), [piece('[A]: ')], true, false, true);
  eq(txt(m), ['[A]: hello', '…'], 'a line that waits: the original and a "…" under it');
  const ops = m.addTranslation({ id: 1, pieces: [piece('안녕')], error: null });
  eq(txt(m), ['[A]: hello', '안녕'], 'the translation takes the place of the "…"');
  check(ops.length === 1 && ops[0][0] === 'replace', 'one replace, nothing inserted');
}
{
  const m = new ChatModel();
  m.addLine(line(1), [piece('[A]: ')], true, false, true);
  m.addTranslation({ id: 1, pieces: [], error: null });
  eq(txt(m), ['[A]: hello'], 'no translation: the "…" goes');
}
{
  const m = new ChatModel();
  m.addLine(line(1), [piece('[A]: ')], true, false, true);
  m.addTranslation({ id: 1, pieces: [], error: 'boom', show_error: true });
  eq(txt(m), ['[A]: hello', '⚠ boom'], 'an error: the "…" goes, the error shows');
}
{
  const m = new ChatModel();
  m.addLine(line(1), [piece('[A]: ')], true, false, false);
  eq(txt(m), ['[A]: hello'], 'the mark is off: nothing is added');
  m.addLine(line(2), [piece('[B]: ')], false, false, true);
  eq(txt(m), ['[A]: hello', '[B]: hello'], 'a line without a translation coming gets no mark');
}
