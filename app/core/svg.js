// The picture of a widget (kind "icon") that a plugin gives as SVG: a text, or a .svg file of the plugin's folder. It is drawn as an <img> from a data address, where a picture cannot run
// a script or fetch anything; this cleaning is done besides, so that nothing that does not belong in a picture reaches the page at all.
export const MAX_SVG = 8000;                    // a text that a plugin gives in a state
export const MAX_SVG_FILE = 32000;              // a file of the plugin's folder

// -> the cleaned text, or '' when it is not an SVG (or too big)
export function cleanSvg(text, max = MAX_SVG) {
  if (typeof text !== 'string') return '';
  let s = text.replace(/^﻿/, '').trim();
  if (!s || s.length > max) return '';
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s) && !/\/>\s*$/.test(s)) return '';
  // no script, no foreign content, no style sheets: a picture. An element with its end tag goes whole; what is left of such tags (a single one) goes too.
  const BAD = '(?:script|foreignObject|iframe|object|embed|audio|video|canvas|style|animate|set|handler)';
  s = s.replace(new RegExp(`<(${BAD})\\b[^>]*\\/>`, 'gi'), '');
  s = s.replace(new RegExp(`<(${BAD})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');
  s = s.replace(new RegExp(`<\\/?${BAD}\\b[^>]*>`, 'gi'), '');
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');                                                                  // onclick= ...
  // an address inside the picture may only be a part of the picture itself (#id) or a picture that is data
  s = s.replace(/\s+(xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _x, _q, a, b) => { const v = (a ?? b ?? '').trim(); return /^#/.test(v) || /^data:image\/(png|jpeg|gif|webp);/i.test(v) ? m : ''; });
  s = s.replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, 'none');                                                                              // (url(...) only to a part of the picture: url(#grad))
  s = s.replace(/javascript:/gi, '');
  if (!/^<svg[\s>]/i.test(s)) return '';
  if (!/xmlns\s*=/.test(s.slice(0, 400))) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');       // (an <img> needs it)
  return s;
}

// -> the address the <img> uses
export const svgSrc = clean => (clean ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(clean) : '');

// a path of a file in the plugin's folder: a plain relative name of an .svg file
export const svgPathOk = p => typeof p === 'string' && p.length <= 100 && /^[A-Za-z0-9_\-./]+\.svg$/i.test(p) && !p.includes('..') && !p.startsWith('/') && !p.includes('//');
