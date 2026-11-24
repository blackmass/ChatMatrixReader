// The send box as a row of the window (3.2.1): in a translation window that is a window of the system (center.js `native`) the input line is not a window of its own but the last row of the page, below the
// lines. The same two fields and the same events as the window of the box (input.js): the hub (send_host.js) says 'input-open' / 'input-busy' / 'input-ready' / 'input-close', this reports 'input-submit' and
// 'input-cancel'. `onSize(px)`: the page is told how high the row is (0 when it is closed): the window keeps that much below its text area.
const { emit, listen } = window.__TAURI__.event;
const EMPTY_ENTER_AFTER_MS = 250;                           // an Enter on empty fields closes the box (like the game's chat) only this long after it opened
export const ROW_H = 46;                                    // (css pixels)

export function mountSendRow(onSize = () => {}) {
  const row = document.createElement('div');
  row.id = 'sendrow'; row.hidden = true; row.dataset.notr = '';
  row.innerHTML = '<input id="sr-cmd" class="srfield" autocomplete="off" spellcheck="false" placeholder="/w name"><input id="sr-text" class="srfield" autocomplete="off" spellcheck="false"><span id="sr-lang"></span>';
  document.body.append(row);
  const cmd = row.querySelector('#sr-cmd'), box = row.querySelector('#sr-text'), lang = row.querySelector('#sr-lang');
  let busy = false, openedAt = -1e9;
  const langOf = label => String(label || '').replace(/^\s*→\s*/, '');
  const show = on => { if (row.hidden !== !on) { row.hidden = !on; onSize(on ? ROW_H : 0); } };

  listen('input-open', ev => {
    cmd.value = ''; box.value = ''; busy = false; openedAt = performance.now();
    lang.textContent = langOf(ev.payload.label);
    show(true);
    setTimeout(() => box.focus(), 30);                       // the keyboard starts in the sentence field
  });
  listen('input-busy', () => { busy = true; lang.textContent = '…'; });
  listen('input-ready', ev => { busy = false; lang.textContent = langOf(ev.payload.label); setTimeout(() => box.focus(), 0); });
  listen('input-close', () => { cmd.value = ''; box.value = ''; busy = false; show(false); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });

  for (const field of [cmd, box]) field.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); (field === box ? cmd : box).focus(); return; }
    if (e.repeat) return;                                     // Shift+Enter still held from opening the box
    if (e.isComposing || e.keyCode === 229) return;         // the Korean IME is still composing: this Enter only finishes the letter
    if (e.key === 'Escape') { emit('input-cancel', {}); return; }
    if (e.key !== 'Enter' || busy) return;
    const text = box.value.trim();
    if (text) emit('input-submit', { text, prefix: cmd.value.trim() });
    else if (!cmd.value.trim() && performance.now() - openedAt > EMPTY_ENTER_AFTER_MS) emit('input-cancel', {});
  });
  return { el: row, isOpen: () => !row.hidden };
}
