// Draws the blocks of a ChatModel (app/core/chatmodel.js) into a page. The model decides WHICH blocks there are; this turns the
// operations it returns (['insert', i, block] ['replace', i, block] ['delete', i, n] ['clear']) into DOM, and keeps the page equal to
// `model.blocks`. Port of chatview.py: the same look settings, expressed as CSS (hanging indent, group gap, text shadow ...).
//
//   const view = new ChatView(scrollElement);          the element needs the classes of chatview.css (see overlay.html)
//   view.setLook({ size: 15, shadow: true, ... }, model)
//   view.apply(feed.handle(event), feed.model)         after every change of the model
import * as theme from './core/theme.js';
import * as fade from './core/fade.js';
import { T } from './core/timings.js';
import { add as perfAdd } from './core/perf.js';

// A click on a link of a line (a plugin put it there): `linkHandler.fn(id)`, set by the window page
export const linkHandler = { fn: null };
export const FADE_MS = 3000;           // (defaults, the values in use are T.*; see core/timings.js) how long a line takes to fade out once its time is up (tuning.py)
export const FADE_TICK_MS = 33;        // how often fading lines are drawn
export const FADE_IDLE_MS = 250;       // how often the age of the lines is looked at while none is fading

export const DEFAULT_LOOK = {
  family: '', size: 12, trans_size: 0, trans_color: '', line_gap: 0, line_h: 0, group_gap: 4, whole: false, max_groups: 0, align: 'left', bottom: false, shadow: false,
  font_weight: 400, outline: 0, outline_color: '#000000', bold_fix: 0, letter_spacing: 0, plain_text: false, text_opacity: 1.0, shadow_dx: 1, shadow_dy: 1, shadow_color: '#000000', indent: 4, fade_sec: 0,
};

// the look settings of a window (config.json keys / winconf.opt) -> the look of the view
export function lookFrom(opt) {
  return {
    family: opt('font_family', ''), size: Math.max(6, +opt('font_size', 11) || 11), trans_size: +opt('trans_font_size', 0) || 0, font_weight: Math.min(900, Math.max(100, Math.round((+opt('font_weight', 400) || 400) / 100) * 100)),
    trans_color: opt('trans_color', '') || '', line_gap: +opt('line_spacing', 0) || 0, line_h: +opt('line_height', 0) || 0, group_gap: +opt('group_spacing', 4) || 0,
    whole: !!opt('whole_groups', false), max_groups: Math.max(0, Math.min(50, Math.round(+opt('max_groups', 0) || 0))),
    align: opt('align', 'left') || 'left', bottom: !!opt('bottom', false), shadow: !!opt('shadow', false),
    outline: Math.max(0, Math.min(30, Math.round(+opt('outline', 0) || 0))), outline_color: opt('outline_color', '#000000') || '#000000',
    bold_fix: Math.max(-10, Math.min(10, Math.round(+opt('bold_fix', 0) || 0))), letter_spacing: Math.max(-10, Math.min(20, +opt('letter_spacing', 0) || 0)), plain_text: !!opt('plain_text', false),
    text_opacity: +opt('text_opacity', 1) || 0, shadow_dx: +opt('shadow_dx', 1) || 0, shadow_dy: +opt('shadow_dy', 1) || 0,
    shadow_color: opt('shadow_color', '#000000') || '#000000', indent: Math.max(0, +opt('indent', 4) || 0), fade_sec: Math.max(0, +opt('fade_sec', 0) || 0),
  };
}

// the text-shadow of a line: the outline (a ring of copies of the text, ring radius = outline (tenths of a pixel) + half of the stroke that makes the glyphs heavier), then the shifted shadow
export function shadowList(s, grow = 0) {
  const parts = [];
  if (s.outline > 0) {
    const r = s.outline / 10 + grow / 2, col = s.outline_color || '#000', n = r > 1.5 ? 16 : 8;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; parts.push(`${(Math.cos(a) * r).toFixed(2)}px ${(Math.sin(a) * r).toFixed(2)}px 0 ${col}`); }
  }
  if (s.shadow) parts.push(`${s.shadow_dx}px ${s.shadow_dy}px 0 ${s.shadow_color || '#000'}`);
  return parts.length ? parts.join(', ') : 'none';
}

export class ChatView {
  constructor(scroll, { now = () => performance.now() / 1000 } = {}) {
    this.scroll = scroll;
    this.now = now;
    this.list = document.createElement('div');
    this.list.className = 'cv-list';
    this.list.addEventListener('click', e => { const s = e.button === 0 && e.target.closest ? e.target.closest('.cv-link') : null; if (s && linkHandler.fn) { e.stopPropagation(); linkHandler.fn(s.dataset.link); } });
    scroll.classList.add('cv-scroll');
    scroll.appendChild(this.list);
    this.look = { ...DEFAULT_LOOK };
    this.born = [];                       // per block: when its line came in (seconds) - follows the same operations as the blocks
    this.fading = false;
    this.timer = null;
    this.tip = document.createElement('div');
    this.tip.className = 'cv-tip';
    document.body.appendChild(this.tip);
    // Whether the user is at the newest line, as of the last time the position was moved (by the user, or by us). When the heights change by themselves (a font
    // that arrives later, the window made smaller, a new look) and it was at the bottom, it is put at the bottom again; one who is reading above is left where he is.
    this._stuck = true;
    scroll.addEventListener('scroll', () => { this._stuck = this.atBottom(); this.scheduleClip(); });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => { if (this._stuck && !this.atBottom()) this.scroll.scrollTop = this.scroll.scrollHeight; this.scheduleClip(); });
      ro.observe(this.list); ro.observe(scroll);
    }
    this.list.addEventListener('mouseover', e => this.showTip(e));
    this.list.addEventListener('mousemove', e => this.moveTip(e));
    this.list.addEventListener('mouseout', () => { this.tip.style.display = 'none'; this.polled = false; this.hideSunk(); });
    this.sink = null;                     // where the tip is drawn when not here: a window of its own (popup_host.js, set by the window page): { usable(), show(html, x, y), hide() }
    this.polled = false;                  // the tip on the screen was put there by tipAtPoint (the pointer of a click-through window), not by the mouse events
    this.setLook({});
  }

  get blocks() { return this.list.children; }

  // ------------------------------------------------------------------------------------------------ look
  setLook(look, model = null) {
    const before = JSON.stringify(this.look), fadeBefore = this.look.fade_sec;
    const wasBottom = this._stuck !== false || this.atBottom();           // (asked BEFORE the new look changes the heights: afterwards a taller text is "not at the bottom")
    this.look = { ...DEFAULT_LOOK, ...look };
    if (this.look.fade_sec !== fadeBefore) this.touch();                 // a new time: counted from now (lines that are old do not vanish at once)
    const s = this.look, st = this.scroll.style;
    st.setProperty('--cv-family', s.family ? `"${s.family}", "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif` : '"Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif');
    st.setProperty('--cv-size', s.size + 'px');
    st.setProperty('--cv-weight', String(s.font_weight));
    st.setProperty('--cv-trans-size', (s.trans_size > 0 ? s.trans_size : s.size) + 'px');
    st.setProperty('--cv-align', s.align);
    st.setProperty('--cv-text-alpha', Math.max(0, Math.min(1, s.text_opacity)));
    // bold_fix > 0: a stroke in the colour of the text makes the glyphs heavier (they grow by half of the stroke on every side; 0.1px a step).
    // bold_fix < 0: a very thin stroke in the OUTLINE colour (black by default) is drawn over the edge of the glyphs, so they look thinner (0.03px a step): it paints
    // over the edge, it does not take anything away. For text that looks heavier than it should on a dark background (Windows draws light text heavier than the game does).
    const grow = Math.max(0, s.bold_fix) / 10, bite = Math.max(0, -s.bold_fix) * 0.03;
    st.setProperty('--cv-shadow', shadowList(s, grow));
    st.setProperty('--cv-stroke', +(grow || bite).toFixed(2) + 'px');
    st.setProperty('--cv-stroke-color', s.bold_fix < 0 ? (s.outline_color || '#000') : 'currentColor');
    st.setProperty('--cv-spacing', s.letter_spacing ? (s.letter_spacing / 10) + 'px' : 'normal');
    st.setProperty('--cv-kern', s.plain_text ? 'none' : 'auto');
    st.setProperty('--cv-render', s.plain_text ? 'optimizeSpeed' : 'auto');
    this.scroll.classList.toggle('cv-bottom', !!s.bottom);
    this.indentPx = this.measureIndent();
    st.setProperty('--cv-indent', (s.align === 'left' ? this.indentPx : 0) + 'px');
    if (model && before !== JSON.stringify(this.look)) this.rebuild(model);
    if (wasBottom) this.toBottom();                                      // the newest line stays in view when the look changes
    this.scheduleClip();
    this.startTimer();
  }

  // the width of `indent` spaces in the translation font (like QFontMetrics.horizontalAdvance in the Python window)
  measureIndent() {
    if (!this.look.indent) return 0;
    const m = document.createElement('span');
    m.className = 'cv-blk k-trans';
    m.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
    m.textContent = ' '.repeat(this.look.indent);
    this.list.appendChild(m);
    const w = m.getBoundingClientRect().width;
    m.remove();
    return w;
  }

  // ------------------------------------------------------------------------------------------------ blocks
  makeBlock(b, model) {
    const s = this.look;
    const el = document.createElement('div');
    el.className = `cv-blk k-${b.kind}`;
    // three different spaces: between groups (the first block of a group), between an original and its translation (the next block of the group), and
    // between the rows of one block that wraps (the row height). Each one has its own setting, so none moves the others.
    // The row height adds room above AND below every row (half each), so the first row of a block would move away from the block above and the last one from the
    // block below. That half is taken off the margins again: the row height only changes the distance BETWEEN the rows of one block.
    if (b.group) el.dataset.g = '1';                                     // (the first block of a group: see clip)
    const half = s.line_h / 2;
    const above = (b.group ? s.group_gap : s.line_gap) - half;
    if (above) el.style.marginTop = above + 'px';
    if (half) { el.style.lineHeight = `calc(1.3em + ${s.line_h}px)`; el.style.marginBottom = -half + 'px'; }
    if (this.indentPx && s.align === 'left') {
      el.style.paddingLeft = 'var(--cv-indent)';
      el.style.textIndent = b.indent ? '0' : 'calc(-1 * var(--cv-indent))';       // a translation is pushed in as a whole; any other line hangs
    }
    let base = model.color(b);
    if (b.style === 'trans' && s.trans_color) base = s.trans_color;
    for (const p of b.pieces) {
      const span = document.createElement('span');
      span.textContent = p.text.replace(/️/g, '');
      span.style.color = theme.pieceColor(p, base);
      if (p.tip && p.tip.length) { span.className = 'cv-tipped'; span._tip = p.tip; }
      if (p.link) { span.classList.add('cv-link'); span.dataset.link = p.link; }
      el.appendChild(span);
    }
    return el;
  }

  atBottom() { const e = this.scroll; return e.scrollHeight - e.scrollTop - e.clientHeight < 4; }
  toBottom() { this._stuck = true; this.scroll.scrollTop = this.scroll.scrollHeight; }

  // the operations of one model change (and the model they came from, for the colours)
  apply(ops, model) {
    if (!ops.length) return;
    const stick = this.atBottom();
    const now = this.now();
    for (const op of ops) {
      const kind = op[0];
      if (kind === 'insert') {
        const [, i, b] = op, el = this.makeBlock(b, model);
        this.list.insertBefore(el, this.list.children[i] || null);
        // a line and its translation are born together: a block without a group start takes the time of its group
        this.born.splice(i, 0, b.group || i === 0 ? now : this.born[i - 1]);
      } else if (kind === 'replace') {
        const [, i, b] = op;
        this.list.replaceChild(this.makeBlock(b, model), this.list.children[i]);
      } else if (kind === 'delete') {
        const [, i, n] = op;
        for (let k = 0; k < n; k++) this.list.children[i]?.remove();
        this.born.splice(i, n);
      } else if (kind === 'clear') {
        this.list.replaceChildren();
        this.born = [];
      }
    }
    if (stick) this.scroll.scrollTop = this.scroll.scrollHeight;
    this.fadeTick();
    this.scheduleClip();
  }

  // draw everything again from the model (the look changed)
  rebuild(model) {
    const stick = this._stuck || this.atBottom(), old = this.born.slice();
    this.list.replaceChildren(...model.blocks.map(b => this.makeBlock(b, model)));
    this.born = model.blocks.map((_, i) => old[i] ?? this.now());
    if (stick) this.scroll.scrollTop = this.scroll.scrollHeight;
    this.fadeTick();
    this.scheduleClip();
  }

  // ------------------------------------------------------------------------------------------------ whole groups
  // "온전한 묶음만" (look.whole) and "보일 묶음 수" (look.max_groups): at the newest line, the groups that would be cut at the top edge of the window (or are older than the
  // number asked for) are hidden as a whole, so the window always shows 1, 2, 3 ... complete groups. Hidden = `visibility`, so nothing moves. While the user reads above
  // (not at the newest line) everything is shown again.
  scheduleClip() {
    if (this._clipQueued) return;
    this._clipQueued = true;
    requestAnimationFrame(() => this.clip());
  }
  clip() {
    this._clipQueued = false;
    for (const el of this.list.querySelectorAll('.cv-clip')) el.classList.remove('cv-clip');
    const kids = this.list.children, { whole, max_groups: max } = this.look;
    if ((!whole && !(max > 0)) || !kids.length || !this.atBottom()) return;
    const starts = [];                                                    // the index of the first block of every group
    for (let i = 0; i < kids.length; i++) if (kids[i].dataset.g || i === 0) starts.push(i);
    const last = starts.length - 1;
    let first = max > 0 && starts.length > max ? starts.length - max : 0;           // the oldest group that stays
    if (whole) {
      const edge = this.scroll.getBoundingClientRect().top + (this.inset || 0);          // (inset: the part of the top the title bar covers, see overlay.js)
      for (let g = last; g >= first; g--) {                              // from the newest back: the first one that starts above the edge is cut, so are all older ones
        if (kids[starts[g]].getBoundingClientRect().top < edge - 1) { first = g === last ? last : g + 1; break; }     // (the newest stays, even when it is taller than the window)
      }
    }
    for (let i = 0; i < starts[first]; i++) kids[i].classList.add('cv-clip');
  }

  // ------------------------------------------------------------------------------------------------ fading out
  // (a faded line keeps its room: it is only drawn transparent; scrolled up, everything is shown again)
  fadeTick() {
    const sec = this.look.fade_sec, kids = this.list.children;
    const showAll = !this.atBottom();
    let fading = false, head = 0, gone = false;
    for (let i = 0; i < kids.length; i++) {
      if (!kids[i].classList.contains('k-trans') && !kids[i].classList.contains('k-error')) head = i;       // a translation fades with its line
      const a = sec > 0 && !showAll ? fade.alpha(this.now() - this.born[head], sec, T.FADE_MS) : 1;
      const el = kids[i];
      if (a !== (el._a ?? 1)) { el._a = a; el.style.opacity = a >= 1 ? '' : String(a); el.style.visibility = a <= 0 ? 'hidden' : ''; }
      if (a > 0 && a < 1) fading = true;
      if (a <= 0) gone = true;
    }
    this.fading = fading;
    this.anyHidden = gone;                  // lines have faded away completely
    this.anyFaded = gone || fading;         // ... or are on their way (a turn of the wheel brings them back, also in the 3 seconds of the fade)
  }

  hasFaded() { return !!this.anyFaded; }

  // the user did something with the window (scrolled, changed the fade time): every line is as new again, the time starts over
  touch() {
    const now = this.now();
    this.born = this.born.map(() => now);
    this.fadeTick();
  }

  startTimer() {
    clearTimeout(this.timer);
    if (this.look.fade_sec <= 0) { this.fadeTick(); return; }
    const loop = () => { const t0 = performance.now(); this.fadeTick(); perfAdd(this.fading ? 'FADE_TICK_MS' : 'FADE_IDLE_MS', performance.now() - t0); this.timer = setTimeout(loop, this.fading ? T.FADE_TICK_MS : T.FADE_IDLE_MS); };
    loop();
  }

  stop() { clearTimeout(this.timer); }

  // ------------------------------------------------------------------------------------------------ tooltips of item links
  // the tip in a window of its own: it is not cut off by a small window, and it stays where it first appeared (it is not moved with the mouse)
  sunk() { return this.sink && this.sink.usable() ? this.sink : null; }
  hideSunk() { this._sunkEl = null; this.tip.style.display = 'none'; if (this.sink) this.sink.hide(); }
  // the window of its own could not be made: this page draws the tip after all (and the next ones, `sunk()` says no for a while)
  sinkShow(el, x, y, html) {
    Promise.resolve(this.sink.show(html, x, y)).then(ok => {
      if (ok !== false || (this._sunkEl !== el && this._tipEl !== el)) return;
      this.tip.innerHTML = html; this.tip.style.display = 'block'; this.placeTip(x, y);
    });
  }
  showTip(e) {
    const el = e.target.closest?.('.cv-tipped');
    if (this.sunk()) {
      if (!el || el.parentElement.style.visibility === 'hidden') { if (this._sunkEl) this.hideSunk(); return; }
      if (el !== this._sunkEl) { this._sunkEl = el; this.sinkShow(el, e.clientX, e.clientY, theme.tipHtml(el._tip)); }
      return;
    }
    if (!el || el.parentElement.style.visibility === 'hidden') { this.tip.style.display = 'none'; return; }
    this.tip.innerHTML = theme.tipHtml(el._tip);
    this.tip.style.display = 'block';
    this.moveTip(e);
  }
  moveTip(e) { if (!this.sunk()) this.placeTip(e.clientX, e.clientY); }
  placeTip(x, y) {
    if (this.tip.style.display === 'none') return;
    const w = this.tip.offsetWidth, h = this.tip.offsetHeight;
    this.tip.style.left = Math.max(0, Math.min(innerWidth - w, x + 12)) + 'px';
    this.tip.style.top = Math.max(0, Math.min(innerHeight - h, y + 16)) + 'px';
  }
  // A window that the mouse goes through (click-through) gets no mouse events, so the page cannot see the pointer; the window loop tells where the system's cursor
  // is (x, y in CSS pixels of the page, null = not over the window) and the tip of the link (item, quest ...) under it is shown from that.
  tipAtPoint(x, y) {
    const el = x === null || x === undefined ? null : document.elementFromPoint(x, y)?.closest?.('.cv-tipped');
    if (!el || el.parentElement.style.visibility === 'hidden') { this.hideTip(); return false; }
    if (this.sunk()) {
      if (el !== this._tipEl || !this.polled) { this._tipEl = el; this.polled = true; this.sinkShow(el, x, y, theme.tipHtml(el._tip)); }
      return true;
    }
    // The tip stays where it first appeared (the 0.1 s pointer poll would make a following tip jerky); it moves only when the pointer goes to another link.
    if (el !== this._tipEl || !this.polled) {
      this.tip.innerHTML = theme.tipHtml(el._tip); this._tipEl = el;
      this.tip.style.display = 'block'; this.polled = true;
      this.placeTip(x, y);
    }
    return true;
  }
  // takes a tip away that tipAtPoint put there (a tip of the mouse events goes away by itself)
  hideTip() { if (!this.polled) return; this.polled = false; this._tipEl = null; this.tip.style.display = 'none'; this.hideSunk(); }
}
