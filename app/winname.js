// The name of a translation window: the one the user gave it, else a default (main / voice / window N). Shown in the window's title bar
// and its title in the taskbar, in the options (list of windows).
import { tr } from './core/i18n.js';
export const defaultName = id => (id === 1 ? tr('메인') : id === 2 ? tr('음성인식') : tr('창 {n}', { n: id }));
export const windowName = (id, conf) => ((conf && typeof conf.name === 'string' && conf.name.trim()) || defaultName(id));
export const windowTitle = (id, conf) => `ChatMatrix - ${windowName(id, conf)}`;
