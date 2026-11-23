// Colours of the chat text, and the HTML of a link tooltip. Port of theme.py: the colour of a line is the colour of its chat type
// (the game lets the user choose them; the addon sends the choice with every line as `base`), the pieces that have a meaning of
// their own (item links, class names, <guilds>, pings) have theirs.
import * as chattext from './chattext.js';

export const DIM = '#8a8d93';
export const TAG_COLORS = {
  say: '#ffffff', party: '#aaaaff', raid: '#ff8000', guild: '#40ff40', officer: '#40bf40', whisper: '#ff80ff', channel: '#ffc0c0',
  community: '#80d0d0', other: '#aaaaaa', restricted: '#777777', system: DIM, trans: '#7fd6b0', error: '#d67f7f',
  yell: '#ff4040', emote: '#ff8040', raidwarning: '#ff4800', bnet: '#00fff6', partyleader: '#75c7ff', raidleader: '#ff480a',
};
export const OTHER_COLORS = {
  '!SY': '#ffff00', '!IG': '#ff0000', '!XP': '#6f6fff', '!HN': '#f0b300', '!RP': '#8080ff', '!SK': '#5555ff',
  '!LT': '#00aa00', '!CY': '#00aa00', '!MN': '#ffff00', '!CI': '#8080ff', '!AC': '#ffff00', '!GA': '#40ff40',
  '!OP': '#8080ff', '!PI': '#8080ff', '!TS': '#ffffff', '!BH': '#ff4040', '!BA': '#4090ff', '!BN': '#ffa040',
  '!MS': '#ffff9e', '!MY': '#ff4040', '!ME': '#ff8040', '!MW': '#ffb5f0', '!MP': '#aaaaff', '!BE': '#ffdd00', '!BW': '#ffdd00',
  '!UN': '#b8b8b8', '!AD': '#ffffff', '!CL': '#bf8080', '!PG': '#ff5050', '!BI': '#66ccff', '!CN': '#ffc0c0', '!VC': '#9fe8ff', '!PLG': '#c9b6ff',
  '!TI': '#ffff00', '!TM': '#ffff00',
};
export const PING_COLORS = { '◈': '#4da3ff', '⚑': '#4ddc6b', '⚠': '#ff4545', '⚔': '#ff9a2e', '▼': '#4da3ff' };
export const PROTECTED_MARK = chattext.QUALITY_COLORS[51];
export const GUILD = chattext.QUALITY_COLORS[2];

const has = (o, k) => Object.hasOwn(o, k);

// the key of TAG_COLORS (or OTHER_COLORS) a channel code has its colour under
export function channelTag(code) {
  if (code === 'Y') return 'yell';
  if (code === 'E') return 'emote';
  if (code === 'RW') return 'raidwarning';
  if (code === 'B' || code === 'BT') return 'bnet';
  if (code.startsWith('!')) return has(OTHER_COLORS, code) ? code : 'other';
  const m = { S: 'say', P: 'party', PL: 'partyleader', R: 'raid', I: 'raid', RL: 'raidleader', IL: 'raidleader', G: 'guild', O: 'officer', W: 'whisper', WT: 'whisper', CM: 'community' };
  return has(m, code) ? m[code] : code.startsWith('C') ? 'channel' : 'other';
}

// the colour of a style (a channel code, or "trans" / "error" / "restricted" / "system") before the game says otherwise
export function defaultColor(style) {
  if (has(TAG_COLORS, style)) return TAG_COLORS[style];
  if (has(OTHER_COLORS, style)) return OTHER_COLORS[style];
  const tag = channelTag(style);
  return has(TAG_COLORS, tag) ? TAG_COLORS[tag] : TAG_COLORS.other;
}

// the colour of a chat type: the one the game's chat settings have now (base = palette code, -1 = the game's default)
export const typeColor = (code, base) => (base >= 0 && has(chattext.QUALITY_COLORS, base) ? chattext.QUALITY_COLORS[base] : defaultColor(code));

// the colour of one piece of a line: its own (item quality, class, guild, ping ...) or the colour of the line
export function pieceColor(piece, blockColor) {
  if (piece.quality !== null && has(chattext.QUALITY_COLORS, piece.quality)) return chattext.QUALITY_COLORS[piece.quality];
  switch (piece.role) {
    case 'sender': if (piece.cls !== null && has(chattext.CLASS_COLORS, piece.cls)) return chattext.CLASS_COLORS[piece.cls]; break;
    case 'guild': return GUILD;
    case 'protmark': return PROTECTED_MARK;
    case 'ping': return has(PING_COLORS, [...piece.text][0] ?? '') ? PING_COLORS[[...piece.text][0]] : blockColor;
    default: break;
  }
  return blockColor;
}

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

// the tooltip of an item link as small HTML (a table: left text, and the right-hand text some lines have, e.g. "Head   Plate")
// `wide` (the windows of the 3.x program): a line without a right-hand text is one cell over both columns. The empty second cell the 2.x table has (the golden tests keep that form) would take the room of the
// right-hand column in a line of its own too, and the text of a long line would break far before the right edge of the tip.
export function tipHtml(lines, wide = false) {
  const spans = text => chattext.tipRuns(text).map(([t, code]) =>
    `<span style="color:${has(chattext.QUALITY_COLORS, code) ? chattext.QUALITY_COLORS[code] : '#ffffff'}">${escapeHtml(t)}</span>`).join('');
  const rows = lines.map(line => {
    const i = line.indexOf(chattext.TIP_RIGHT);
    const left = i < 0 ? line : line.slice(0, i), right = i < 0 ? '' : line.slice(i + 1);
    if (i < 0 && wide) return `<tr><td colspan=2>${spans(left)}</td></tr>`;
    return `<tr><td>${spans(left)}</td>${i >= 0 ? `<td align="right">${spans(right)}</td>` : '<td></td>'}</tr>`;
  });
  return `<table cellspacing=0 cellpadding=1>${rows.join('')}</table>`;
}
