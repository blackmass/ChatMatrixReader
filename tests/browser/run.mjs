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
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 560, height: 420 }, deviceScaleFactor: 2 });
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

ok(errors.length === 0, 'page errors: ' + errors.join(' | '));
await browser.close(); server.close();
console.log(failed ? `${failed} failed` : '  browser checks passed');
process.exit(failed ? 1 : 0);
