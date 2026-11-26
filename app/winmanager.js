// The translation windows of the program (the hub runs this): which extra windows exist (config.child_windows), which of them are open,
// where they stand. The window "main" is made by the exe at start; the others get the label "win<id>" (core/winlayout.js). Port of
// winmanager.py. The windows themselves only report ('win-closed', 'win-geometry'); everything that changes the settings is done here.
import * as winconf from './core/winconf.js';
import * as layout from './core/winlayout.js';
import { log } from './core/log.js';
import { windowTitle } from './winname.js';

const { emit, listen } = window.__TAURI__.event;
const invoke = window.__TAURI__.core.invoke;
export const ALL = [...winconf.KNOWN, winconf.ETC];

export function startWindows({ settings }) {
  const open = new Set();                      // ids of the extra windows that are open now
  const manual = new Set();                    // opened by hand (open mode "직접 열 때만")
  const closedBy = new Map();                  // id -> the open mode it had when the user closed it with the X (only for now: see below)
  let pluginCheck = null;                      // (owner, name) -> may the window of this plugin be open now? (set by plugin_host.js)
  let ocrOn = false;                           // the OCR assist is on
  let voiceOn = false;                         // the voice recognition is on (or starting)
  const children = () => settings.cfg().child_windows;
  const conf = id => children().find(c => c.id === id);
  const publishState = () => emit('win-state', { open: [...open] });      // (only the windows that have a window of their own)

  // The windows that are neither on top nor above the game (winconf.windowMode 0) are windows of the SYSTEM (their own frame, task bar button, snapping: center.js `native`, main.rs native_open). The others are panes
  // of a control center. Here: the system's windows follow the open ones and the settings (a window that changes its kind goes from one to the other, with its place: the saved geometry is the same text area).
  const natives = new Set();                   // ids that have a window of the system now
  const nativeConf = id => (id === 1 ? { name: settings.cfg().main_name } : conf(id));
  const nativeGeo = id => (id === 1 ? settings.cfg().geometry : (conf(id) || {}).geometry);
  function syncNative() {
    const cfg = settings.cfg(), want = new Set();
    for (const id of [1, ...open]) if (winconf.windowMode(cfg, id) === 0) want.add(id);
    for (const id of want) if (!natives.has(id)) {
      natives.add(id);
      invoke('native_open', { id, title: windowTitle(id, nativeConf(id)), geometry: nativeGeo(id) || null }).catch(e => { natives.delete(id); log.warn(`독립 창을 열지 못했습니다 (창 ${id}): ${e}`); });
    }
    for (const id of [...natives]) if (!want.has(id)) { natives.delete(id); invoke('native_close', { id }).catch(() => {}); }
  }

  const setChildren = list => settings.set({ child_windows: list });
  const patchConf = (id, patch) => setChildren(children().map(c => (c.id === id ? { ...c, ...patch } : c)));

  // make the open windows match the settings
  let syncing = false, again = false;
  async function sync() {
    if (syncing) { again = true; return; }
    syncing = true;
    try {
      do {
        again = false;
        for (const c of children()) {
          if (c.kind === 'web') continue;                          // (a web window is the exe's own window, opened by the plugin: web_host.js)
          const want = !winconf.dockHost(children(), c.id) && (!c.owner || !!(pluginCheck && pluginCheck(c.owner, c.owner_win))) && layout.wantedOpen(c, manual, voiceOn, closedBy.get(c.id) === c.open_mode ? new Set([c.id]) : new Set(), ocrOn);
          if (want && !open.has(c.id)) {
            open.add(c.id);                                          // (the window is drawn by the control center of its order: center.js)
          } else if (!want && open.has(c.id)) open.delete(c.id);
        }
        for (const id of [...open]) if (!conf(id)) { open.delete(id); manual.delete(id); }   // (deleted)
      } while (again);
    } finally { syncing = false; publishState(); syncNative(); }
  }
  settings.onChange(() => { sync(); });

  const api = {
    // a new window (every channel, open at once); -> its id
    add(name = '') {
      const id = winconf.nextId(children());
      const c = { ...winconf.followConf(id, ALL), open_mode: 'always', name };
      setChildren([...children(), c]);
      return id;
    },
    remove(id) {                                    // (window 2 is the voice window: it stays)
      if (id < 2 || id === winconf.VOICE_ID || (conf(id) && conf(id).owner)) return;                  // (the window of a plugin is not deleted by hand: it goes with the plugin)
      manual.delete(id); closedBy.delete(id);
      setChildren(winconf.without(children(), [id]));
    },
    // What the user does to a window is only for now and does not touch the settings: the X closes it (an "always" window opens again when the program
    // is started again, a "voice" window the next time the voice recognition is turned on), and opening one by hand opens it.
    openWindow(id) { if (conf(id)) { manual.add(id); closedBy.delete(id); sync(); } },
    closeWindow(id) {
      manual.delete(id);
      const c = conf(id);
      if (c) closedBy.set(id, c.open_mode);
      sync();
    },
    // the voice recognition was turned on / off: the "only while it is on" windows follow it, also the ones that were opened by hand or closed with the X
    setVoice(on) {
      on = !!on;
      if (on === voiceOn) return;
      voiceOn = on;
      for (const c of children()) if (c.open_mode === 'voice') { manual.delete(c.id); if (closedBy.get(c.id) === 'voice') closedBy.delete(c.id); }
      sync();
    },
    // the OCR assist was turned on / off: the "only while it is on" windows follow it (the same as the voice recognition)
    setOcr(on) {
      on = !!on;
      if (on === ocrOn) return;
      ocrOn = on;
      for (const c of children()) if (c.open_mode === 'ocr') { manual.delete(c.id); if (closedBy.get(c.id) === 'ocr') closedBy.delete(c.id); }
      sync();
    },
    // (a window that is a tab of another one has no window of its own: it is open while its window is)
    isOpen: id => id === 1 || open.has(id) || (id > 1 && (h => h > 0 && (h === 1 || open.has(h)))(winconf.dockHost(children(), id))),
    openIds: () => [...open],
    sync,
    setPluginCheck: fn => { pluginCheck = fn; sync(); },
  };

  // what the windows and the options window tell
  listen('win-closed', ev => api.closeWindow(ev.payload.id));          // the X of an extra window: closed for now, the settings stay as they are
  const saveGeometry = (id, geometry) => {
    if (!layout.parseGeometry(geometry)) return;
    if (id === 1) { if (settings.cfg().geometry !== geometry) { log.info('창 위치 저장: 메인 ' + geometry); settings.set({ geometry }); } }
    else { const c = conf(id); if (c && c.geometry !== geometry) { log.info(`창 위치 저장: 창 ${id} ${geometry}`); patchConf(id, { geometry }); } }
  };
  listen('win-geometry', ev => saveGeometry(ev.payload.id, ev.payload.geometry));
  // a window of the system was moved or sized: it tells at every step, the settings are written after it stood still for a moment
  const geoTimers = new Map();
  listen('native-geometry', ev => {
    const { id, geometry } = ev.payload || {};
    clearTimeout(geoTimers.get(id));
    geoTimers.set(id, setTimeout(() => { geoTimers.delete(id); saveGeometry(id, geometry); }, 600));
  });
  // the X of the frame of a window of the system (the exe holds the window: the program decides): the main window ends the program (like the X of its bar), an extra one closes for now (like the X of its bar)
  listen('native-close', ev => { const id = Number((ev.payload || {}).id); if (id === 1) invoke('quit_request').catch(() => {}); else if (id > 1) api.closeWindow(id); });
  listen('win-command', ev => {
    const { cmd, id } = ev.payload;
    if (cmd === 'add') api.add(ev.payload.name || '');
    else if (cmd === 'remove') api.remove(id);
    else if (cmd === 'open') api.openWindow(id);
    else if (cmd === 'close') api.closeWindow(id);
  });
  listen('win-state-hello', () => publishState());

  sync();
  return api;
}
