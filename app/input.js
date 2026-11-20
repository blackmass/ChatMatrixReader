// The send box window: only the input line, two fields. Left: a chat command that is copied as it is ("/w Name Surname", "/p"); right:
// the sentence that is translated; at the end the language it is translated into. What happens around it (the hotkey, the translation,
// the clipboard, giving the keyboard back to the game) is the hub's send box (send_host.js): this page reports Enter and Esc and shows
// what the hub says. Tab moves between the two fields.
const cmd = document.getElementById('cmd');
const box = document.getElementById('text');
const lang = document.getElementById('lang');
let busy = false;
let openedAt = -1e9;                                          // when the box was opened (the Enter that opened it must not close it again)
const EMPTY_ENTER_AFTER_MS = 250;                           // an Enter on empty fields closes the box (like the game's chat) only this long after it opened

const langOf = label => String(label || '').replace(/^\s*→\s*/, '');

listen('input-open', ev => {
  cmd.value = ''; box.value = ''; busy = false; openedAt = performance.now();
  lang.textContent = langOf(ev.payload.label);
  setTimeout(() => box.focus(), 30);                          // the keyboard starts in the sentence field
});
listen('input-busy', () => { busy = true; lang.textContent = '…'; });
listen('input-ready', ev => { busy = false; lang.textContent = langOf(ev.payload.label); setTimeout(() => box.focus(), 0); });
listen('input-close', async () => { cmd.value = ''; box.value = ''; busy = false; await thisWin.hide(); });

for (const field of [cmd, box]) field.addEventListener('keydown', e => {
  if (e.key === 'Tab') { e.preventDefault(); (field === box ? cmd : box).focus(); return; }
  if (e.repeat) return;                                       // Shift+Enter still held from opening the box
  if (e.isComposing || e.keyCode === 229) return;           // the Korean IME is still composing: this Enter only finishes the letter
  if (e.key === 'Escape') { emit('input-cancel', {}); return; }
  if (e.key !== 'Enter' || busy) return;
  const text = box.value.trim();
  if (text) emit('input-submit', { text, prefix: cmd.value.trim() });
  else if (!cmd.value.trim() && performance.now() - openedAt > EMPTY_ENTER_AFTER_MS) emit('input-cancel', {});       // both fields empty: the same as Esc (the game's own chat box is left alone)
});
addEventListener('contextmenu', e => { if (e.target !== box && e.target !== cmd) e.preventDefault(); });
