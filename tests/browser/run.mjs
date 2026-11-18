// Draws the chat window in a real (headless) Chromium and compares the page with the model after every event.
//   node tests/browser/run.mjs            (needs Playwright; screenshots go to tests/browser/out/)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'tests', 'browser', 'out');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = server.address().port;

let failed = 0;
const ok = (c, msg) => { if (!c) { failed++; console.log('  FAIL: ' + msg); } };
const { chromium } = createRequire(import.meta.url)('playwright');
const watchdog = setTimeout(() => { console.log('FAIL: the run took more than 60 seconds (a page that waits for something that never comes?)'); process.exit(3); }, 60000);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 560, height: 420 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${port}/tests/browser/view.html`);
await page.waitForFunction(() => window.ready);

// the page must equal the model after every operation list
const result = await page.evaluate(async ({ look, swap }) => {
  const { ChatView, lookFrom, WindowFeed, MAIN, data } = window.cmr;
  document.getElementById('lines').replaceChildren();
  const cfg = { ...data.cfg, swap_trans: swap };
  const feed = new WindowFeed(MAIN, () => cfg);
  const view = new ChatView(document.getElementById('lines'));
  view.setLook(look);
  let bad = 0, first = '';
  for (const ev of data.events) {
    view.apply(feed.handle(ev), feed.model);
    const dom = [...view.list.children].map(e => e.textContent);
    const want = feed.model.blocks.map(b => b.pieces.map(p => p.text.replace(/️/g, '')).join(''));
    if (JSON.stringify(dom) !== JSON.stringify(want)) { bad++; if (!first) first = JSON.stringify([dom.slice(-3), want.slice(-3)]); }
  }
  // a look change redraws the same blocks
  view.setLook({ ...look, size: look.size + 2 }, feed.model);
  const after = [...view.list.children].map(e => e.textContent);
  return { bad, first, n: feed.model.blocks.length, rebuilt: JSON.stringify(after) === JSON.stringify(feed.model.blocks.map(b => b.pieces.map(p => p.text.replace(/️/g, '')).join(''))) };
}, { look: { size: 15, shadow: true, indent: 4, group_gap: 6 }, swap: false });
ok(result.bad === 0, `the page differs from the model after ${result.bad} events: ${result.first}`);
ok(result.rebuilt, 'a look change keeps the blocks');
console.log(`  ${result.n} blocks drawn, page == model after each of 150 events`);
await page.screenshot({ path: path.join(OUT, 'default.png') });

// other looks: they must at least draw without errors; screenshots to look at
const looks = {
  centered_swap: { look: { size: 14, align: 'center', shadow: false, trans_size: 12, trans_color: '#ffd27f', indent: 0 }, swap: true },
  bottom_fade: { look: { size: 13, bottom: true, fade_sec: 1, line_gap: 2, group_gap: -2, text_opacity: 0.8 }, swap: false },
};
for (const [name, v] of Object.entries(looks)) {
  await page.evaluate(async ({ look, swap }) => {
    const { ChatView, WindowFeed, MAIN, data } = window.cmr;
    const el = document.getElementById('lines');
    el.className = ''; el.replaceChildren();
    const feed = new WindowFeed(MAIN, () => ({ ...data.cfg, swap_trans: swap }));
    const view = new ChatView(el); view.setLook(look);
    for (const ev of data.events.slice(0, 40)) view.apply(feed.handle(ev), feed.model);
    window.view = view; window.feed = feed;
  }, v);
  if (name === 'bottom_fade') { await page.waitForTimeout(1500); }
  await page.screenshot({ path: path.join(OUT, name + '.png') });
}
// fading: after fade_sec + the fade time the oldest line is invisible but keeps its room
await page.waitForTimeout(3200);
const faded = await page.evaluate(() => { const k = window.view.list.children; return [k[0].style.visibility, k[0].getBoundingClientRect().height > 0, k[k.length - 1].style.visibility]; });
ok(faded[0] === 'hidden' && faded[1], 'an old line fades out but keeps its room');
// a touch (wheel, even with nothing to scroll) brings the lines back, counted from now
await page.evaluate(() => window.view.touch());
const back = await page.evaluate(() => window.view.list.children[0].style.visibility);
ok(back === '', 'touch: the faded lines are back');
// a new fade time counts from the moment it is set: the old lines do not vanish at once
await page.evaluate(() => window.view.setLook({ ...window.view.look, fade_sec: 5 }));
const kept = await page.evaluate(() => window.view.list.children[0].style.visibility);
ok(kept === '', 'a new fade time starts counting from now');

// the three spaces are separate: "줄 간격" (line_gap) is only between an original and its translation, "묶음 사이 간격" (group_gap) between groups, and
// "줄 높이" (line_h) between the rows of one text that wraps. The old way (one row height for everything) spread the rows of a long text with the first.
{
  const r = await page.evaluate(async () => {
    const { ChatView, WindowFeed, MAIN, data } = window.cmr;
    const el = document.getElementById('lines'); el.className = ''; el.replaceChildren(); el.style.height = '';
    const feed = new WindowFeed(MAIN, () => ({ ...data.cfg, swap_trans: false }));
    const view = new ChatView(el);
    const base = { size: 14, group_gap: 0, line_gap: 0, line_h: 0, indent: 0 };
    view.setLook(base);
    for (const ev of data.events.slice(0, 60)) view.apply(feed.handle(ev), feed.model);
    const kids = () => [...view.list.children];
    const hs = () => kids().map(k => k.getBoundingClientRect().height);
    const wrapped = () => { const h = hs(); const one = Math.min(...h.filter(x => x > 0)); return h.map((x, i) => [x, i]).filter(([x]) => x > one * 1.8).map(([, i]) => i); };
    const h0 = hs(), w0 = wrapped();
    view.setLook({ ...base, line_gap: 12 }, feed.model);
    const gapOnly = { heights: hs(), tops: kids().map(k => k.style.marginTop), lh: kids().map(k => k.style.lineHeight) };
    view.setLook({ ...base, line_h: 8 }, feed.model);
    const rowsOnly = { heights: hs(), tops: kids().map(k => k.style.marginTop), bottoms: kids().map(k => k.style.marginBottom), lh: kids().map(k => k.style.lineHeight),
      // where the text of consecutive blocks is: the room the row height adds above / below a block (half of it each) does not count
      glyphGaps: kids().slice(1).map((k, i) => k.getBoundingClientRect().top - kids()[i].getBoundingClientRect().bottom + 8) };
    const glyphGaps0 = (() => { view.setLook(base, feed.model); return kids().slice(1).map((k, i) => k.getBoundingClientRect().top - kids()[i].getBoundingClientRect().bottom); })();
    view.setLook({ ...base, group_gap: 9 }, feed.model);
    const groupOnly = kids().map((k, i) => [k.style.marginTop, feed.model.blocks[i].group]);
    return { n: kids().length, w0: w0.length, h0, gapOnly, rowsOnly, glyphGaps0, groupOnly, groups: feed.model.blocks.map(b => b.group) };
  });
  ok(r.w0 > 0, 'spacing: the test data has texts that wrap: ' + r.w0);
  const trIdx = r.groups.map((g, i) => (g ? -1 : i)).filter(i => i >= 0);
  ok(trIdx.length > 0 && trIdx.every(i => r.gapOnly.tops[i] === '12px') && r.gapOnly.tops.every((t, i) => r.groups[i] ? t === '' : true) && r.gapOnly.lh.every(l => l === ''), 'spacing: "줄 간격" is a space above the translation only, no row height');
  const wrappedStill = r.h0.every((h, i) => (r.groups[i] ? Math.abs(h - r.gapOnly.heights[i]) < 0.6 : Math.abs(h - r.gapOnly.heights[i]) < 0.6));
  ok(wrappedStill, 'spacing: "줄 간격" does not change the height of any text, so the rows of a long text keep their distance');
  ok(r.rowsOnly.lh.every(l => l.includes('8px')) && r.rowsOnly.heights.some((h, i) => h > r.h0[i] + 12), 'spacing: "줄 높이" makes the rows of a wrapping text farther apart');
  ok(r.rowsOnly.glyphGaps.length === r.glyphGaps0.length && r.rowsOnly.glyphGaps.every((g, i) => Math.abs(g - r.glyphGaps0[i]) < 0.6), 'spacing: "줄 높이" does not move a text toward / away from the text above or below it (the half it adds on each side is taken off the margins)');
  ok(r.groupOnly.every(([t, g]) => (g ? t === '9px' : t === '')), 'spacing: "묶음 사이 간격" is a space above each group');
}

// the newest line stays in view when the look changes while the window is at the bottom; one who reads above is left where he is
{
  const r = await page.evaluate(async () => {
    const { ChatView, WindowFeed, MAIN, data } = window.cmr;
    const el = document.getElementById('lines'); el.className = ''; el.replaceChildren(); el.style.height = '260px';
    const feed = new WindowFeed(MAIN, () => ({ ...data.cfg, swap_trans: false }));
    const view = new ChatView(el);
    const base = { size: 13, group_gap: 2, line_gap: 0, line_h: 0, indent: 0 };
    view.setLook(base);
    for (const ev of data.events.slice(0, 80)) view.apply(feed.handle(ev), feed.model);
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    el.scrollTop = el.scrollHeight; await frame();
    const out = {};
    view.setLook({ ...base, size: 22, line_h: 6 }, feed.model); await frame();
    out.grew = view.atBottom();                                          // a bigger text: still at the newest line
    view.setLook({ ...base, size: 11 }, feed.model); await frame();
    out.shrank = view.atBottom();
    el.style.height = '140px'; await frame(); await frame();
    out.smaller = view.atBottom();                                       // the window made smaller: still at the newest line
    el.scrollTop = 0; await frame();
    view.setLook({ ...base, size: 18 }, feed.model); await frame();
    out.reading = !view.atBottom() && el.scrollTop < 40;                // scrolled up: left alone
    el.style.height = ''; el.scrollTop = el.scrollHeight; await frame();
    return out;
  });
  ok(r.grew && r.shrank && r.smaller, 'scroll: at the newest line, a new look or a smaller window keeps it there: ' + JSON.stringify(r));
  ok(r.reading, 'scroll: one who reads above is not pulled to the bottom');
}

// "온전한 묶음만" / "보일 묶음 수": at the newest line the group that is cut at the top edge (or older than the number asked for) is hidden as a whole; reading above shows all
{
  const r = await page.evaluate(async () => {
    const { ChatView, WindowFeed, MAIN, data } = window.cmr;
    const el = document.getElementById('lines'); el.className = ''; el.replaceChildren(); el.style.height = '210px';
    const feed = new WindowFeed(MAIN, () => ({ ...data.cfg, swap_trans: false }));
    const view = new ChatView(el);
    const base = { size: 14, group_gap: 6, line_gap: 0, indent: 0, bottom: true };
    view.setLook(base);
    for (const ev of data.events.slice(0, 90)) view.apply(feed.handle(ev), feed.model);
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    el.scrollTop = el.scrollHeight; await frame();
    const kids = () => [...view.list.children];
    const starts = () => kids().filter((k, i) => k.dataset.g || i === 0);
    const shown = () => starts().filter(k => !k.classList.contains('cv-clip'));
    const edge = () => el.getBoundingClientRect().top;
    const out = {};
    const cutNow = () => starts().some(k => { const t = k.getBoundingClientRect().top; return t < edge() - 1 && k.getBoundingClientRect().bottom > edge() + 1; });
    for (let h = 180; h < 300 && !cutNow(); h += 7) { el.style.height = h + 'px'; el.scrollTop = el.scrollHeight; await frame(); }       // a height at which a group IS cut at the top
    out.off = kids().filter(k => k.classList.contains('cv-clip')).length;                        // nothing is hidden without the options
    out.cutBefore = cutNow();                                                                      // (the test means something)
    view.setLook({ ...base, whole: true }, feed.model); await frame();
    out.wholeShown = shown().length; out.wholeTops = shown().map(k => Math.round(k.getBoundingClientRect().top - edge()));
    out.newestShown = !kids().at(-1).classList.contains('cv-clip');
    el.scrollTop = 0; await frame();                                                              // reading above: all is shown
    out.readingClipped = kids().filter(k => k.classList.contains('cv-clip')).length;
    el.scrollTop = el.scrollHeight; await frame();
    out.backClipped = kids().filter(k => k.classList.contains('cv-clip')).length;
    view.setLook({ ...base, max_groups: 2 }, feed.model); await frame();
    out.max2 = shown().length;
    view.setLook({ ...base, max_groups: 3, whole: true }, feed.model); await frame();
    out.max3 = shown().length;
    view.setLook({ ...base, max_groups: 40, whole: true }, feed.model); await frame();
    out.max40 = shown().length; out.wholeSame = out.max40 === out.wholeShown;
    view.setLook({ ...base, whole: true }, feed.model); await frame();
    let plain = [];
    for (let h = 180; h < 330; h += 3) {                                                          // a height at which the oldest whole group starts in the top 18px (where a title bar would cover it)
      el.style.height = h + 'px'; el.scrollTop = el.scrollHeight; await frame(); await frame();
      plain = shown().map(k => Math.round(k.getBoundingClientRect().top - edge()));
      if (Math.min(...plain) >= 0 && Math.min(...plain) < 17) break;
    }
    view.inset = 18; view.scheduleClip(); await frame();                                          // a title bar covers the top 18px: the groups are judged below it
    out.insetTops = shown().map(k => Math.round(k.getBoundingClientRect().top - edge())); out.plainMin = Math.min(...plain); out.plain = plain;
    out.insetFewer = shown().length <= plain.length;
    view.inset = 0; view.scheduleClip(); await frame();
    out.backTops = shown().map(k => Math.round(k.getBoundingClientRect().top - edge()));
    view.setLook({ ...base, max_groups: 40, whole: true }, feed.model); await frame();
    el.style.height = '420px'; await frame(); await frame();                                      // a taller window: more groups fit
    out.taller = shown().length;
    el.style.height = '30px'; await frame(); await frame();                                       // a window smaller than one group: the newest group stays
    out.tiny = shown().length;
    view.setLook(base, feed.model); await frame();
    out.cleared = kids().filter(k => k.classList.contains('cv-clip')).length;
    el.style.height = '';
    return out;
  });
  ok(r.off === 0 && r.cutBefore, 'whole groups: nothing hidden without the options, and a group is cut at the top (so the test means something): ' + JSON.stringify({ off: r.off, cut: r.cutBefore }));
  ok(r.wholeShown >= 2 && r.newestShown && r.wholeTops.every(t => t >= -1), 'whole groups: only whole groups are shown (none starts above the top edge): ' + JSON.stringify({ n: r.wholeShown, tops: r.wholeTops }));
  ok(r.readingClipped === 0 && r.backClipped > 0, 'whole groups: reading above shows everything, back at the newest line they are hidden again: ' + JSON.stringify({ reading: r.readingClipped, back: r.backClipped }));
  ok(r.max2 === 2 && r.max3 === Math.min(3, r.wholeShown) && r.wholeSame, 'max groups: only the newest ones: ' + JSON.stringify({ max2: r.max2, max3: r.max3, max40: r.max40, whole: r.wholeShown }));
  ok(r.plainMin >= 0 && r.plainMin < 17 && r.insetTops.every(t => t >= 17) && r.insetFewer && r.backTops.join() === r.plain.join(), 'whole groups: a group starts under where a title bar would be (the test means something); with the bar over the top 18px none does; without it the same as before: ' + JSON.stringify({ plainMin: r.plainMin, inset: r.insetTops.slice(0, 3), back: r.backTops.slice(0, 3), plain: r.plain.slice(0, 3) }));
  ok(r.taller > r.wholeShown && r.tiny === 1 && r.cleared === 0, 'whole groups: a taller window shows more, a tiny window still shows the newest group, switched off all come back: ' + JSON.stringify({ taller: r.taller, tiny: r.tiny, cleared: r.cleared }));
}

// an old game font: the browser refuses the file as it is (a character map that points past the last glyph, a kern table that does not fit), and takes the
// copy that cleanFont makes. (The fixture is a tiny font of our own with those two faults: tools/make_broken_font.py.)
{
  const r = await page.evaluate(async () => {
    const { cleanFont } = await import('/app/core/sfnt.js');
    const buf = await (await fetch('/tests/fixtures/broken_font.ttf')).arrayBuffer();
    const tryLoad = async (name, b) => { try { const f = await new FontFace(name, b.slice(0)).load(); document.fonts.add(f); return true; } catch { return false; } };
    const out = { raw: await tryLoad('CmrRaw', buf) };
    const clean = cleanFont(buf);
    out.clean = !!clean && await tryLoad('CmrClean', clean);
    out.noHint = await tryLoad('CmrNoHint', cleanFont(buf, { hinting: false }));
    out.check = out.clean && document.fonts.check('16px CmrClean', 'A');
    return out;
  });
  ok(r.raw === false, 'old font: the browser refuses the faulty file as it is (so the test means something)');
  ok(r.clean === true && r.noHint === true && r.check === true, 'old font: the browser takes the cleaned copy: ' + JSON.stringify(r));
}

ok(errors.length === 0, 'page errors: ' + errors.join(' | '));
await browser.close(); server.close();
console.log(failed ? `${failed} failed` : '  browser checks passed');
clearTimeout(watchdog);
process.exit(failed ? 1 : 0);
