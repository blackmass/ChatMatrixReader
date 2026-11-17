"""2.0 config.normalize / migrate.migrate on a corpus of saved files -> tests/golden/config.json.
python tools/make_golden_config.py <path to ChatMatrixReader2/app>"""
import json, logging, os, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "ChatMatrixReader2", "app")
sys.path.insert(0, SRC)
logging.disable(logging.CRITICAL)
import config, migrate, translator

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "golden", "config.json")
LEG = translator.LEGACY_DEFAULT_PROMPTS
CASES = [
    None, [], {}, {"translator": "openai", "api_key": "k", "font_size": 14},
    {"opacity": 0.5}, {"opacity": 0.5, "bg_opacity": 0.9}, {"voice_translate": False}, {"voice_translate": False, "channel_route": {"!VC": "google"}},
    {"voice_translate": True}, {"voice_translate": False, "channel_route": {"S": "off"}},
    {"glossary_inline": True}, {"glossary_inline": True, "glossary_mode": "mixed"}, {"glossary_inline": False},
    {"manual_pos": [10, 20]}, {"manual_pos": ["5", "6"]}, {"manual_pos": [1.9, 2.2]}, {"manual_pos": ["x", 1]}, {"manual_pos": [7]}, {"manual_pos": [1, 2], "last_pos": [3, 4]},
    {"prompt": LEG[0]}, {"prompt": LEG[3]}, {"prompt": "mine"}, {"prompt": LEG[-1]},
    {"blur_experiment": True, "blur_state": 4, "blur_tint": 1, "capture_method": "x", "options_pos": [1, 2], "options_size": [3, 4]},
    {"win1_off": "x", "channel_route": [1]}, {"win1_off": ["S"], "channel_route": {"W": "openai"}},
    {"child_windows": [{"id": 3, "name": "A", "channels": ["S", "Y"], "blur": 1}, {"id": "x"}, {"id": 4, "blur": 9}]},
    {"config_version": 2, "font_size": 20},
]
MIG = [
    {}, {"font_size": 14, "translator": "openai"}, {"blur_experiment": True}, {"blur_experiment": True, "blur_state": 4}, {"blur_experiment": True, "blur": 2},
    {"font_size": "big", "translator": 5, "click_through": "yes", "channel_route": [], "interact_keys": "Shift"}, {"zzz": 1, "aaa": 2, "font_size": 12},
    {"send_prompt": ""}, {"send_prompt": "   "}, {"prompt": translator.DEFAULT_PROMPT.strip()}, {"prompt": LEG[1], "opacity": 0.4, "manual_pos": [1, 2]},
    {"blur_tint": 1, "capture_method": "bitblt", "options_size": [1, 1], "channel_detail_old": 1, "voice_translate": False},
    {"last_pos": [1, 2], "max_lines": 300, "fade_sec": 5.5, "temperature": 1}, {"temperature": "hot", "timeout": True},
    None, [1, 2], {"child_windows": [{"id": 3, "channels": ["S"]}], "win1_off": ["G"]},
]
out = {"normalize": [], "migrate": []}
for c in CASES:
    out["normalize"].append([c, config.normalize(c)])
for c in MIG:
    cfg, notes = migrate.migrate(c)
    out["migrate"].append([c, cfg, notes])
json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, sort_keys=True)
# the defaults themselves
json.dump(config.DEFAULTS, open(OUT.replace("config.json", "config_defaults.json"), "w", encoding="utf-8"), ensure_ascii=False, sort_keys=True)
print(len(out["normalize"]), len(out["migrate"]))
