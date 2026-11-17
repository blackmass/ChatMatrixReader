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

export const FADE_MS = 3000;           // (defaults, the values in use are T.*; see core/timings.js) how long a line takes to fade out once its time is up (tuning.py)
export const FADE_TICK_MS = 33;        // how often fading lines are drawn
export const FADE_IDLE_MS = 250;       // how often the age of the lines is looked at while none is fading

export const DEFAULT_LOOK = {
  family: '', size: 12, trans_size: 0, trans_color: '', line_gap: 0, group_gap: 4, align: 'left', bottom: false, shadow: false,
  font_weight: 400, outline: 0, outline_color: '#000000', bold_fix: 0, letter_spacing: 0, plain_text: false, text_opacity: 1.0, shadow_dx: 1, shadow_dy: 1, shadow_color: '#000000', indent: 4, fade_sec: 0,
};

// the look settings of a window (config.json keys / winconf.opt) -> the look of the view
export function lookFrom(opt) {
  return {
    family: opt('font_family', ''), size: Math.max(6, +opt('font_size', 11) || 11), trans_size: +opt('trans_font_size', 0) || 0, font_weight: Math.min(900, Math.max(100, Math.round((+opt('font_weight', 400) || 400) / 100) * 100)),
    trans_color: opt('trans_color', '') || '', line_gap: +opt('line_spacing', 0) || 0, group_gap: +opt('group_spacing', 4) || 0,
    align: opt('align', 'left') || 'left', bottom: !!opt('bottom', false), shadow: !!opt('shadow', false),
    outline: Math.max(0, Math.min(30, Math.round(+opt('outline', 0) || 0))), outline_color: opt('outline_color', '#000000') || '#000000',
    bold_fix: Math.max(0, Math.min(10, Math.round(+opt('bold_fix', 0) || 0))), letter_spacing: Math.max(-10, Math.min(20, +opt('letter_spacing', 0) || 0)), plain_text: !!opt('plain_text', false),
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
    scroll.classList.add('cv-scroll');
    scroll.appendChild(this.list);
    this.look = { ...DEFAULT_LOOK };
    this.born = [];                       // per block: when its line came in (seconds) - follows the same operations as the blocks
    this.fading = false;
    this.timer = null;
    this.tip = document.createElement('div');
    this.tip.className = 'cv-tip';
    document.body.appendChild(this.tip);
    this.list.addEventListener('mouseover', e => this.showTip(e));
    this.list.addEventListener('mousemove', e => this.moveTip(e));
    this.list.addEventListener('mouseout', () => { this.tip.style.display = 'none'; this.polled = false; });
    this.polled = false;                  // the tip on the screen was put there by tipAtPoint (the pointer of a click-through window), not by the mouse events
    this.setLook({});
  }

  get blocks() { return this.list.children; }

  // ------------------------------------------------------------------------------------------------ look
  setLook(look, model = null) {
    const before = JSON.stringify(this.look), fadeBefore = this.look.fade_sec;
    this.look = { ...DEFAULT_LOOK, ...look };
    if (this.look.fade_sec !== fadeBefore) this.touch();                 // a new time: counted from now (lines that are old do not vanish at once)
    const s = this.look, st = this.scroll.style;
    st.setProperty('--cv-family', s.family ? `"${s.family}", "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif` : '"Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", sans-serif');
    st.setProperty('--cv-size', s.size + 'px');
    st.setProperty('--cv-weight', String(s.font_weight));
    st.setProperty('--cv-trans-size', (s.trans_size > 0 ? s.trans_size : s.size) + 'px');
    st.setProperty('--cv-align', s.align);
    st.setProperty('--cv-text-alpha', Math.max(0, Math.min(1, s.text_opacity)));
    const grow = s.bold_fix / 10;                                         // (the glyphs grow by half of the stroke on every side)
    st.setProperty('--cv-shadow', shadowList(s, grow));
    st.setProperty('--cv-stroke', grow + 'px');
    st.setProperty('--cv-spacing', s.letter_spacing ? (s.letter_spacing / 10) + 'px' : 'normal');
    st.setProperty('--cv-kern', s.plain_text ? 'none' : 'auto');
    st.setProperty('--cv-render', s.plain_text ? 'optimizeSpeed' : 'auto');
    this.scroll.classList.toggle('cv-bottom', !!s.bottom);
    this.indentPx = this.measureIndent();
    st.setProperty('--cv-indent', (s.align === 'left' ? this.indentPx : 0) + 'px');
    if (model && before !== JSON.stringify(this.look)) this.rebuild(model);
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
    const gap = s.line_gap, group = b.group ? s.group_gap : 0;
    if (group > 0) el.style.marginTop = group + 'px';
    const row = gap + Math.min(0, group);
    if (row) el.style.lineHeight = `calc(1.3em + ${row}px)`;
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
      el.appendChild(span);
    }
    return el;
  }

  atBottom() { const e = this.scroll; return e.scrollHeight - e.scrollTop - e.clientHeight < 4; }

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
  }

  // draw everything again from the model (the look changed)
  rebuild(model) {
    const stick = this.atBottom(), old = this.born.slice();
    this.list.replaceChildren(...model.blocks.map(b => this.makeBlock(b, model)));
    this.born = model.blocks.map((_, i) => old[i] ?? this.now());
    if (stick) this.scroll.scrollTop = this.scroll.scrollHeight;
    this.fadeTick();
  }

  // ------------------------------------------------------------------------------------------------ fading out
  // (a faded line keeps its room: it is only drawn transparent; scrolled up, everything is shown again)
  fadeTick() {
    const sec = this.look.fade_sec, kids = this.list.children;
    const showAll = !this.atBottom();
    let fading = false, head = 0;
    for (let i = 0; i < kids.length; i++) {
      if (!kids[i].classList.contains('k-trans') && !kids[i].classList.contains('k-error')) head = i;       // a translation fades with its line
      const a = sec > 0 && !showAll ? fade.alpha(this.now() - this.born[head], sec, T.FADE_MS) : 1;
      const el = kids[i];
      if (a !== (el._a ?? 1)) { el._a = a; el.style.opacity = a >= 1 ? '' : String(a); el.style.visibility = a <= 0 ? 'hidden' : ''; }
      if (a > 0 && a < 1) fading = true;
    }
    this.fading = fading;
  }

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
  showTip(e) {
    const el = e.target.closest?.('.cv-tipped');
    if (!el || el.parentElement.style.visibility === 'hidden') { this.tip.style.display = 'none'; return; }
    this.tip.innerHTML = theme.tipHtml(el._tip);
    this.tip.style.display = 'block';
    this.moveTip(e);
  }
  moveTip(e) { this.placeTip(e.clientX, e.clientY); }
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
    // The tip stays where it first appeared (the 0.1 s pointer poll would make a following tip jerky); it moves only when the pointer goes to another link.
    if (el !== this._tipEl || !this.polled) {
      this.tip.innerHTML = theme.tipHtml(el._tip); this._tipEl = el;
      this.tip.style.display = 'block'; this.polled = true;
      this.placeTip(x, y);
    }
    return true;
  }
  // takes a tip away that tipAtPoint put there (a tip of the mouse events goes away by itself)
  hideTip() { if (!this.polled) return; this.polled = false; this._tipEl = null; this.tip.style.display = 'none'; }
}
