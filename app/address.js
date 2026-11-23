// The address box of a window of the mini browser (3.2). One small window of the system for all of them: the center draws the address in the bar of a window, and when it is clicked this window comes over
// that place (the exe: address_show) and takes the keyboard, so the center itself never becomes the active window (a window over all the screens that takes the keyboard made the pictures of the other
// screens flicker). Enter goes to the address, Esc or another place clicked puts the box away; the keyboard is not given back (the user clicks the game).
import * as B from './core/browsers.js';

const box = document.getElementById('a');
let label = '', openedAt = -1e9;

listen('address-open', ev => {
  label = String((ev.payload && ev.payload.label) || ''); box.value = String((ev.payload && ev.payload.text) || ''); openedAt = performance.now();
  setTimeout(() => { box.focus(); box.select(); }, 30);
  state(true);
});
// (what was typed is never taken as an address unless Enter finished it: Esc, a click elsewhere, the window lost: the address that was there stays, the page behind shows it again)
const state = open => emit('address-state', { label, open });
const close = async () => { box.value = ''; try { await thisWin.hide(); } catch { /* gone */ } state(false); };

box.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return;                           // (the Korean IME is still composing: this Enter only finishes the letter)
  if (e.key === 'Enter') {
    const url = B.addressFrom(box.value);
    if (url && label) invoke('web_cmd', { label, cmd: 'goto', url }).catch(() => {});
    close();
  } else if (e.key === 'Escape') close();
});
// (the user went to the game or another window; not at once after the box came: the system moves the keyboard into the page a moment later)
addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus() && performance.now() - openedAt > 600) close(); }, 200));
addEventListener('contextmenu', e => { if (e.target !== box) e.preventDefault(); });
