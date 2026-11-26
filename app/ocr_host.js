// OCR assist in the hub (control window): reads the region the user picked (a button of the OCR tab asks, by the event "ocr-read-region"), turns the picture into chat lines
// (core/ocr_flow.js) and puts them in the chat as lines of the OCR channel; the pipeline marks and translates them like the lines of any channel. The answer for the button goes
// back by "ocr-result". The window of the game is read the way the General tab says (capture_host.js), the reading is done by the AI server of the OCR tab.
import { readPicture, regionNow } from './core/ocr_flow.js';
import { findLines, groupLines } from './core/ocr_lines.js';
import { Watch, Recent, signatureOf, judge, steady, RESETTLE } from './core/ocr_auto.js';
import { sub } from './core/image.js';
import { BarScan } from './core/ocr_scan.js';
import { regionOf } from './core/ocr_state.js';
import { AiReader, WindowsReader, VisionReader } from './core/ocr_read.js';
import { encodeBGRA } from './imgenc.js';
import { ocrOn, reader, readerWhy, stripStamp } from './core/ocr.js';
import { tr } from './core/i18n.js';
import { log } from './core/log.js';

const TICK_MS = 250;                   // how often the picture is looked at while the reading is on
const MAX_PER_TICK = 8;                // at most this many new chat lines are read from one picture (a flood: the newest ones)
const SCALE = 2;                       // the picture of a line is made this many times as large for the model: small letters are easier to read larger

// (encode, reader, now, tickMs: given by the tests; the real ones are the defaults)
export function startOcr({ settings, capture, pipeline, publish, http, listen, emit, system, invoke = null, encode = encodeBGRA, reader: aiReader = null, winReader = null, visReader = null, now = () => performance.now() / 1000, tickMs = TICK_MS, oldWay = false }) {
  // oldWay: the older way of reading (comparing pictures, no bars) is switched off: without the bars of the addon nothing is read. The code stays (the tests switch it on), for later.
  const ai = aiReader || new AiReader({ http, getCfg: () => settings.cfg() });
  // Windows OCR (the exe reads: src-tauri/src/ocr_win.rs): the picture goes as it is, the reader makes it ready
  const win = winReader || (invoke ? new WindowsReader({ invoke, getCfg: () => settings.cfg() }) : null);
  // macOS Vision (the exe reads: src-tauri/src/ocr_mac.rs): the picture goes as a PNG, made here (the page has a canvas)
  const vis = visReader || (invoke ? new VisionReader({ invoke, getCfg: () => settings.cfg() }) : null);
  const useWin = () => reader(settings.cfg()) === 'windows' && !!win;
  const useVis = () => reader(settings.cfg()) === 'vision' && !!vis;
  const readable = cfg => reader(cfg) === 'ai' || (reader(cfg) === 'windows' && !!win) || (reader(cfg) === 'vision' && !!vis);           // (a way that can read now)
  // a picture of BGRA pixels (+ its geometry) -> { text, encMs, last } with the reader the options say (last: the time of the reading)
  const readFull = async (pic, geo) => {
    if (useWin()) { const text = await win.read(pic, geo); return { text, encMs: 0, last: win.last }; }
    if (useVis()) { const v0 = performance.now(), png = encode(pic, { scale: SCALE, format: 'png' }), encMs = performance.now() - v0; const text = await vis.read(png, geo); return { text, encMs, last: vis.last }; }
    const e0 = performance.now();
    const image = encode(pic, { scale: SCALE, format: 'png' });
    const encMs = performance.now() - e0, timing = {};
    const text = await ai.read(image, geo, timing);
    return { text, encMs, last: Object.keys(timing).length ? timing : ai.last };
  };
  const readPic = async (pic, geo) => (await readFull(pic, geo)).text;
  // how many readings go to the AI server at the same time (the options say; the server must be able to answer side by side, else it only makes them wait there). Windows OCR reads one at a time.
  const parallel = () => (useWin() || useVis() ? 1 : Math.min(4, Math.max(1, Math.round(Number(settings.cfg().ocr_ai_parallel) || 1))));
  let busy = false;
  let manualUntil = -1e9;                       // until when the engine of Windows OCR is kept up after a reading that nobody asked a restriction for (the tooltip of a listing, later the manual capture)
  const MANUAL_HOLD = 30;

  // A picture that is no chat line (the comment of a party finder listing, later the manual capture) -> its words in one piece (with the reader the options say; the AI with the prompt of the manual capture)
  const canRead = () => { const cfg = settings.cfg(); return ocrOn(cfg) && readable(cfg); };
  // can a picture be read as words now (the manual capture needs no switch: the reader of the options only has to be there) -> '' or why not (a text for the user)
  const freeProblem = () => {
    const cfg = settings.cfg();
    if (readable(cfg)) return '';
    return readerWhy(reader(cfg)) ? tr('고른 읽기 방식은 아직 만들고 있어서 읽지 못합니다. 지금은 "AI 서버"를 고르세요.') : tr('이 읽기 방식은 아직 읽을 수 없습니다.');
  };
  const readFree = async pic => {
    manualUntil = now() + MANUAL_HOLD;
    if (useWin()) return win.read(pic, {});
    if (useVis()) return vis.read(encode(pic, { scale: SCALE, format: 'png' }), {});
    return ai.read(encode(pic, { scale: SCALE, format: 'png' }), {}, null, { prompt: settings.cfg().ocr_cap_prompt, free: true });
  };

  // the region the user picked, now -> { count, skipped } or { error } (a text for the user)
  async function readRegion() {
    const cfg = settings.cfg();
    if (!ocrOn(cfg)) return { error: tr('먼저 OCR 기능을 켜세요 (OCR 기능 사용).') };
    if (!readable(cfg)) return { error: readerWhy(reader(cfg)) ? tr('고른 읽기 방식은 아직 만들고 있어서 읽지 못합니다. 지금은 "AI 서버"를 고르세요.') : tr('이 읽기 방식은 아직 구역 읽기를 지원하지 않습니다.') };
    if (!cfg.ocr_region) return { error: tr('읽을 구역이 없습니다. 먼저 "구역 고르기"로 구역을 고르세요.') };
    if (busy) return { error: tr('이미 읽고 있습니다. 끝나면 다시 눌러 주세요.') };
    const size = capture.clientSize();
    if (!size) return { error: tr('게임 창을 찾지 못했습니다 (게임이 켜져 있고 최소화되지 않았는지 확인하세요).') };
    const rect = regionNow(cfg.ocr_region, size);
    if (!rect) return { error: tr('읽을 구역이 올바르지 않습니다. 구역을 다시 고르세요.') };
    busy = true;
    try {
      const t0 = performance.now();
      const pic = await capture.grabClient(...rect);
      const out = await readPicture(pic, { keepCut: true, encode: p => p, read: (part, geo) => readPic(part, geo) });
      for (const text of out.lines.filter(t => stripStamp(t).trim())) publish(pipeline.onLine({ channel: '!OCR', id: 0, sender: '', text, cls: '', base: -1 }));
      log.info(`OCR 구역 읽기: ${rect[2]}x${rect[3]}, 줄 ${out.rows}개, 채팅 ${out.lines.length}개 읽음 (못 읽음 ${out.skipped.unreadable}), ${Math.round(performance.now() - t0)}ms`);
      return { count: out.lines.length, unreadable: out.skipped.unreadable, rows: out.rows };
    } catch (e) {
      log.warn('OCR 구역 읽기 실패: ' + String(e && e.message || e));
      return { error: tr('읽지 못했습니다: {e}', { e: String(e && e.message || e) }) };
    } finally { busy = false; }
  }

  // ---- the chat is restricted (the addon says so by a line "[restricted]" for each line it cannot give, and ends it with "@RS"): the region is looked at
  // every second; the lines that are new in it since the last look are read, shown in the chat as OCR lines unless the chat has them already (they came from the addon)
  const watch = new Watch(), recent = new Recent(), bars = new BarScan();
  const OLD_MIN = tickMs > 0 ? 1 : 0;                  // the picture comparison of the older way looks once a second (the timer is faster for the bars)
  let lastOld = -1e9, lastBars = -1e9, lastStatus = '', lastMarks = null;
  const nowSec = now;
  let prevSigs = null, session = null;
  pipeline.observe(line => {
    const ch = String(line.channel || ''), text = String(line.text ?? '');
    const entry = bars.onLine(line, nowSec());                            // (the ledger of the messages and the state of the chat window, for the way with the bars)
    // (with the numbers of the addon the reading begins by itself with the first "@RT" line of a restriction; the ledger of "[restricted]" lines is only for an older addon)
    if (text === '[restricted]') { if (!bars.useT() && !watch.on(nowSec())) bars.begin(entry ? entry.seq - 1 : undefined); watch.restricted(nowSec()); watch.line(); return; }
    if (ch === '@RT') { watch.keep(nowSec()); return; }                  // (a censored message of the first chat window, with its number: the reading is on)
    if (ch === '@RS') { watch.ended(nowSec()); return; }
    if (ch.startsWith('!') || ch.startsWith('@')) return;                                     // (voice, plugins, the OCR lines themselves)
    watch.line();
    recent.add(text, nowSec());
  });
  // a notice at most once a minute for the same thing (the game window goes away and comes back, the OCR starts again each time)
  const noted = {};
  const noteOnce = (key, text) => { const t = nowSec(); if (noted[key] === undefined || t - noted[key] > 60) { noted[key] = t; system(text); } };
  // The notices of the reading (it began / it is over): with the numbers of the addon the pipeline tells them in the place of the chat where the first censored message came and where the end line came (see
  // Pipeline.ocrHook); the older way tells them when its session begins / ends here. `announced`: the beginning has been told and the end not yet.
  let announced = false;
  const endText = () => 'ℹ ' + tr('OCR: 화면에서 읽기를 마쳤습니다');
  const endSession = () => { if (session && announced) system(endText()); announced = false; session = null; prevSigs = null; };

  // what is ready is shown in the order the messages came; what could not be read is told
  // Each censored message has its place in the chat from the moment its line "@RT" came (Pipeline.reserveOcr): what is read takes that place, however late; what could not be read says so there.
  function flush() {
    const { done, lost } = bars.collect(nowSec());
    for (const m of done) publish(pipeline.fillOcr(m.seq, m.text));
    let noPlace = 0;                                                    // (the older addon has no "@RT" lines: there is no place that says it, so it is told in a line of the program)
    for (const seq of lost) { const evs = pipeline.lostOcr(seq); if (evs.length) publish(evs); else noPlace++; }
    if (noPlace) system('⚠ ' + tr('OCR: 검열된 메시지 {n}줄을 읽지 못했습니다', { n: noPlace }));
  }
  const secs = v => (Number.isFinite(v) ? v.toFixed(2) : '?');
  // why the older way (comparing pictures) reads instead of the bars: said once for the same reason (a minute at the most)
  const whyNotAt = {};
  const whyNot = (code, a, b) => { const t = nowSec(); if (whyNotAt[code] === undefined || t - whyNotAt[code] > 60) { whyNotAt[code] = t; log.info(`OCR: ${code === 'region' ? `막대 경로를 쓸 수 없어 읽지 않습니다 — 읽을 구역을 계산하지 못함 (게임 창 ${a}, 애드온이 알려 준 화면 ${b})` : code === 'stale' ? `막대가 없어 읽지 않습니다 — 상태 줄(@CS)이 ${a}초 동안 오지 않음 (검열이 끝났거나 막대가 꺼짐)` : (oldWay ? '옛 애드온으로 보고 옛 그림 비교로 읽습니다' : '막대가 없어 읽지 않습니다') + ' — 상태 줄(@CS)을 받은 적이 없음 (애드온의 막대가 꺼져 있거나 옛 애드온)'}`); } };
  // the readings of the messages: the ones with the lowest number first, `parallel()` at the same time; what is ready is shown in the order of the numbers (the pictures of the messages are taken at once, the reading may be slow)
  const queue = [], idleWaiters = [];
  let running = 0;
  function enqueue(job) {
    job.created = nowSec();
    queue.push(job);
    queue.sort((a, b) => a.seq - b.seq);
  }
  function pump() {
    while (running < parallel() && queue.length) {
      const job = queue.shift();
      running++;
      run(job).finally(() => { running--; pump(); if (!running && !queue.length) while (idleWaiters.length) idleWaiters.shift()(); });
    }
  }
  async function run(job) {
    const created = job.created;
    try {
      const started = nowSec();
      const { text, encMs, last } = await readFull(job.pic, job.geo);
      const answered = nowSec();
      const m = last || {}, ms = v => (Number.isFinite(v) ? Math.round(v) : '?');
      const tok = m.usage ? `${m.usage.prompt_tokens ?? '?'}/${m.usage.completion_tokens ?? '?'}` : '-', said = m.stats && Object.keys(m.stats).length ? JSON.stringify(m.stats).slice(0, 160) : '-';
      log.info(`OCR 지연 #${job.seq}: @RT가 온 뒤 첫 스캔까지 ${secs(job.firstSeen - job.rtAt)}초 | 첫 스캔부터 읽기 작업까지 ${secs(created - job.firstSeen)}초 (${job.why === 'sight' ? '번호가 이어져서 바로' : job.why === 'still' ? '그림이 같아서' : job.why === 'max' ? '같음이 안 나와 최대 대기' : '다시 읽기'}) | 작업이 줄에서 기다린 시간 ${secs(started - created)}초 | 읽기 전체 ${secs(answered - started)}초 (${m.what || 'AI'}: 그림 만들기 ${ms(encMs)}ms, 요청 준비 ${ms(m.build)}ms, 전송~응답 ${ms(m.http)}ms, 답 정리 ${ms(m.parse)}ms, 요청 ${m.bytes ?? '?'}바이트, 토큰 ${tok}, 서버가 말한 것 ${said}) | 동시에 ${running}개 | @RT부터 합계 ${secs(answered - job.rtAt)}초 | ${job.geo.rows}줄`);
      bars.onRead(job.seq, text, nowSec());
    } catch (e) {
      bars.onReadFailed(job.seq);
      log.warn('OCR 막대 읽기 실패: ' + String(e && e.message || e));
      if (!session || ++session.errors === 1 || session.errors % 20 === 0) system('⚠ ' + tr('OCR: 읽지 못했습니다: {e}', { e: String(e && e.message || e) }));
    }
    flush();
  }
  // -> true when the bars took care of it (also when there was nothing to do), false when they cannot be used now (the older way then looks)
  // while the OCR reads the restricted lines from the bars, the pipeline does not write "chat is restricted" for each of them (the lines come as OCR lines, what could not be read is told)
  pipeline.quietRestricted = () => { const cfg = settings.cfg(); return ocrOn(cfg) && readable(cfg) && bars.fresh(nowSec()) && !!capture.clientSize(); };
  pipeline.ocrHook = {
    reading: () => pipeline.quietRestricted(),
    begin: () => { if (announced) return null; announced = true; return 'ℹ ' + tr('OCR: 채팅이 제한되어 화면에서 읽습니다'); },
    end: () => { if (!announced) return null; announced = false; return endText(); },
  };
  async function barsTick(size) {
    const region = regionOf(bars.state, size);
    if (!region) return false;
    const t = nowSec();
    if (bars.pending() === 0) { flush(); return true; }
    if (t - lastBars < 0.25) return true;
    lastBars = t;
    busy = true;
    try {
      const pic = await capture.grabClient(region.x, region.y, region.w, region.h);
      const res = bars.scan(pic, region, nowSec());
      if (res.status === 'ok' && lastMarks !== null && res.marks !== lastMarks) log.info(`OCR 막대 수 변화: ${lastMarks} → ${res.marks}개${res.debug ? ` (화면 막대 ${res.debug.screen}, 위 → 아래)` : ''}`);
      lastMarks = res.status === 'ok' ? res.marks : lastMarks;
      for (const l of res.lags || []) log.info(`OCR 매트릭스 지연 #${l.seq}: 막대가 먼저 보이고 ${secs(l.lag)}초 뒤에 @RT가 도착 (스캔 간격만큼 작게 나올 수 있음)`);
      for (const n of res.notes || []) log.info(n.kind === 'rows' ? `OCR 막대 진단: #${n.seq} 줄 수가 ${n.from} → ${n.to}로 바뀌어 그림을 다시 기준으로 삼음` : `OCR 막대 진단: #${n.seq} 줄 수는 같은데 그림이 달라짐 (거리 ${n.dist.toFixed(3)}, 같음은 0.05 미만)`);
      if (res.jobs.length || res.missed || res.status !== lastStatus) {
        const d = res.debug;
        log.info(`OCR 막대: ${res.status}, 막대 ${res.marks}개, 짝 ${res.paired}개, 새로 읽기 ${res.jobs.length}개, 놓침 ${res.missed}개${d && d.base !== undefined ? ` | 맨 아래 막대의 번호 ${d.base ?? '(못 맞춤)'}${d.matched !== undefined ? ` (맞은 줄 ${d.matched}, 대기 ${d.pending}, 잃음 ${d.lost}, 읽기 시작 전 ${d.before})` : ''}, 빨강 막대 자리(아래부터 0) ${d.red || '-'}` : ''}`);
      }
      if ((res.missed || (res.status === 'mismatch' && lastStatus !== 'mismatch')) && res.debug) {
        if (res.debug.base !== undefined) log.info(`OCR 막대 진단: 화면 막대 ${res.debug.screen} (위 → 아래) | @RT 번호 끝 ${res.debug.ledger} | 맨 아래 막대의 번호 ${res.debug.base ?? '(못 맞춤)'}${res.debug.matched !== undefined ? ` | 맞은 줄 ${res.debug.matched}, 줄 없는 빨강 막대: 잃음 ${res.debug.lost}, 아직 ${res.debug.pending}` : ''}`);
        else log.info(`OCR 막대 진단: 화면 막대 ${res.debug.screen} | 장부 끝 ${res.debug.ledger}${res.debug.paired !== undefined ? ` | 짝 ${res.debug.paired} (앞섬 ${res.debug.ahead}, 뒤짐 ${res.debug.behind}, 건너뜀 ${res.debug.skipped})` : ''}`);
      }
      lastStatus = res.status;
      for (const job of res.jobs) enqueue(job);
      pump();                                                            // (after all of them are in the queue: the lowest number goes first)
      flush();
    } catch (e) {
      log.warn('OCR 막대 스캔 실패: ' + String(e && e.message || e));
    } finally { busy = false; }
    return true;
  }

  // the engine of Windows OCR follows "when it works": resident = ready while the OCR is on; only when needed = ready from the start of a restriction until it is over (and some seconds more); always = ready
  // while the OCR is on. With the AI server there is no engine of ours. A reading that has no engine yet makes it itself (a little slower).
  let warmFailAt = -1e9;
  function manageEngine(cfg) {
    if (!win || typeof win.warm !== 'function') return;
    const wanted = ocrOn(cfg) && reader(cfg) === 'windows' && (cfg.ocr_when === 'resident' || watch.on(nowSec()) || nowSec() < manualUntil);
    if (wanted && !win.loaded && !win.loading && nowSec() - warmFailAt > 30) win.warm().catch(e => { warmFailAt = nowSec(); log.warn('OCR: Windows OCR 엔진을 올리지 못했습니다: ' + String(e && e.message || e)); });
    else if (!wanted && win.loaded && !win.loading && !running && !queue.length && !busy) win.release();
  }

  async function tick() {
    const cfg = settings.cfg();
    manageEngine(cfg);
    if (!ocrOn(cfg) || !readable(cfg)) { if (session) endSession(); watch.pending = 0; return; }
    if (watch.idle(nowSec())) { if (session) endSession(); if (bars.useT()) flush(); return; }       // (the places of messages that were not read go on to say so after the time is up)
    // no game window (the game is not running, or it is minimized): the OCR waits, with no notice and nothing kept; it starts again by itself when the window is back
    if (busy) return;
    const size = capture.clientSize();
    if (!size) { session = null; prevSigs = null; return; }
    if (!session) {
      session = { mode: cfg.ocr_when, errors: 0, warned: false, odd: 0, last: null };
      prevSigs = null;
      if (!bars.useT() && (oldWay || bars.fresh(nowSec()))) { announced = true; noteOnce(cfg.ocr_when, 'ℹ ' + tr('OCR: 채팅이 제한되어 화면에서 읽습니다')); }
    }
    // the addon tells the state of the chat window and hangs bars beside the messages: the restricted ones are read from where the bars are (docs/HANDOFF.md 4-0g)
    // An addon that gives the bars (it has sent a state line once): without them nothing is read, whatever time of the watching is left (the restriction is over, the test /cm marks all is off,
    // the loading screen...). Only the older addon, which never sent one, is read by comparing pictures.
    if (bars.fresh(nowSec())) {
      if (await barsTick(size)) return;
      whyNot('region', `${size.width}x${size.height}`, `${bars.state.pw}x${bars.state.ph}`);
      return;
    }
    if (bars.state) { whyNot('stale', Math.round(nowSec() - bars.stateAt)); return; }
    whyNot('none', 0);
    // the addon has never given the state of the chat window: the bars are off in the addon (/cm marks on), or the addon is too old. Said once (at most once a minute).
    if (!oldWay) { noteOnce('nobars', '⚠ ' + tr('OCR: 애드온에서 막대가 오지 않아 읽을 수 없습니다. 게임에서 /cm marks on 으로 막대를 켜고, 애드온이 최신 버전인지 확인하세요.')); return; }
    if (nowSec() - lastOld < OLD_MIN) return;
    lastOld = nowSec();
    if (!cfg.ocr_region) { if (!session.warned) { session.warned = true; system('⚠ ' + tr('OCR: 읽을 구역이 없어 읽지 못합니다. OCR 탭에서 구역을 고르세요.')); } return; }
    const rect = regionNow(cfg.ocr_region, size);
    if (!rect) return;
    busy = true;
    try {
      const pic = await capture.grabClient(...rect);
      const grabAt = nowSec();
      const grouped = groupLines(findLines(pic.px, pic.width, pic.height));
      const msgs = grouped.filter(m => !m.continued && !m.cutTop && !m.cutBottom);
      const rowsInfo = { cont: grouped.filter(m => m.continued).length, cut: grouped.filter(m => !m.continued && (m.cutTop || m.cutBottom)).length };      // (a line that is cut by the edge is read when it is whole)
      const sigs = msgs.map(m => signatureOf(pic, m.coreTop, m.coreBottom));
      // only a picture that can be trusted is read, and only a trusted one is what the next is compared with (see judge)
      let first;
      if (!prevSigs || !prevSigs.length) {
        // the first picture (or the one after a chat with no line in it: a chat that faded away has no line to be compared with): trusted when the next one is the same
        const ok = steady(session.last, sigs); session.last = sigs;
        if (!ok) return;
        first = Math.max(0, msgs.length - Math.max(1, watch.pending));
      } else {
        const budget = watch.arrived + 1;
        const j = judge(prevSigs, sigs, budget);
        if (!j.ok && session.odd % 5 === 0) log.info(`OCR 판정: 믿지 않음 (이전 ${prevSigs.length}줄, 지금 ${sigs.length}줄, 겹침 ${j.first}, 새 줄 ${j.n} > 허용 ${budget})`);
        if (!j.ok) {                                                      // (covered, or the chat changed in a way that is not a new line: not read, not kept)
          session.odd = steady(session.last, sigs) ? session.odd + 1 : 1; session.last = sigs;
          if (session.odd >= RESETTLE) { log.info('OCR: 채팅창 모양이 바뀐 것으로 보고 기준 그림을 다시 만듭니다'); prevSigs = sigs; session.odd = 0; session.last = null; watch.trusted(); }
          return;
        }
        session.odd = 0; session.last = null; first = j.first;
      }
      if (msgs.length - first > 0) log.info(`OCR 판정: 이전 ${prevSigs ? prevSigs.length : '-'}줄, 지금 ${sigs.length}줄 (잘린 줄 ${rowsInfo.cut}, 이어지는 줄 ${rowsInfo.cont} 뺌), 새 줄 ${msgs.length - first}개`);
      prevSigs = sigs; watch.trusted();
      let fresh = msgs.slice(first);
      if (fresh.length > MAX_PER_TICK) fresh = fresh.slice(-MAX_PER_TICK);
      for (const m of fresh) {
        const part = sub(pic, 0, m.top, pic.width, m.bottom - m.top + 1);
        const text = await readPic(part, { w: pic.width, rows: m.lines.length, lineH: Math.max(...m.lines.map(l => l.core[1] - l.core[0] + 1)) });
        if (!text) continue;
        if (recent.take(text, nowSec())) { log.info(`OCR: 애드온이 방금 준 줄이라 한 번만 보입니다 | ${text.slice(0, 60)}`); continue; }          // (the addon's line is on the screen: shown once)
        watch.pending = Math.max(0, watch.pending - 1);
        publish(pipeline.onLine({ channel: '!OCR', id: 0, sender: '', text, cls: '', base: -1 }));
      }
      bars.handledUntil(grabAt + 0.4);                                    // (the way with the numbers does not read again what this picture showed: their lines come a moment after the message is drawn)
      session.errors = 0;
    } catch (e) {
      log.warn('OCR 자동 읽기 실패: ' + String(e && e.message || e));
      if (++session.errors === 1 || session.errors % 20 === 0) system('⚠ ' + tr('OCR: 읽지 못했습니다: {e}', { e: String(e && e.message || e) }));
    } finally { busy = false; }
  }
  const timer = tickMs > 0 ? setInterval(() => { tick().catch(e => log.warn('OCR 자동 읽기 오류: ' + String(e && e.message || e))); }, tickMs) : null;

  if (listen) listen('ocr-read-region', async () => emit('ocr-result', await readRegion()));
  return { readRegion, readFree, canRead, freeProblem, tick, bars, whenReady: () => (running || queue.length ? new Promise(res => idleWaiters.push(res)) : Promise.resolve()), stop: () => { if (timer) clearInterval(timer); } };
}
