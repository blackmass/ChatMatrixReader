// The web addresses in a line of the chat (a party leader says "discord.gg/abc" and the others click it). Pure functions: the pieces of the line that are addresses
// (`findUrls`), the check that an address is one the program may send a browser to (`safeUrl`: every address passes it again in the exe), and the short form shown in the
// line (`label`). Nothing here opens anything: a click is only a question to the user (the window of the page asks "open?").

// The places people name without "https://" in the game. Only these are found when no scheme is there: any "word.word" would make a link of a file name (Naxx.exe) or a typing slip.
const KNOWN = ['discord.gg', 'discord.com', 'discordapp.com', 'youtu.be', 'youtube.com', 'twitch.tv', 'wowhead.com', 'warcraftlogs.com', 'raider.io', 'curseforge.com',
  'github.com', 'inven.co.kr', 'namu.wiki', 'naver.com'];
// An address stops at the first character that is not one an address has: a Korean particle stuck to it ("discord.gg/abc로") is not part of it.
const URL_CHARS = "A-Za-z0-9\\-._~:/?#@!$&'()*+,;=%";
const END_PUNCT = /[.,;:!?'"]+$/;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SCHEME = new RegExp(`https?://[${URL_CHARS}]+`, 'gi');
const BARE = new RegExp(`(?<![A-Za-z0-9@._-])(?:[a-z0-9-]+\\.)*(?:${KNOWN.map(esc).join('|')})(?:/[${URL_CHARS}]*)?(?![A-Za-z0-9-])`, 'gi');
export const MAX_URL = 500;

// "(see https://a.b/c)." : the dot and the bracket at the end belong to the sentence
function trim(s) {
  let t = s.replace(END_PUNCT, '');
  while (t.endsWith(')') && (t.match(/\(/g) || []).length < (t.match(/\)/g) || []).length) t = t.slice(0, -1).replace(END_PUNCT, '');
  return t;
}

// The addresses of a text: [{ start, end, url }] in order (url: what a browser is sent to, "https://" put in front of the ones said without it), only the ones safeUrl accepts.
export function findUrls(text) {
  const found = [];
  const take = (re, bare) => {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) {
      const raw = trim(m[0]);
      if (!raw) continue;
      const start = m.index, end = start + raw.length;
      if (found.some(f => start < f.end && end > f.start)) continue;
      if (bare && !/\/./.test(raw) && /^(?:[a-z0-9-]+\.)*(?:discord\.gg|youtu\.be|namu\.wiki)$/i.test(raw)) continue;      // (discord.gg alone is a word, not an invite)
      const url = safeUrl(bare ? 'https://' + raw : raw);
      if (url) found.push({ start, end, url });
    }
  };
  take(SCHEME, false);
  take(BARE, true);
  return found.sort((a, b) => a.start - b.start);
}

// The address the program may send a browser to, or null: http or https, no user name or password, the usual port, a name (never a number: the addresses of tracking and of the
// local network), written with the plain letters of its language (not a disguised one: the letters that look like others turn into "xn--"), short, no hidden characters.
export function safeUrl(text) {
  if (typeof text !== 'string' || text.length > MAX_URL || /[\u0000- \u007f"<>\\^`{|}]/.test(text)) return null;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.startsWith('[') || /^\d+(\.\d+)*$/.test(h) || /^0x/i.test(h) || h.split('.').some(p => p.startsWith('xn--'))) return null;
  if (!/^[a-z0-9.-]+$/.test(h) || h.startsWith('.') || h.endsWith('.')) return null;
  const href = u.href;
  return href.length > MAX_URL ? null : href;
}

// What the line shows for an address: [host/path], shortened. The whole address is in the tip and in the question that comes before opening it.
export function label(url, max = 40) {
  let t = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return '[' + t + ']';
}

// A piece of text split in order into [{ text }] and [{ text: label, url }]: what the line is drawn from.
export function split(text) {
  const out = [];
  let at = 0;
  for (const f of findUrls(text)) {
    if (f.start > at) out.push({ text: text.slice(at, f.start) });
    out.push({ text: label(f.url), url: f.url });
    at = f.end;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at) });
  return out;
}
