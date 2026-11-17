"""Writes the default prompts of the 2.0 translator into app/core/prompts.js (and the old defaults into prompts_legacy.js).
python tools/export_prompts.py <path to ChatMatrixReader2/app>"""
import logging, os, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "ChatMatrixReader2", "app")
sys.path.insert(0, SRC)
logging.disable(logging.CRITICAL)
import translator as t

OUT = os.path.join(os.path.dirname(__file__), "..", "app", "core")

def lit(s):
    return "`" + s.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${") + "`"

head = ("// The default prompts of the translation (the text of the AI's instructions). {target_lang} / {send_lang} are filled in,\n"
        "// {{Glossary.txt}} becomes the glossary, {{extra_prompt}} the user's own additional instructions. Generated from the 2.0\n"
        "// translator.py by tools/export_prompts.py; from here on this file is the place to edit them.\n")
with open(os.path.join(OUT, "prompts.js"), "w", encoding="utf-8", newline="\n") as f:
    f.write(head)
    f.write("export const DEFAULT_PROMPT = %s;\n" % lit(t.DEFAULT_PROMPT))
    f.write("export const DEFAULT_EXTRA_PROMPT = %s;       // the \"natural\" example of the options\n" % lit(t.DEFAULT_EXTRA_PROMPT))
    f.write("export const DEFAULT_SEND_EXTRA_PROMPT = %s;\n" % lit(t.DEFAULT_SEND_EXTRA_PROMPT))
    f.write("export const DEFAULT_SEND_PROMPT = %s;\n" % lit(t.DEFAULT_SEND_PROMPT))
with open(os.path.join(OUT, "prompts_legacy.js"), "w", encoding="utf-8", newline="\n") as f:
    f.write("// Earlier default prompts: a saved prompt that equals one of these was never edited by the user, so the migration replaces it\n"
            "// by the current default. Never edit.\nexport const LEGACY_DEFAULT_PROMPTS = [\n")
    for p in t.LEGACY_DEFAULT_PROMPTS:
        f.write("  %s,\n" % lit(p))
    f.write("];\n")
print(len(t.LEGACY_DEFAULT_PROMPTS), "legacy prompts")
