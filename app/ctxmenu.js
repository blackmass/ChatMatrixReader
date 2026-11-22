// The right-click menu of a pane (3.2): what it has depends on what was touched (a widget of a plugin, a tab, the text). It gives the list { text, fn, cls } ('sep' a line, 'off' grey and does
// nothing, 'on' has a tick); center.js draws it. The same jobs as the menu of a window of 3.1.1.
import { MAIN } from './core/pipeline.js';
import * as winconf from './core/winconf.js';
import { tr } from './core/i18n.js';
import { nameFor } from './winname.js';

export function menuList({ cfg, pane, ev, open }) {
  const list = [], add = (text, fn, cls = '') => list.push({ text, fn, cls });
  // the tab that was clicked with the right button (its name, without being shown first); anywhere else: the tab that is shown
  const tabEl = ev.target.closest && ev.target.closest('.ptab');
  const target = pane.chats.get(tabEl ? Number(tabEl.dataset.chat) : pane.active) || pane.chats.get(pane.id);
  const openOptions = () => invoke('open_options').catch(e => pane.note(tr('옵션 창: {e}', { e })));
  // a widget of a plugin under the mouse: its own items first, then the settings of the plugin
  const wi = pane.widgets.itemOf(ev.target);
  if (wi && wi.owner && wi.owner !== 'core') {
    for (const m of wi.menu) add(m.label, () => emit('widget-action', { id: wi.id, type: 'menu', item: m.id }));
    add(tr('플러그인 설정…'), () => {
      try { localStorage.setItem('cmr-plugin-sel', wi.owner); localStorage.setItem('cmr-options-tab', 'plugins'); } catch { /* the options open as they were */ }
      openOptions();
    });
    return list;                                           // (the menu of a widget of a plugin is only its own: the items of the window are not mixed in)
  }
  add(tr('이 창의 옵션…'), () => {
    try { localStorage.setItem('cmr-options-win', String(target.id)); } catch { /* the options open on the first window */ }
    openOptions();
  });
  const picked = getSelection().toString();
  add(tr('선택한 글 복사'), () => { try { window.__TAURI__.clipboardManager.writeText(picked); } catch { document.execCommand('copy'); } }, picked ? '' : 'off');
  add(tr('창 비우기'), () => target.view.apply(target.feed.clear(), target.feed.model));
  // merging: a tab leaves its window; a window (that has no tabs of its own and is not the main one) becomes a tab of another
  {
    const kids = cfg.child_windows, setDock = (id, to) => emit('cfg-patch', { patch: { child_windows: kids.map(c => (c.id === id ? { ...c, dock_to: to } : c)) } });
    const hostOf = winconf.dockHost(kids, target.id);
    if (hostOf) add(tr('이 탭 독립시키기'), () => setDock(target.id, 0));
    if (target.id !== MAIN && !winconf.dockedOf(kids, target.id).length) {
      for (const h of [MAIN, ...kids.filter(c => c.kind !== 'web').map(c => c.id)]) {
        if (h === target.id || h === hostOf || (h !== MAIN && winconf.dockHost(kids, h)) || (h !== MAIN && Number(kids.find(c => c.id === h).dock_to) > 0)) continue;
        add(tr('{name} 창의 탭으로 붙이기', { name: nameFor(cfg, h) }), () => setDock(target.id, h));
      }
    }
  }
  list.push({ cls: 'sep' });
  for (const id of [MAIN, ...cfg.child_windows.filter(c => c.kind !== 'web').map(c => c.id)]) {
    if (id !== pane.id && pane.chats.has(id)) { add(nameFor(cfg, id), () => pane.activate(id), id === pane.active ? 'on' : ''); continue; }       // (a tab of this window: a click shows it)
    if (winconf.dockHost(cfg.child_windows, id)) { add(nameFor(cfg, id), null, 'off'); continue; }       // (a tab of another window)
    const isOpen = id === MAIN || open.has(id);
    add(nameFor(cfg, id), () => emit('win-command', { cmd: isOpen ? 'close' : 'open', id }), (isOpen ? 'on' : '') + (id === MAIN ? ' off' : ''));
  }
  return list;
}
