// The "view" of a window of a PLUGIN (kind 'page'): it has the same few doors as a ChatView (app/chatview.js) so that the window code (overlay.js) needs no second way, but it draws
// nothing: the page of the plugin is a frame in the element. Chat lines never come to such a window (it shows no channel).
export class PageView {
  constructor(scroll) { this.scroll = scroll; this.inset = 0; this.sink = null; this.look = {}; this.list = document.createElement('div'); }
  setLook() {}
  apply() {}
  touch() {}
  hideTip() {}
  tipAtPoint() {}
  atBottom() { return true; }
  scheduleClip() {}
  stop() {}
}
