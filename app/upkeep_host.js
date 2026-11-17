// What the hub keeps an eye on (core/upkeep.js says WHAT to do, this file does it): the connection check of the translation servers at
// start and when their settings change, the "send the prompt in advance" after the prompt / glossary changed, the note when the glossary was
// saved, the sample for a glossary file that does not exist yet. Every server is checked once, however many places (channels, sending)
// use it. Port of the warm_tick / translate_test of app.py.
import * as upkeep from './core/upkeep.js';
import { sendCfg, googleKey } from './core/translate.js';
import { onlySendingUses } from './core/translate_rules.js';
import { DEFAULT_PROMPT, DEFAULT_SEND_PROMPT } from './core/prompts.js';
import { DEFAULT_NAME, safeName } from './core/glossary.js';
import { log } from './core/log.js';
import { tr } from './core/i18n.js';
import { every } from './core/timings.js';


export const promptNoticeDue = cfg => {
  if (!(cfg.prompt_update_notice ?? true)) return false;
  const cur = (cfg.prompt || '').trim(), send = (cfg.send_prompt || '').trim();
  return (cur !== '' && cur !== DEFAULT_PROMPT.trim()) || (send !== '' && send !== DEFAULT_SEND_PROMPT.trim());
};

export function startUpkeep({ settings, translator, glossary, system }) {
  const cfg0 = settings.cfg();
  const conn = new upkeep.ConnWatch(cfg0), warm = new upkeep.WarmWatch(glossary, cfg0), gloss = new upkeep.GlossWatch(glossary, cfg0);
  let sampleName = null;                                   // a glossary file name seen once: it gets its sample when it is still the same next round

  // a tiny request with `mode`; says in the window whether it answered. quiet: the in-advance sending (a short note instead of the report)
  async function translateTest(mode, quiet = false) {
    let cfg = { ...settings.cfg() };
    if (!mode || mode === 'none') return;
    if (onlySendingUses(cfg, mode)) cfg = sendCfg(cfg);           // nothing else uses it: the check carries the prompt of the sending
    cfg.translator = mode;
    const who = mode === 'google' ? 'Google' + (googleKey(cfg) ? ' (API Key)' : '')
      : mode === 'custom' ? (cfg.custom_preset || cfg.custom_url || 'HTTP') : (cfg.api_model || cfg.api_url || 'AI');
    const t0 = performance.now();
    try {
      await translator.translate(cfg, 'hi');
      const ms = Math.trunc(performance.now() - t0);
      if (quiet) { log.info(`미리 보내기 완료: ${who} (${ms}ms)`); system('ℹ ' + tr('바뀐 프롬프트/단어장을 번역 서버에 미리 보내 두었습니다 ({ms}ms)', { ms })); }
      else system('✔ ' + tr('번역 서버 연결 양호: {who} ({ms}ms)', { who, ms }));
    } catch (e) {
      system('✖ ' + tr('번역 서버에 연결하지 못했습니다: {who}', { who }) + ' - ' + (String(e?.message || e) || 'Error').slice(0, 160));
    }
  }

  async function tick() {
    try {
      const cfg = settings.cfg();
      const name = (cfg.glossary_file || '').trim() || DEFAULT_NAME;       // a new file name: the sample becomes its first content
      if (safeName(name) && name !== sampleName) {
        sampleName = name;
        await glossary.ensureDefault(name);
      }
      const n = await gloss.check(cfg);
      if (n !== null) system('ℹ ' + tr('단어장을 다시 읽었습니다: {n}개 항목', { n }));
      const modes = conn.check(cfg);
      for (const m of modes) await translateTest(m);
      if (await warm.check(cfg, modes.length > 0)) await translateTest(upkeep.aiMode(cfg), true);
    } catch (e) { log.error('번역 설정 점검 실패: ' + (e?.message || e)); }
  }

  // at start: one connection check per server in use (when the option is on), and the prompt note
  (async () => {
    await new Promise(r => setTimeout(r, 800));
    if (promptNoticeDue(settings.cfg())) system('ℹ ' + tr("기본 프롬프트가 새로워졌을 수 있습니다. 옵션의 '단어장·프롬프트'에서 확인해 보세요. (이 알림은 그 탭에서 끌 수 있습니다)"));
    for (const m of conn.startModes(settings.cfg())) await translateTest(m);
    every('UPKEEP_TICK_MS', tick);
  })();

  return { translateTest, tick };
}
