// The tabs, in the order of the side menu. `todo`: not made yet (shown dim, so the final shape is visible).
import general from './tab_general.js';
import exceptions from './tab_exceptions.js';
import windows from './tab_windows.js';
import translation from './tab_translation.js';
import glossary from './tab_glossary.js';
import send from './tab_send.js';
import voice from './tab_voice.js';
import advanced from './tab_advanced.js';
import plugins from './tab_plugins.js';
import about from './tab_about.js';

export const TABS = [
  general,
  windows,
  translation,
  glossary,
  exceptions,
  send,
  voice,
  plugins,
  advanced,
  about,
];
