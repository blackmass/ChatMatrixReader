import json
import os

import paths

from translator import DEFAULT_PROMPT, DEFAULT_REASONING_OFF, DEFAULT_SEND_PROMPT, LEGACY_DEFAULT_PROMPTS

PATH = os.path.join(paths.ROOT, "config.json")

DEFAULTS = {
    # translation
    "translator": "google",               # none | openai | google | custom
    "target_lang": "한국어",
    "language": "",                       # "" = system language, else a locale/<code>.txt name (ko-KR = built in)
    "api_url": "http://localhost:1234/v1",
    "api_model": "",
    "api_key": "",
    "custom_preset": "",                  # custom HTTP translator: preset name (informational) and the request settings
    "custom_key": "",
    "custom_url": "",
    "custom_headers": "{}",
    "custom_body_type": "json",           # json | form
    "custom_body": "",
    "custom_path": "",                    # where the translation is in the answer, e.g. translations.0.text
    "google_api_key": "",                 # optional; empty = free unofficial endpoint
    "prompt": DEFAULT_PROMPT,
    "extra_prompt": "",                   # the user's own additional instructions, added to the end of the prompt (style ...)
    "glossary_file": "Glossary.txt",      # relative to the main folder (next to the launchers), or an absolute path
    "glossary_google": True,              # also apply the glossary to Google translation
    "glossary_mode": "full",              # AI: full = the whole glossary in the prompt | list = the entries that occur in the line, before it | mixed = single meanings in parentheses, the rest listed
    "glossary_style": "paren",            # paren: LFM(구인) | replace: 구인
    "disable_reasoning": True,
    "reasoning_off_body": DEFAULT_REASONING_OFF,
    "temperature": 0.2,
    "timeout": 30,
    "max_tokens": 300,
    "skip_same_lang": True,
    "channel_route": {},                  # channel code -> "google_free" | "off" (missing = the translation tab's method)
    "hover_clear": False,             # click-through only: the window turns fully transparent while the mouse is over it
    "blur_experiment": False,         # Windows: blur what is behind the background window
    "blur_state": 3,                  # 3 = light blur, 4 = acrylic (stronger; tinted by the "background" opacity)
    "skip_regex_hide": False,        # also leave the matching lines out of the window (not only untranslated)
    "skip_regex": "",                # lines matching this regular expression are not translated (empty = off)
    "max_pending": 20,
    "log_request": False,            # write the full request (prompt) of every translation into the log
    "max_parallel": 2,
    # send box: type in your own language, get the translation on the clipboard
    "send_enabled": True,
    "send_lang": "English",
    "send_hotkey": "Shift+Enter",
    "send_show_log": False,               # show the translated text sent (the "↗" line) in the window; off: it comes back as a chat line
    "send_autopaste": False,              # press Ctrl+V in the game for you (off: you press it)
    "send_prompt": DEFAULT_SEND_PROMPT,
    "send_extra_prompt": "",              # the user's own additional instructions for the send translation
    # voice recognition (optional extension in extensions/stt, see voice.py)
    "voice_enabled": False,               # on: started with the program (and by the options)
    "voice_target": "discord",            # discord | discord-all | wow | system | app: whose sound is recognised (app: the program in voice_app)
    "voice_app": "",                      # the program picked from the list (file name, e.g. chrome.exe): remembered, used when voice_target is "app"
    "voice_lang": "auto",                 # language spoken in the voice chat ("auto" = detect for every sentence)
    "voice_mode": "sentence",             # sentence: one text when a sentence is finished | live: the text while it is spoken (Whisper: not recommended)
    "voice_partial_ms": 1000,             # live mode: how often the text so far is updated
    "voice_translate": True,              # translate what was said (with the translation tab's method)
    "voice_end_ms": 700,                  # quiet time (ms) that ends a sentence
    "voice_device": "auto",               # auto | cuda | cpu
    "voice_model": "",                    # "" = the extension's default (large-v3-turbo)
    "voice_max_s": 12,                    # longest piece of speech recognised at once (longer speech is cut there)
    "voice_engine": "whisper",            # whisper (on this PC) | openai (a server with the OpenAI speech-to-text API)
    "voice_oa_url": "",                   # openai: e.g. http://localhost:8000/v1
    "voice_oa_key": "",                   # openai: API key (empty = none; sent to the child through its environment)
    "voice_oa_model": "",                 # openai: model name on that server ("" = whisper-1)
    "voice_oa_format": "json",            # openai: json | verbose_json
    "voice_oa_timeout": 30,               # openai: seconds to wait for the server
    # window
    "bg_opacity": 1.0,                    # background (the dark area)
    "text_opacity": 1.0,                  # text, title bar, scrollbar
    "topmost": True,                      # above every other window
    "exit_with_game": False,              # quit this program 5 s after the game has been closed
    "topmost_wow_only": False,            # only just above the game window, behind all other windows
    "wow_window_title": "World of Warcraft",
    "interact_keys": ["Shift"],           # click-through: this window takes the mouse while ALL of these keys are held (Shift / Ctrl / Alt)
    "click_through": False,
    "font_size": 11,
    "shadow_on": False,                   # draw a copy of the text in shadow_color, shifted by (shadow_dx, shadow_dy)
    "shadow_color": "#000000",
    "shadow_dx": 1,
    "shadow_dy": 1,
    "translate_test_start": True,         # at start, send a tiny test request so the user sees whether the translation server answers
    "check_updates": True,                # look for a newer GitHub release at start (a notice only, nothing is installed)
    "font_family": "",                    # "" = default (Malgun Gothic); else a font loaded from the fonts/ folder
    "line_spacing": 0,                    # pixels between chat lines (inside a group: an original line and its translation)
    "group_spacing": 4,                   # extra pixels between groups (an original line + its translation)
    "trans_color": "",                    # colour of the translated text ("" = default)
    "swap_trans": False,                  # translation above, the original below it (in the second-line colour / size)
    "trans_font_size": 0,                 # size of the translated text (0 = same as the original)
    "class_colors": True,                 # colour the speaker's name by class (needs the addon to send the class)
    "channel_detail": False,              # show the line codes "(S) (W→) (C1) (!LT)" as before; off: only "(1)" for numbered channels
    "show_time": True,                    # prefix every line with the time it was read
    "max_lines": 500,
    "geometry": "560x420",
    # capture
    "poll_hz": 30,
    "last_pos": None,                     # [x, y] where the matrix was found last time (looked at first, every second)
    "full_scan_sec": 30,                  # whole-screen search while the matrix is missing: at most this often (seconds)
}


def load():
    cfg = dict(DEFAULTS)
    try:
        with open(PATH, "r", encoding="utf-8") as f:
            saved = json.load(f)
        cfg.update(saved)
        if "opacity" in saved and "bg_opacity" not in saved:      # settings from the older single-slider version
            cfg["bg_opacity"] = cfg["text_opacity"] = saved["opacity"]
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    cfg.pop("opacity", None)
    if not isinstance(cfg.get("channel_route"), dict):
        cfg["channel_route"] = {}
    if cfg.pop("glossary_inline", False):                    # (replaced by glossary_mode) the checkbox of the first version
        cfg["glossary_mode"] = "list"
    mp = cfg.pop("manual_pos", None)                         # (removed option) an old manual position becomes the first guess
    if mp and not cfg.get("last_pos"):
        try:
            cfg["last_pos"] = [int(mp[0]), int(mp[1])]
        except (TypeError, ValueError, IndexError):
            pass
    if cfg.get("prompt") in LEGACY_DEFAULT_PROMPTS:          # untouched old default -> take the new one (with {{Glossary.txt}})
        cfg["prompt"] = DEFAULT_PROMPT
    return cfg


def save(cfg):
    try:
        with open(PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
