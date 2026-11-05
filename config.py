import json
import os

from translator import DEFAULT_PROMPT, DEFAULT_REASONING_OFF, LEGACY_DEFAULT_PROMPTS

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

DEFAULTS = {
    # translation
    "translator": "none",                 # none | openai | google
    "target_lang": "한국어",
    "language": "",                       # "" = system language, else a locale/<code>.txt name (ko-KR = built in)
    "api_url": "http://localhost:1234/v1",
    "api_model": "",
    "api_key": "",
    "google_api_key": "",                 # optional; empty = free unofficial endpoint
    "prompt": DEFAULT_PROMPT,
    "glossary_file": "Glossary.txt",      # relative to the app folder, or an absolute path
    "glossary_google": True,              # also apply the glossary to Google translation
    "glossary_style": "paren",            # paren: LFM(구인) | replace: 구인
    "disable_reasoning": True,
    "reasoning_off_body": DEFAULT_REASONING_OFF,
    "temperature": 0.2,
    "timeout": 30,
    "max_tokens": 300,
    "skip_same_lang": True,
    "max_pending": 20,
    "max_parallel": 2,
    # window
    "bg_opacity": 1.0,                    # background (the dark area)
    "text_opacity": 1.0,                  # text, title bar, scrollbar
    "topmost": False,
    "click_through": False,
    "font_size": 11,
    "max_lines": 500,
    "geometry": "560x420",
    # capture
    "poll_hz": 30,
    "manual_pos": None,                   # [x, y] in screen pixels, or None = auto search
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
    if cfg.get("prompt") in LEGACY_DEFAULT_PROMPTS:          # untouched old default -> take the new one (with {{Glossary.txt}})
        cfg["prompt"] = DEFAULT_PROMPT
    return cfg


def save(cfg):
    try:
        with open(PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
