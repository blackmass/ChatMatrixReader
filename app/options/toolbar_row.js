// The function buttons of the bar of a window (the 창 tab; docs/HANDOFF.md 4-0ah): two lines. The first is what the bar of THIS window has now, in order (the close button is always at the right end
// and is not in the list); the second is what it does not have. A button is dragged to its place on the first line, or out to the second; a click (or Enter) moves it between the lines, and the arrow
// keys on the first line change its place. The setting is `tools` of the window (a list of ids; core/toolbar.js). The dragging is done with the pointer events (the HTML5 drag and drop does not
// work in the web view of Windows while the exe has its own handler for the files that are dropped on a window).
import { tr } from '../core/i18n.js';
import * as toolbar from '../core/toolbar.js';
import * as settings from '../settings.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// -> the row of the tab
export function toolbarRow() {
  return { win: true, key: 'tools', type: 'custom', block: true, label: '', keywords: '기능 버튼 아이콘 막대 새로고침 음성 옵션 캡처 순서 끌기 도구', build: ctx => panel(ctx) };
}

function panel(ctx) {
  const root = el('div', 'tb'), usedBox = el('div', 'tb-row used'), poolBox = el('div', 'tb-row pool'), note = el('small', 'note tb-note');
  const row = { win: true, key: 'tools' };
  root.append(el('div', 'tb-label', tr('이 창의 막대 (왼쪽부터)')), usedBox, el('div', 'tb-label', tr('쓰지 않는 버튼')), poolBox, note);
  const chosen = () => Array.isArray(ctx.get(row, ctx.cfg()));
  const list = () => toolbar.listOf(ctx.get(row, ctx.cfg()));
  const save = next => ctx.put(row, toolbar.clean(next));
  let dragging = '';
  const slotAt = x => {                                                   // where in the first line a pointer at x is: the number of buttons that stay in front of the dropped one
    const others = [...usedBox.querySelectorAll('.tb-item')].filter(b => b.dataset.id !== dragging);
    let n = 0;
    for (const b of others) { const r = b.getBoundingClientRect(); if (x > r.left + r.width / 2) n++; else break; }
    return { n, others };
  };
  const clearMarks = () => { for (const x of root.querySelectorAll('.drop-before, .drop-end, .over')) x.classList.remove('drop-before', 'drop-end', 'over'); };
  const toggle = id => { const l = list(); save(l.includes(id) ? l.filter(x => x !== id) : [...l, id]); };
  const boxAt = (x, y) => { const e = document.elementFromPoint(x, y); const b = e && e.closest ? e.closest('.tb-row') : null; return b && root.contains(b) ? b : null; };

  const item = (id, inUsed) => {
    const def = toolbar.TOOLS[id], b = el('button', 'tb-item'); b.type = 'button'; b.dataset.id = id; b.title = def.hint(); b.innerHTML = def.html;
    b.setAttribute('aria-label', def.title());
    b.addEventListener('pointerdown', down => {
      if (down.button !== 0) return;
      let ghost = null, moved = false;
      const sx = down.clientX, sy = down.clientY;
      b.setPointerCapture(down.pointerId);
      const mark = e => {
        clearMarks();
        const box = boxAt(e.clientX, e.clientY);
        if (box) box.classList.add('over');
        if (box === usedBox) { const { n, others } = slotAt(e.clientX); if (n < others.length) others[n].classList.add('drop-before'); else usedBox.classList.add('drop-end'); }
      };
      const move = e => {
        if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;       // (a click moves nothing)
        if (!moved) { moved = true; dragging = id; ghost = b.cloneNode(true); ghost.classList.add('tb-ghost'); document.body.append(ghost); b.classList.add('dragging'); }
        ghost.style.left = e.clientX - 15 + 'px'; ghost.style.top = e.clientY - 13 + 'px';
        mark(e);
      };
      const end = e => {
        b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', end); b.removeEventListener('pointercancel', end); document.removeEventListener('keydown', esc, true);
        try { b.releasePointerCapture(down.pointerId); } catch { /* it is gone */ }
        if (ghost) ghost.remove();
        b.classList.remove('dragging');
        const box = moved && e.type === 'pointerup' ? boxAt(e.clientX, e.clientY) : null, { n } = moved ? slotAt(e.clientX) : { n: 0 };
        clearMarks(); dragging = '';
        if (!moved) { if (e.type === 'pointerup') toggle(id); return; }
        if (box === usedBox) { const l = list().filter(x => x !== id); l.splice(n, 0, id); save(l); }
        else if (box === poolBox) save(list().filter(x => x !== id));
      };
      const esc = e => { if (e.key === 'Escape' && moved) { e.stopPropagation(); end({ type: 'pointercancel' }); } };
      b.addEventListener('pointermove', move); b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end); document.addEventListener('keydown', esc, true);
    });
    b.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(id); return; }
      if (!inUsed || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const l = list(), i = l.indexOf(id), j = i + (e.key === 'ArrowLeft' ? -1 : 1);
      if (j < 0 || j >= l.length) return;
      [l[i], l[j]] = [l[j], l[i]]; save(l); setTimeout(() => usedBox.querySelector(`[data-id="${id}"]`)?.focus(), 0);
    };
    return b;
  };

  function draw() {
    const l = list();
    usedBox.textContent = poolBox.textContent = '';
    for (const id of l) usedBox.append(item(id, true));
    const close = el('span', 'tb-close', '✕'); close.title = tr('닫기 버튼은 항상 있습니다'); usedBox.append(close);          // (always there: not a button of the list)
    for (const id of toolbar.IDS) if (!l.includes(id)) poolBox.append(item(id, false));
    if (!poolBox.children.length) poolBox.append(el('span', 'tb-empty', tr('모두 쓰고 있습니다')));
    note.textContent = chosen() ? tr('버튼을 끌어서 순서를 바꾸고, 클릭하면 쓰는 버튼과 쓰지 않는 버튼 사이로 옮겨집니다.')
      : tr('이 창은 아직 고른 적이 없어서 기본 세 개(다시 찾기, 음성, 옵션)가 보입니다. 무엇이든 바꾸면 이 목록이 저장됩니다.');
  }
  draw();
  // follows the settings while it is on the screen
  const live = () => { if (!root.isConnected && root.dataset.seen) { off(); return false; } if (root.isConnected) root.dataset.seen = '1'; return true; };
  const off = settings.onChange(() => { if (live()) draw(); });
  return root;
}
