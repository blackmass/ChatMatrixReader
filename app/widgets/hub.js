// The widgets in the hub: the state of every widget in one place, passed on to the windows that show it (docs/WIDGETS.md "데이터 흐름").
//   publish(id, patch)   a source (the voice recognition, later a plugin) says how its widget is now
//   'widget-state' { id, state }   -> the windows;   'widget-hello' { ids } <- a window that needs the states now (it was opened, or turned a widget on)
// A state is only sent to the windows when some window of the settings shows that widget, so a reading that comes ten times a second costs nothing
// while nobody looks at it.
import { StateStore, usedIds } from './registry.js';

export function startWidgets({ settings, emit, listen }) {
  const store = new StateStore();
  const used = () => usedIds(settings.cfg());
  const api = {
    store,
    isUsed: id => used().has(id),
    publish(id, patch) {
      const state = store.set(id, patch);
      if (state && used().has(id)) emit('widget-state', { id, state });
      return state;
    },
  };
  listen('widget-hello', ev => {
    for (const id of (ev.payload && ev.payload.ids) || []) { const st = store.get(id); if (st) emit('widget-state', { id, state: st }); }
  });
  return api;
}
