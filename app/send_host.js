// The send box wired to the world (the hub runs it): the keys and the game window come from the exe, the input line is the "input"
// window, the translation is the hub's translator. Port of SendIO in app.py. The state machine itself is core/sendbox.js.
import { SendBox } from './core/sendbox.js';
import * as outgoing from './core/outgoing.js';
import * as hotkeys from './core/hotkeys.js';
import { log } from './core/log.js';
import { tr } from './core/i18n.js';
import { every } from './core/timings.js';

const { emit, listen } = window.__TAURI__.event;
const invoke = window.__TAURI__.core.invoke;
const clipboard = window.__TAURI__.clipboardManager;
const VK_RETURN = 0x0D;

// settings: cfg(); translator: .translateOutgoing(cfg, text); capture: { game: {found, hwnd, title} }; system(text): a line in the main window
export function startSend({ settings, translator, capture, system }) {
  // one look at the keyboard per tick (all the questions of a tick are answered from it)
  let snap = null, snapAt = 0, snapKey = '';
  async function state(vk = 0) {
    const key = String(vk), now = performance.now();
    if (!snap || snapKey !== key || now - snapAt > 12) {
      snap = await invoke('os_state', { keys: [VK_RETURN, vk || VK_RETURN] }); snapAt = now; snapKey = key;
    }
    return snap;
  }
  const ours = s => (s.fgExe ? s.fgExe.startsWith('chatmatrix') : (s.fgTitle.startsWith('CMR') || s.fgTitle.startsWith('ChatMatrix')));

  let prefix = '';                                                           // the left field of the input line, taken with the Enter
  const io = {
    game: () => (capture.game.found ? { hwnd: capture.game.hwnd, title: capture.game.title || '' } : null),
    gameIsFront: async g => (await state(0)).fg === g.hwnd,
    selfIsFront: async () => ours(await state(0)),
    comboDown: async ([mods, vk]) => {
      const s = await state(vk);
      return [...mods].every(m => s[m.toLowerCase()] === true) && s.keys[1] === true;
    },
    returnDown: async () => (await state(0)).keys[0] === true,
    modsDown: async () => { const s = await state(0); return !!(s.shift || s.ctrl || s.alt); },
    openBox: async label => {
      try {
        const g = io.game();
        await emit('input-open', { label, target: g ? g.title : '' });
        await invoke('show_input', { label: 'main', place: settings.cfg().send_place || 'auto' });
        return true;
      } catch (e) { log.warn('보내기 입력줄: ' + e); try { await emit('input-close', {}); } catch { /* the box is hidden by the exe too */ } return false; }
    },
    closeBox: () => emit('input-close', {}),
    busyBox: text => emit('input-busy', { text }),
    readyBox: label => emit('input-ready', { label }),
    say: text => system(text),
    showSent: text => system('↗ ' + text),
    putClipboard: async text => { try { await clipboard.writeText(text); return true; } catch (e) { log.warn('클립보드: ' + e); return false; } },
    focusGame: async g => !!(await invoke('focus_window', { hwnd: g.hwnd, paste: false, delayMs: 0 })),
    paste: async () => !!(await invoke('send_paste')),
    nudgeGame: () => {}, endNudge: () => {},                                 // (macOS only)
    translate: (cfg, raw, done) => {
      outgoing.prepare(cfg, raw, (c, t) => translator.translateOutgoing(c, t), prefix)
        .then(res => done(res, null))
        .catch(e => {
          if (e instanceof outgoing.OutgoingError) return done(null, e.message);
          log.error('보내기 번역 실패: ' + (e?.stack || e));
          done(null, tr('번역 실패: {err}', { err: e?.message || String(e) }));
        });
    },
  };
  const box = new SendBox(io, () => settings.cfg());
  listen('input-submit', ev => { prefix = ev.payload.prefix || ''; box.submit(ev.payload.text); });
  listen('input-cancel', () => { box.cancel(); });
  const timer = every('SEND_TICK_MS', () => box.tick().catch(e => log.error('보내기 점검: ' + e)));
  return { box, stop: () => timer.stop() };
}
