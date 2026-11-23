// What is left of things that are not there any more. The settings keep what a plugin (or a window of a plugin) had when the plugin is taken away: so that putting it back brings everything back, and
// so that nothing is lost by a plugin that is only away for a moment. This is how the options show it: "this is left of a plugin that is gone", and the way to take it away.
// `goneOwner(id)`: the plugin id has no folder now (the hub says so in 'plugin-state', the same as the tab 플러그인 shows).
import { tr } from '../core/i18n.js';

const { emit, listen } = window.__TAURI__.event;
let ids = new Set(), gone = new Set(), loaded = false, started = false;
const subs = new Set();
function start() {
  if (started) return; started = true;
  listen('plugin-state', ev => {
    const list = ev.payload.plugins || [];
    const next = new Set(list.filter(p => p.gone).map(p => p.id)), nids = new Set(list.map(p => p.id));
    const changed = !loaded || next.size !== gone.size || [...next].some(x => !gone.has(x)) || nids.size !== ids.size || [...nids].some(x => !ids.has(x));
    gone = next; ids = nids; loaded = true;
    if (changed) for (const f of [...subs]) f();
  });
  emit('plugin-hello', {});
}
// (a plugin that the state does not list at all is gone too: its window is all that is left; before the first answer nothing is called gone)
export const goneOwner = id => { start(); return !!id && loaded && (gone.has(id) || !ids.has(id)); };
export const onGoneChange = f => { start(); subs.add(f); return () => subs.delete(f); };

// the note on the card of a window of a plugin that is gone: what it is, what happens to it, how it is taken away (the button of the picker above)
export function goneNote(owner) {
  const box = document.createElement('div'); box.className = 'orphan-note';
  const p = document.createElement('p');
  p.textContent = tr('지워진 플러그인 "{id}"의 창 설정입니다. 그 플러그인을 다시 설치하면 이 설정이 그대로 쓰입니다. 더는 필요 없으면 위의 삭제 버튼으로 지울 수 있습니다.', { id: owner });
  box.append(p);
  return box;
}
