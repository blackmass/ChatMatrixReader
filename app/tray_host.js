// The tray icon itself is made by the exe (it must exist even when this page fails); this only gives its menu the texts of the display language.
import { tr } from './core/i18n.js';

export function startTray() {
  const invoke = window.__TAURI__.core.invoke;
  const set = () => invoke('set_tray_text', { options: tr('옵션'), quit: tr('종료') }).catch(() => {});
  set();
  addEventListener('cmr-language', set);
}
