// The widgets in the hub: the state of every widget in one place, passed on to the windows that show it (docs/WIDGETS.md "데이터 흐름").
//   publish(id, patch)   a source (the voice recognition, later a plugin) says how its widget is now
//   'widget-state' { id, state }   -> the windows;   'widget-hello' { ids } <- a window that needs the states now (it was opened, or turned a widget on)
// A state is only sent to the windows when some window of the settings shows that widget, so a reading that comes ten times a second costs nothing
// while nobody looks at it.
import { StateStore, usedIds, Registry } from './registry.js';

export function startWidgets({ settings, emit, listen }) {
  const store = new StateStore();
  const pluginDefs = new Registry();                    // what the plugins have registered (the pages have the program's own widgets themselves)
  const sendDefs = () => emit('widget-defs', { defs: pluginDefs.list() });
  const used = () => usedIds(settings.cfg());
  const api = {
    onAction: null,                                       // set by the plugin host: ({ id, type: 'click' | 'menu', item })
    store,
    registerDef(def) { const d = pluginDefs.register(def); sendDefs(); return d; },
    unregisterDef(id) { if (pluginDefs.unregister(id)) { store.map.delete(id); sendDefs(); } },
    defs: () => pluginDefs.list(),
    isUsed: id => used().has(id),
    publish(id, patch) {
      const state = store.set(id, patch);
      if (state && used().has(id)) emit('widget-state', { id, state });
      return state;
    },
  };
  listen('widget-defs-hello', () => sendDefs());
  listen('widget-action', ev => { const p = ev.payload; if (p && typeof p.id === 'string' && api.onAction) api.onAction(p); });      // (a click or a menu item in a window: whoever owns the widget is told)
  listen('widget-hello', ev => {
    for (const id of (ev.payload && ev.payload.ids) || []) { const st = store.get(id); if (st) emit('widget-state', { id, state: st }); }
  });
  return api;
}
