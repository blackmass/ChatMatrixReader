// Hotkey text ("Shift+Enter") <-> (modifiers, virtual-key) for the send box. Port of hotkeys.py (without the Tk key names:
// the options window will turn a KeyboardEvent into these names itself).
export const MODS = ['Ctrl', 'Alt', 'Shift'];
const KEYS = {
  Enter: 0x0D, Space: 0x20, Tab: 0x09, Backspace: 0x08, Insert: 0x2D, Delete: 0x2E, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  Left: 0x25, Up: 0x26, Right: 0x27, Down: 0x28, '`': 0xC0,
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = 0x6F + i;
for (let c = 65; c <= 90; c++) KEYS[String.fromCharCode(c)] = c;
for (let d = 0; d <= 9; d++) KEYS[String(d)] = 0x30 + d;
const ALIASES = { RETURN: 'Enter', ESC: null, CONTROL: 'Ctrl', CTL: 'Ctrl', PGUP: 'PageUp', PGDN: 'PageDown', DEL: 'Delete', INS: 'Insert', BACKSPACE: 'Backspace', SPACEBAR: 'Space' };
export const DEFAULT = 'Shift+Enter';
const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// 'shift + enter' -> [Set{'Shift'}, 0x0D]. Throws Error for anything unusable.
export function parse(text) {
  const mods = new Set();
  let key = null;
  for (const raw of String(text || '').replace(/ /g, '').split('+')) {
    if (!raw) continue;
    const up = raw.toUpperCase();
    const name = Object.hasOwn(ALIASES, up) ? ALIASES[up] : raw;
    if (name === null) throw new Error('Esc cannot be a hotkey');
    if (MODS.includes(cap(name)) || ['SHIFT', 'ALT', 'CTRL'].includes(up)) {
      mods.add(MODS.includes(cap(name)) ? cap(name) : { SHIFT: 'Shift', ALT: 'Alt', CTRL: 'Ctrl' }[up]);
      continue;
    }
    const found = Object.keys(KEYS).find(k => k.toUpperCase() === name.toUpperCase());
    if (found === undefined || key !== null) throw new Error(`unknown key: ${raw}`);
    key = found;
  }
  if (key === null) throw new Error('no key');
  return [mods, KEYS[key]];
}

export const formatCombo = (mods, keyName) => [...MODS.filter(m => mods.has(m)), keyName].join('+');

// canonical spelling ('ctrl+return' -> 'Ctrl+Enter'); throws if unusable
export function normalize(text) {
  const [mods, vk] = parse(text);
  return formatCombo(mods, Object.keys(KEYS).find(k => KEYS[k] === vk));
}
