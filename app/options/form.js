// The rows of the options window. A tab is DATA (see tab_general.js): cards with rows; this file turns a row into DOM and keeps it in step
// with the settings. Every row has the same ends: a marker when it was changed since the window was opened (click: back to that value) and a
// "기본값" button that is dim while the value IS the default and clear while it could be reset.
//
//   row = { key, apply?(ctx, value) (instead of a plain write: a choice that fills other settings too), type, label, note?, keywords?, def?, show?(cfg), validate?(value) -> '' | error text, ...type specific }
//   types: check | number {min,max,step,unit} | text {placeholder, wide} | select {options: [[value, label]] | () => [...]} | textarea {rows}
//          | hotkey (Ctrl/Alt/Shift + a key) | combo {list, placeholder} (a list and "직접 입력")
//          | suggest {items(ctx), blank?, placeholder, needs?(cfg), cacheKey?(cfg), fail?} (ONE text box; its list drops down under it, filtered by what is typed, and a click puts the value in) | percent {min, max?} (a slider, the value is 0..1; max default 1) | color (#rrggbb or empty) | keys (Shift / Ctrl / Alt) | channels (chat channels) | routes (a choice per channel: { code: value })
//          | file {path(cfg), files, rows} (a text file of the program folder with a save button) | info {text(cfg)} | button {label, action(ctx)}
//          | custom {build(ctx) -> element, block?} (a live part a tab draws itself, e.g. the state of the voice recognition)
//   ctx = { sel (window id of the row), cfg(), snapshot, get(row, cfg), put(row, value), def(row), reset(row), following(row), known(row) }
//   (a row of a window is read and written through ctx: the main window's settings are at the top of the config, an extra window's in its
//   entry; see options.js. A setting an extra window does not have of its own follows window 1: following(row) tells.)
import { tr, macKeys } from '../core/i18n.js';
import { isMac } from '../platform.js';
import { HOST_KEYS } from '../core/winconf.js';
const keyName = k => (isMac ? macKeys(k) : k);                 // (the key boxes: the setting keeps 'Ctrl' / 'Alt', a Mac shows Control / Option)
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// the name of a channel, in the colour the chat shows it in (row.color(code))
const named = (row, code) => { const s = el('span', '', row.names(code)); if (row.color) { s.style.color = row.color(code); s.dataset.ccode = code; } return s; };

// ---- the list of a `suggest` row: one box for the whole page, so only one list is open at a time
let openSg = null;                                               // { close(), place(), pop }
const closeSg = () => { if (openSg) { const o = openSg; openSg = null; o.close(); } };
// the page scrolls (also by itself, to bring the clicked box into view): the list follows its box, and is closed when the box is out of sight
window.addEventListener('scroll', e => { if (openSg && !openSg.pop.contains(e.target)) openSg.place(); }, true);
window.addEventListener('resize', closeSg);

export const isData = row => !['info', 'button', 'file', 'examples', 'notice', 'logview', 'perf', 'diag', 'custom'].includes(row.type);

export function buildRow(row, ctx) {
  const root = el('div', 'row t-' + row.type);
  const mark = el('button', 'rev', '↶');
  const text = el('div', 'text');
  const followTag = el('small', 'followtag', '창 1을 따름'); followTag.hidden = true;
  const dockTag = el('small', 'followtag docktag', ''); dockTag.hidden = true;           // (a window that is a tab of another: what belongs to the window is the other's)
  const labelLine = el('div', 'labelline'); labelLine.append(el('b', 'label', row.label || ''), followTag, dockTag);
  // row.when: whether a change takes effect while the thing it belongs to runs: 'live' = at once, 'restart' = after "지금 다시 시작" (the voice recognition)
  // (not `apply`: that is the function some rows use to write their value)
  if (row.when === 'live' || row.when === 'restart') {
    const live = row.when === 'live', a = el('small', 'apply ' + row.when, live ? tr('바로 적용') : tr('다시 시작해야 적용'));
    a.title = live ? tr('켜 둔 채 바꿔도 바로 반영됩니다') : tr('켜 둔 채 바꾸면 위의 "지금 다시 시작"을 눌러야 반영됩니다');
    labelLine.append(a);
  }
  text.append(labelLine);
  if (row.note) for (const n of [].concat(row.note)) text.append(el('small', 'note', n));       // (a note may be a list: one line each)
  const why = el('small', 'why'); why.hidden = true;                 // row.unsupported(cfg, ctx) -> a text when the setting means nothing for what is chosen (the row stays, dim, with this text under it; row.unsupportedEditable: it can still be changed)
  const hint = row.hints ? el('small', 'note hint') : null;       // row.hints { value: text }: what the chosen value means, under the label
  if (hint) text.append(hint);
  text.append(why);
  const ctl = el('div', 'ctl');
  const err = el('div', 'err');
  const defBtn = el('button', 'def', '기본값');
  let input = null, read = null, write = null;
  // an extra window's row that can be left empty to follow window 1: no "창 1 따르기" button, the empty input says it (a small dim text with window 1's value)
  const canFollow = !!(row.win && ctx.canFollow && ctx.canFollow(row));
  let followText = () => {};                                   // keeps the "창 1을 따름 · value" texts up to date (set by the row types that have them)
  // row.zeroEmpty: a number whose 0 means "no value" (hide after 0 s would hide at once; a lower line of size 0 is unreadable): the main window
  // shows it as an EMPTY box (typing 0 empties it) with a dim text that says what empty means (row.zeroText(ctx, forExtraWindow)); an extra window
  // keeps "empty = follow window 1" and shows that text behind it when window 1 has no value
  const mainShown = () => {
    const v = ctx.mainValue(row);
    if (row.zeroEmpty && row.zeroText && (v === undefined || v === null || v === '' || Number(v) === 0)) return row.zeroText(ctx, true);
    return v === undefined || v === null || v === '' ? tr('기본') : String(v);
  };

  const commit = value => {
    const bad = row.validate ? row.validate(value) : '';
    err.textContent = bad || '';
    root.classList.toggle('bad', !!bad);
    if (!bad) (row.apply ? row.apply(ctx, value) : ctx.put(row, value));
  };

  if (row.type === 'check') {
    input = el('input'); input.type = 'checkbox';
    const sw = el('label', 'switch'); sw.append(input, el('span', 'knob'));
    ctl.append(sw);
    read = () => input.checked; write = v => { input.checked = !!v; };
    input.onchange = () => commit(input.checked);
  } else if (row.type === 'number') {
    const blank0 = !!row.zeroEmpty && !canFollow;                 // the main window of a zeroEmpty row: 0 is the empty box
    const lo = blank0 ? Math.max(1, Number(row.min) || 0) : row.min;
    input = el('input'); input.type = 'number'; input.min = lo; input.max = row.max; input.step = row.step || 1;
    // the unit may be a list too (one under the other): ['× 0.1px', '(음수는 × 0.03px)']
    const unitEl = u => { if (!Array.isArray(u)) return el('span', 'unit', u); const b = el('span', 'unit multi'); for (const x of u) b.append(el('span', '', x)); return b; };
    ctl.append(input); if (row.unit) ctl.append(unitEl(row.unit));
    read = () => (input.value === '' ? (canFollow ? null : (blank0 ? 0 : NaN)) : Number(input.value));
    write = v => { input.value = v === null || v === undefined || (blank0 && Number(v) === 0) ? '' : v; };
    input.onchange = () => {
      const v = read();
      if (v === null) { err.textContent = ''; root.classList.remove('bad'); commit(null); return; }          // emptied: follows window 1
      if (blank0 && v === 0) { input.value = ''; err.textContent = ''; root.classList.remove('bad'); commit(0); return; }   // 0 = no value = empty
      if (!Number.isFinite(v) || v < lo || v > row.max) { err.textContent = `${lo} ~ ${row.max}`; root.classList.add('bad'); return; }
      commit(v);
    };
    if (canFollow || blank0) {
      // the arrows start from window 1's value (an empty input would start from 1): empty + up = window 1's value + one step.
      // row.startAt(ctx, dir): where an empty box starts instead (a number, or undefined = the rule above)
      input.classList.add('follow-input');
      if (row.zeroText) input.classList.add('wide-num');
      const step = Number(row.step) || 1, round = v => Math.round(v * 1e6) / 1e6;
      const nudge = dir => {
        let v;
        const start = input.value === '' && row.startAt ? row.startAt(ctx, dir) : undefined;
        if (start !== undefined) v = start;
        else {
          const cur = input.value === '' ? (canFollow ? Number(ctx.mainValue(row)) : NaN) : Number(input.value);
          const base = Number.isFinite(cur) ? cur : (blank0 ? lo - step : Number(row.min) || 0);
          v = round(base + dir * step);
        }
        v = Math.min(row.max, Math.max(lo, v));
        input.value = v; err.textContent = ''; root.classList.remove('bad'); commit(v);
      };
      const pad = el('span', 'stepper'), up = el('button', 'step', '▴'), down = el('button', 'step', '▾');
      up.tabIndex = down.tabIndex = -1; up.type = down.type = 'button';
      up.onclick = () => nudge(1); down.onclick = () => nudge(-1);
      pad.append(up, down); input.after(pad);
      input.addEventListener('keydown', e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1); } });
      followText = () => { input.placeholder = blank0 ? (row.zeroText ? row.zeroText(ctx, false) : '') : tr('창 1을 따름') + ' · ' + mainShown(); };
    }
  } else if (row.type === 'text' || row.type === 'password') {
    input = el('input', row.wide ? 'wide' : ''); input.type = row.type === 'password' ? 'password' : 'text';
    input.spellcheck = false; input.autocomplete = 'off'; if (row.placeholder) input.placeholder = row.placeholder;
    if (row.suggest) { const dl = el('datalist'); dl.id = 'dl_' + row.key; for (const v of row.suggest) { const o = el('option'); o.value = v; dl.append(o); } input.setAttribute('list', dl.id); ctl.append(dl); }
    ctl.append(input);
    read = () => input.value.trim(); write = v => { input.value = v ?? ''; };
    input.onchange = () => commit(read());
  } else if (row.type === 'hotkey') {
    // Shift / Ctrl / Alt boxes and a key list (catching the keys themselves is fragile: Enter would end the input)
    const boxes = ['Ctrl', 'Alt', 'Shift'].map(k => { const l = el('label', 'keybox'); const c = el('input'); c.type = 'checkbox'; c.value = k; l.append(c, el('span', '', keyName(k))); ctl.append(l); return c; });
    const KEYLIST = ['Enter', 'Space', 'Tab', 'Backspace', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Left', 'Up', 'Right', 'Down', '`',
      ...Array.from({ length: 12 }, (_, i) => 'F' + (i + 1)), ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
    input = el('select', 'hotkeykey');
    for (const k of KEYLIST) { const o = el('option', '', k); o.value = k; input.append(o); }
    ctl.append(input);
    const parts = () => ({ mods: boxes.filter(b => b.checked).map(b => b.value), key: input.value });
    read = () => { const { mods, key } = parts(); return [...mods, key].join('+'); };
    write = v => { const have = String(v || '').split('+'); for (const b of boxes) b.checked = have.includes(b.value); input.value = have[have.length - 1] in Object.fromEntries(KEYLIST.map(k => [k, 1])) ? have[have.length - 1] : 'Enter'; };
    const change = () => {
      const { mods, key } = parts();
      if (!mods.length && !/^F\d+$/.test(key) && !['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) {
        err.textContent = '글자·숫자·Enter 같은 키는 Ctrl, Alt, Shift 중 하나와 함께 써야 합니다 (그냥 누르면 채팅이 막힙니다)'; root.classList.add('bad'); return;
      }
      commit(read());
    };
    for (const b of boxes) b.onchange = change;
    input.onchange = change;
  } else if (row.type === 'combo') {
    // a list to pick from + "직접 입력" (a value that is not in the list, e.g. a language code)
    const sel = el('select'), own = el('input', 'wide'); own.type = 'text'; own.spellcheck = false; own.placeholder = row.placeholder || '';
    const OWN = '\u0000own';
    const list = typeof row.list === 'function' ? row.list() : row.list;               // (a function: asked when the form is drawn)
    const blankText = typeof row.blank === 'function' ? row.blank(ctx) : row.blank;
    let blankOpt = null;
    if (blankText) { blankOpt = el('option', '', blankText); blankOpt.value = ''; sel.append(blankOpt); }
    const entries = list.map(x => (Array.isArray(x) ? x : [x, x]));                  // a value, or [value, text shown]
    for (const [v, text] of entries) { const o = el('option', '', text); o.value = v; if (v === '-') { o.disabled = true; o.value = '\u0000line'; } sel.append(o); }
    const o = el('option', '', '직접 입력'); o.value = OWN; sel.append(o);
    ctl.append(sel, own);
    input = sel;
    read = () => (sel.value === OWN ? own.value.trim() : sel.value);
    write = v => { const inList = (blankText && !v) || entries.some(x => x[0] === v); sel.value = inList ? (v || '') : OWN; own.hidden = inList; if (!inList && document.activeElement !== own) own.value = v ?? ''; };
    sel.onchange = () => { if (sel.value === OWN) { own.hidden = false; own.focus(); } else commit(sel.value); };
    if (canFollow && blankOpt) followText = () => { blankOpt.textContent = tr('창 1을 따름') + ' · ' + mainShown(); };
    own.onchange = () => commit(own.value.trim());
  } else if (row.type === 'suggest') {
    // items(ctx) -> [{ value, text?, sub? } | { head }]  or a promise of it (a failed promise has `kind`: row.fail[kind] is the short orange note; `message` goes to its tooltip)
    // blank: what an empty box means (shown as its dim text, and as the first line of the list). needs(cfg) -> a text when the list cannot be asked for yet.
    input = el('input', 'wide'); input.type = 'text'; input.spellcheck = false; input.autocomplete = 'off';
    const blankText = () => (canFollow ? tr('창 1을 따름') + ' · ' + mainShown() : (typeof row.blank === 'function' ? row.blank(ctx) : row.blank) || '');
    input.placeholder = row.placeholder || '';
    if (canFollow) input.classList.add('follow-input');
    const state = el('small', 'sg-state'); state.hidden = true;
    const pop = el('div', 'sg-pop');
    ctl.append(state, input);
    let items = [], rows = [], active = -1, typed = false, cache = null, seq = 0, isOpen = false;
    const setState = (text, kind, title) => { state.hidden = !text; state.textContent = text || ''; state.className = 'sg-state' + (kind ? ' ' + kind : ''); state.title = title || ''; };
    const place = () => {
      const r = input.getBoundingClientRect(), below = innerHeight - r.bottom - 8, above = r.top - 8;
      if (r.bottom < 0 || r.top > innerHeight) { close(); return; }
      const up = pop.scrollHeight > below && above > below;
      pop.style.left = r.left + 'px'; pop.style.minWidth = Math.max(r.width, 240) + 'px';
      pop.style.maxHeight = Math.max(80, Math.min(280, up ? above : below)) + 'px';
      if (up) { pop.style.top = ''; pop.style.bottom = (innerHeight - r.top + 2) + 'px'; } else { pop.style.bottom = ''; pop.style.top = (r.bottom + 2) + 'px'; }
    };
    const pick = v => { input.value = v; typed = false; close(); commit(v); };
    const draw = () => {
      const q = typed ? input.value.trim().toLowerCase() : '';
      const hit = it => !q || String(it.value).toLowerCase().includes(q) || String(it.text || '').toLowerCase().includes(q) || String(it.sub || '').toLowerCase().includes(q);
      const list = [], bl = blankText();
      if (bl && !q) list.push({ value: '', text: bl, dim: true });
      let head = null;
      for (const it of items) { if (it.head) { head = it; continue; } if (!hit(it)) continue; if (head) { list.push(head); head = null; } list.push(it); }
      rows = list; active = -1;
      pop.replaceChildren(...list.map((it, i) => {
        if (it.head) return el('div', 'sg-head', it.head);
        const d = el('div', 'sg-item' + (it.dim ? ' dim' : '') + (it.value === input.value.trim() && !it.dim ? ' cur' : ''));
        d.append(el('span', 'sg-main', it.text ?? it.value));
        if (it.sub) d.append(el('small', 'sg-sub', it.sub));
        d.onmousedown = e => { e.preventDefault(); pick(it.value); };
        d.onmousemove = () => { active = i; mark(); };
        return d;
      }));
      if (!isOpen) return;
      if (!list.some(x => !x.head)) { pop.remove(); return; }
      if (!pop.isConnected) document.body.append(pop);
      place();
    };
    const mark = () => { [...pop.children].forEach((c, i) => c.classList.toggle('active', i === active)); const c = pop.children[active]; if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }); };
    const close = () => { isOpen = false; seq++; pop.remove(); if (openSg && openSg.pop === pop) openSg = null; };
    const load = () => {
      const need = row.needs ? row.needs(ctx.cfg()) : '';
      if (need) { items = []; setState(need, 'dim'); draw(); return; }
      const got = row.items(ctx);
      if (!got || typeof got.then !== 'function') { items = got || []; setState(''); draw(); return; }
      const key = row.cacheKey ? row.cacheKey(ctx.cfg()) : '', mine = ++seq;
      if (cache && cache.key === key) { items = cache.items; draw(); }            // (the last answer at once, the new one replaces it)
      setState(tr('불러오는 중…'), 'dim');
      got.then(list => { if (mine !== seq) return; cache = { key, items: list }; items = list; setState(''); draw(); },
        e => { if (mine !== seq) return; items = []; setState(tr((row.fail && row.fail[e && e.kind]) || '목록을 불러오지 못했습니다'), 'bad', String((e && e.message) || e)); draw(); });
    };
    const open = () => { if (isOpen) return; closeSg(); isOpen = true; openSg = { close, place, pop }; typed = false; load(); };
    read = () => input.value.trim(); write = v => { input.value = v ?? ''; };
    followText = () => { input.placeholder = blankText() || row.placeholder || ''; };
    input.onfocus = open; input.onclick = open;
    input.oninput = () => { typed = true; open(); draw(); };
    input.onblur = () => close();
    input.onchange = () => commit(read());
    input.onkeydown = e => {
      const sel = rows.map((x, i) => (x.head ? -1 : i)).filter(i => i >= 0);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!isOpen) { open(); return; }
        if (!sel.length) return;
        const at = sel.indexOf(active), n = e.key === 'ArrowDown' ? (at < 0 ? 0 : Math.min(sel.length - 1, at + 1)) : (at < 0 ? sel.length - 1 : Math.max(0, at - 1));
        active = sel[n]; mark();
      } else if (e.key === 'Enter' && isOpen && active >= 0 && rows[active] && !rows[active].head) { e.preventDefault(); pick(rows[active].value); }
      else if (e.key === 'Escape' && isOpen) { e.preventDefault(); close(); }
    };
  } else if (row.type === 'select') {
    input = el('select');
    const optionList = () => (typeof row.options === 'function' ? row.options(ctx) : row.options);
    // an extra window: "창 1을 따름" on top (its value is empty = null); the text says what window 1 has now
    const label = v => { const e = optionList().find(x => String(x[0]) === String(v)); return e ? e[1] : (v === undefined || v === null || v === '' ? tr('기본') : String(v)); };
    const fill = () => {
      input.textContent = '';
      if (canFollow) { const f = el('option', '', tr('창 1을 따름') + ' · ' + label(ctx.mainValue(row))); f.value = ''; input.append(f); }
      for (const [v, l] of optionList()) { const o = el('option', '', l); o.value = String(v); input.append(o); }
    };
    fill();
    ctl.append(input);
    read = () => (canFollow && input.value === '' ? null : input.value); write = v => { fill(); input.value = v === null || v === undefined ? '' : String(v); };
    input.onchange = () => commit(read());
    if (canFollow) followText = () => { if (input.options.length) input.options[0].textContent = tr('창 1을 따름') + ' · ' + label(ctx.mainValue(row)); };
  } else if (row.type === 'percent') {
    input = el('input'); input.type = 'range'; input.min = Math.round((row.min || 0) * 100); input.max = Math.round((row.max || 1) * 100); input.step = 1;
    const out = el('span', 'unit pct');
    ctl.append(input, out);
    read = () => Number(input.value) / 100; write = v => { input.value = Math.round((Number(v) || 0) * 100); out.textContent = input.value + '%'; };
    input.oninput = () => { out.textContent = input.value + '%'; };
    input.onchange = () => commit(read());
  } else if (row.type === 'color') {
    input = el('input', 'colortext'); input.type = 'text'; input.placeholder = '기본'; input.spellcheck = false;
    if (canFollow) { input.classList.add('follow-input'); followText = () => { input.placeholder = tr('창 1을 따름') + ' · ' + mainShown(); }; }
    const sw = el('input', 'swatch'); sw.type = 'color';
    ctl.append(input, sw);
    read = () => input.value.trim().toLowerCase();
    write = v => { input.value = v || ''; sw.value = /^#[0-9a-f]{6}$/i.test(v || '') ? v : '#ffffff'; };
    row = { ...row, validate: v => (v === '' || /^#[0-9a-f]{6}$/.test(v) ? '' : '색은 #rrggbb 모양으로 적어 주세요 (비우면 기본)') };
    input.onchange = () => commit(read());
    sw.onchange = () => { input.value = sw.value; commit(sw.value); };
  } else if (row.type === 'keys') {
    const boxes = ['Shift', 'Ctrl', 'Alt'].map(k => { const l = el('label', 'keybox'); const c = el('input'); c.type = 'checkbox'; c.value = k; l.append(c, el('span', '', keyName(k))); ctl.append(l); return c; });
    read = () => boxes.filter(b => b.checked).map(b => b.value);
    write = v => { const have = new Set(v || []); for (const b of boxes) b.checked = have.has(b.value); };
    row = { ...row, validate: v => (v.length ? '' : '하나는 꼭 체크해야 합니다') };
    for (const b of boxes) b.onchange = () => commit(read());
  } else if (row.type === 'channels') {
    root.classList.add('block');
    const grid = el('div', 'chgrid'), bar = el('div', 'chbar');
    const boxes = new Map();
    for (const code of row.codes) { const l = el('label', 'chbox'); const c = el('input'); c.type = 'checkbox'; c.value = code; boxes.set(code, c); l.append(c, named(row, code)); grid.append(l); }
    const all = el('button', 'btn small', '모두 선택'), none = el('button', 'btn small', '모두 해제');
    bar.append(all, none);
    read = () => row.codes.filter(c => boxes.get(c).checked);
    write = v => { const have = new Set(v || []); for (const [c, b] of boxes) b.checked = have.has(c); };
    for (const b of boxes.values()) b.onchange = () => commit(read());
    all.onclick = () => commit([...row.codes]); none.onclick = () => commit([]);
    input = grid; root._bar = bar;
  } else if (row.type === 'routes') {
    root.classList.add('block');
    const grid = el('div', 'routegrid'), sels = new Map();
    for (const code of row.codes) {
      const l = el('label', 'routebox'); const sel = el('select');
      for (const [v, t] of [['', '(기본 방식)'], ...row.options]) { const o = el('option', '', t); o.value = v; sel.append(o); }
      sels.set(code, sel); l.append(named(row, code), sel); grid.append(l);
      sel.onchange = () => commit(read());
    }
    read = () => Object.fromEntries([...sels].filter(([, s]) => s.value).map(([c, s]) => [c, s.value]));
    write = v => { for (const [c, s] of sels) s.value = (v && v[c]) || ''; };
    input = grid;
  } else if (row.type === 'textarea') {
    input = el('textarea'); input.rows = row.rows || 4; input.spellcheck = false;
    root.classList.add('block');
    read = () => input.value; write = v => { input.value = v ?? ''; };
    input.onchange = () => commit(read());
  } else if (row.type === 'info') {
    const out = el('span', 'info');
    ctl.append(out);
    write = () => { out.textContent = row.text(ctx.cfg()); };
  } else if (row.type === 'file') {
    // a text file of the program folder, edited here and saved with its own button (the program notices a saved file by itself)
    root.classList.add('block');
    input = el('textarea', 'filetext'); input.rows = row.rows || 16; input.spellcheck = false; input.wrap = 'off';
    const save = el('button', 'btn', '저장'), state = el('span', 'filestate');
    ctl.append(state, save);
    let name = null, loaded = '', dirty = false;
    const pathNow = () => row.path(ctx.cfg());
    async function load() {
      name = pathNow(); state.textContent = '';
      let t = null; try { t = await row.files.read(name); } catch { /* shown as empty */ }
      loaded = t == null ? '' : t.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'); input.value = loaded; dirty = false; save.disabled = true;
      if (t == null) {                                   // a new file starts with the sample (the program also makes it by itself in a moment)
        let sample = null; try { sample = row.sample ? await row.files.read(row.sample) : null; } catch { /* empty */ }
        if (sample != null) { input.value = sample.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'); dirty = true; save.disabled = false; state.textContent = '새 파일: 샘플 내용입니다'; }
        else state.textContent = '파일이 아직 없습니다. 저장하면 만들어집니다.';
      }
    }
    input.oninput = () => { dirty = input.value !== loaded; save.disabled = !dirty; state.textContent = dirty ? '저장하지 않음' : ''; };
    save.onclick = async () => {
      try { await row.files.write(name, input.value); loaded = input.value; dirty = false; save.disabled = true; state.textContent = '저장했습니다. 바로 반영됩니다.'; }
      catch (e) { state.textContent = tr('저장하지 못했습니다: {e}', { e: e?.message || e }); }
    };
    input.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) save.onclick(); } };
    write = () => { if (name !== pathNow() && !dirty) load(); };
    load();
  } else if (row.type === 'logview') {
    // the end of a text file (the log), read only: refresh / copy
    root.classList.add('block');
    input = el('textarea', 'filetext logtext'); input.rows = row.rows || 20; input.readOnly = true; input.wrap = 'off';
    const reload = el('button', 'btn', '새로 고침'), copy = el('button', 'btn', '복사'), state = el('span', 'filestate');
    ctl.append(state, reload, copy);
    async function load() {
      let t = null; try { t = await row.files.read(row.path); } catch { /* none */ }
      if (t == null) { input.value = ''; state.textContent = '로그 파일이 아직 없습니다'; return; }
      const lines = t.replace(/\r\n/g, '\n').split('\n');
      const tail = lines.slice(-(row.last || 400));
      input.value = tail.join('\n'); input.scrollTop = input.scrollHeight;
      state.textContent = tr('전체 {n}줄 중 마지막 {m}줄', { n: lines.length, m: tail.length });
    }
    reload.onclick = load;
    copy.onclick = async () => { try { await navigator.clipboard.writeText(input.value); state.textContent = '복사했습니다'; } catch { input.select(); state.textContent = '선택했습니다 (Ctrl+C로 복사)'; } };
    write = () => {};
    load();
  } else if (row.type === 'examples') {
    // ready-made texts for another setting (row.target): a click puts the text there (the user can still change it)
    root.classList.add('block');
    const list = el('div', 'examples');
    for (const [name, text] of row.items) {
      const b = el('button', 'ex'); b.append(el('b', '', name), el('span', '', text));
      b.onclick = () => (row.pick ? row.pick(ctx, text) : ctx.set({ [row.target]: text }));          // (`pick`: the target is a row that keeps its value somewhere else)
      list.append(b);
    }
    input = list;
  } else if (row.type === 'notice') {
    root.classList.add('warn');
    const span = el('span', 'info', row.text || '');
    ctl.append(span);
    if (row.textOf) write = () => { const t = row.textOf(ctx.cfg()); if (t) span.textContent = typeof t === 'string' ? tr(t) : tr(t.text, t.vars); };          // (a text that depends on the settings)
  } else if (row.type === 'perf') {
    root.classList.add('block');
    ctl.append(perfTable(row));
  } else if (row.type === 'diag') {
    root.classList.add('block');
    ctl.append(diagTable());
  } else if (row.type === 'custom') {
    if (row.block) root.classList.add('block', 'custom-block');
    ctl.append(row.build(ctx));
  } else if (row.type === 'button') {
    const b = el('button', 'btn', row.button || row.label);
    const result = el('small', 'note result'); result.hidden = true; text.append(result);       // (an action may answer with a text: shown under the row)
    b.onclick = async () => {
      b.disabled = true;
      try { const r = await row.action(ctx); if (typeof r === 'string') { result.hidden = false; result.textContent = r; } }
      catch (e) { result.hidden = false; result.textContent = String(e); }
      finally { b.disabled = false; }
    };
    ctl.append(b);
  }

  if (isData(row)) { ctl.append(defBtn); }
  root.append(mark, text, ctl);
  if (input && ['textarea', 'file', 'examples', 'logview'].includes(row.type)) root.append(input);
  if (row.type === 'channels') root.append(root._bar, input);
  if (row.type === 'routes') root.append(input);
  root.append(err);

  defBtn.onclick = () => { ctx.reset(row); err.textContent = ''; root.classList.remove('bad'); };
  mark.onclick = () => { ctx.put(row, structuredClone(ctx.get(row, ctx.snapshot))); err.textContent = ''; root.classList.remove('bad'); };

  // the settings changed (by this row, another row, a revert, another window): show them
  function refresh() {
    const cfg = ctx.cfg();
    root.hidden = !!(row.show && !row.show(cfg, ctx));
    const reason = row.unsupported ? row.unsupported(cfg, ctx) : '';
    root.classList.toggle('unsupported', !!reason); root.classList.toggle('frozen', !!reason && !row.unsupportedEditable);
    why.hidden = !reason; why.textContent = reason ? tr(reason) : '';
    if (row.flag) root.classList.toggle('mismatch', !!row.flag(cfg));                  // (a row that is set against another: marked, the notice says what)
    const dh = row.win && (row.virtual ? row.virtual.some(k => HOST_KEYS.has(k)) : HOST_KEYS.has(row.key)) && ctx.dockHost ? ctx.dockHost() : 0;
    root.classList.toggle('docked', !!dh); dockTag.hidden = !dh;
    if (dh) dockTag.textContent = tr('{name} 창을 따름', { name: ctx.nameOf(dh) });
    const value = isData(row) ? ctx.get(row, cfg) : undefined;
    if (hint) hint.textContent = row.hints[ctx.get(row, cfg)] || '';
    if (write && (!input || !input.contains(document.activeElement))) write(value);
    if (isData(row)) {
      const follow = ctx.following(row);                       // an extra window: no value of its own, it has window 1's
      const isDef = follow !== undefined ? follow : same(value, ctx.def(row));
      const before = ctx.get(row, ctx.snapshot), changed = ctx.known(row) && !same(value, before);
      defBtn.hidden = canFollow;                                  // (an empty input / "창 1을 따름" is the way back, not a button)
      defBtn.disabled = isDef; defBtn.classList.toggle('is-default', isDef);
      followText();
      root.classList.toggle('changed', changed);
      mark.title = changed ? tr('열었을 때 값으로 되돌리기: {v}', { v: shown(before) }) : '';
      root.classList.toggle('modified', !isDef);
      followTag.hidden = true;
    } else if (row.type === 'info') write();
  }
  const shown = v => (typeof v === 'boolean' ? (v ? tr('켬') : tr('끔')) : v === '' || v === undefined || v === null ? tr('(비어 있음)') : String(v).slice(0, 40));
  return { el: root, refresh, row };
}

// A live table of how long the periodic jobs take. Every page that runs one tells it every 2 s ('perf' event: runs and total time per job).
// Per job: runs per second (all windows together), time per run, the share of one second spent on it, and what that would be at 60 runs per
// second ("every frame"). The time of a run includes the waiting for the answers of the program (it is not only processor time).
function perfTable(row) {
  const wrap = el('div', 'perfwrap'), table = el('table', 'perf');
  const head = el('tr'); for (const h of ['작업', '주기', '횟수/초', '1회', '사용률', '매 프레임이면']) head.append(el('th', '', tr(h)));
  table.append(head);
  const body = el('tbody'); table.append(body);
  wrap.append(table, el('small', 'note', tr('1회 시간에는 프로그램의 응답을 기다린 시간도 들어 있어서, 사용률은 실제 처리 부담보다 크게 나옵니다. "매 프레임이면"은 같은 일을 초당 60번 할 때(약 16ms마다)의 사용률입니다. 숫자는 2초마다 갱신됩니다.')));
  const seen = new Map();                                            // page label -> { at, secs, stats }
  const draw = () => {
    const now = performance.now(), sum = new Map();
    for (const [k, v] of seen) if (now - v.at > 6000) seen.delete(k);
    for (const v of seen.values()) for (const [name, s] of Object.entries(v.stats)) {
      const t = sum.get(name) || { n: 0, ms: 0, secs: 0, runs: 0 };
      t.n += s.n / v.secs; t.ms += s.ms; t.runs += s.n; sum.set(name, t);
    }
    body.replaceChildren();
    let total = 0;
    for (const [name, [label, def, unit]] of Object.entries(row.names)) {
      const t = sum.get(name); if (!t || !t.runs) continue;
      const per = t.ms / t.runs, share = t.n * per / 10, frame = per * 60 / 10;     // (ms per second / 1000 * 100 = %)
      total += share;
      const tr_ = el('tr'), period = String(ctxCfgValue(name, def));
      for (const c of [tr(label), `${period} ${tr(unit)}`, t.n.toFixed(1), per.toFixed(2) + ' ms', share.toFixed(2) + ' %', frame.toFixed(1) + ' %']) tr_.append(el('td', '', c));
      body.append(tr_);
    }
    if (!body.children.length) { const r = el('tr'), c = el('td', '', tr('측정값을 기다리는 중...')); c.colSpan = 6; r.append(c); body.append(r); return; }
    const r = el('tr', 'sum'), c = el('td', '', tr('합계') + ': ' + total.toFixed(2) + ' %'); c.colSpan = 6; r.append(c); body.append(r);
  };
  const ctxCfgValue = (name, def) => { try { const t = window.__cmrTuning?.(); return t && typeof t[name] === 'number' ? t[name] : def; } catch { return def; } };
  window.__TAURI__.event.listen('perf', ev => { seen.set(ev.payload.label, { at: performance.now(), secs: ev.payload.secs, stats: ev.payload.stats }); draw(); });
  draw();
  return wrap;
}

// What the translation windows look like to Windows, once a second: who has the keyboard focus (the program in front) and the window styles
// that keep a window from taking the focus. For "the taskbar stays up": if the program in front is this one, a window took the focus.
function diagTable() {
  const wrap = el('div', 'perfwrap'), table = el('table', 'perf'), body = el('tbody');
  const head = el('tr'); for (const h of ['창', '앞에 있는 프로그램', '포커스를 안 가져감', '도구 창', '항상 위', '방식/상태', '클릭 지연(ms)']) head.append(el('th', '', tr(h)));
  table.append(head, body);
  wrap.append(table, el('small', 'note', tr('"앞에 있는 프로그램"이 이 프로그램(ChatMatrix)이면 번역창이 포커스를 가져간 것이라 와우가 전체 화면 기준에서 빠지고 작업표시줄이 나옵니다. "포커스를 안 가져감"이 아니오이면 창 스타일이 지워진 것입니다 (곧 자동으로 다시 걸립니다). "클릭 지연"은 마우스 왼쪽 버튼이 눌린 것을 시스템이 본 시각과 이 창이 클릭을 받은 시각의 차이입니다 (최근 5번, 0.1초 단위로 측정). 클릭할 때 0.5초씩 나오면 입력이 실제로 늦게 도착하는 것입니다.')));
  const seen = new Map();
  const draw = () => {
    const now = performance.now();
    for (const [k, v] of seen) if (now - v.at > 4000) seen.delete(k);
    body.replaceChildren();
    for (const [label, v] of [...seen].sort()) {
      const ex = Number(v.ex) || 0, yes = tr('예'), no = tr('아니오'), r = el('tr');
      for (const c of [label, `${v.fgExe || '?'} · ${(v.fgTitle || '').slice(0, 30)}`, ex & 0x08000000 ? yes : no, ex & 0x80 ? yes : no, ex & 0x8 ? yes : no, v.mode || '', (v.lag || []).join(' ') || '-']) r.append(el('td', '', c));
      body.append(r);
    }
    if (!body.children.length) { const r = el('tr'), c = el('td', '', tr('측정값을 기다리는 중...')); c.colSpan = 7; r.append(c); body.append(r); }
  };
  window.__TAURI__.event.listen('diag', ev => { seen.set(ev.payload.label, { at: performance.now(), ...ev.payload }); draw(); });
  draw();
  return wrap;
}

// cards -> DOM; returns the built rows. A card with `fold: true` can be folded (only where `opts.fold`: the tab itself, not search / changed
// lists); it starts open when `open(cfg)` says so, and keeps what the user chose while the window is open. With `follow: true` it also opens
// / folds by itself at the moment `open(cfg)` changes (the card of the method that was just chosen opens, the other one folds).
const folded = new Map();
export function buildCards(cards, ctx, into, opts = {}) {
  const built = [];
  for (const card of cards) {
    const sec = el('section', 'card');
    const foldable = !!(card.fold && opts.fold);
    const h = card.title ? el('h3', '', card.title) : null;
    if (h) sec.append(h);
    if (card.note) sec.append(el('p', 'cardnote', card.note));
    const body = el('div', 'cardbody');
    sec.append(body);
    const mine = [];
    for (const r of card.rows) { const b = buildRow(r, ctx); built.push(b); mine.push(b); body.append(b.el); }
    if (foldable) {
      if (!folded.has(card.title)) folded.set(card.title, !(card.open && card.open(ctx.cfg())));
      const apply = () => { const f = folded.get(card.title); body.hidden = f; h.classList.toggle('folded', f); };
      h.classList.add('foldable'); h.onclick = () => { folded.set(card.title, !folded.get(card.title)); apply(); };
      apply();
      if (card.follow) {
        let last = !!card.open(ctx.cfg());
        built.push({ refresh: () => { const now = !!card.open(ctx.cfg()); if (now !== last) { last = now; folded.set(card.title, !now); apply(); } } });
      }
    }
    built.push({ refresh: () => { sec.hidden = mine.every(b => b.el.hidden); } });       // a card with nothing to show is hidden
    into.append(sec);
  }
  return built;
}
