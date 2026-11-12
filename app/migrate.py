"""One-time tidy-up after the folder layout changed (version 1.6.0: the program moved into the  app  folder).

Whoever unpacks the new version over the old folder keeps the old program files next to the new  app  folder. They are
never used again, so on start they are MOVED (never deleted) into  old_version_backup/ . Only the exact names of the
files that earlier versions shipped are touched; everything else in the folder (config.json, the glossary, fonts, locale,
.venv, the user's own files, even a file the user changed that has one of these names: it is in the backup then) stays.
Nothing happens when none of these names is left, so it costs a handful of existence checks.

This can be removed in a few versions."""
import logging
import os
import shutil

import paths

log = logging.getLogger("cmr.migrate")

BACKUP = "old_version_backup"

# What versions before 1.6.0 had in the main folder (code and fixed resources). The files that are still in the main
# folder (launchers, Glossary.sample.txt, requirements*.txt, fonts/, locale/) are not listed.
OLD_NAMES = (
    "app.py", "capture.py", "capture_diag.py", "capture_mac.py", "chattext.py", "config.py", "credit.json", "credits.py",
    "decoder.py", "diag_google.py", "diag_google2.py", "diag_google3.py", "diag_google4.py", "diag_google5.py",
    "fonts.py", "glossary.py", "hotkeys.py", "i18n.py", "logsetup.py", "make_zip.py", "options.py", "outgoing.py",
    "proto2.py", "scaled.py", "test_cache.py", "test_capture.py", "test_chattext.py", "test_custom.py",
    "test_decoder.py", "test_glossary.py", "test_i18n.py", "test_outgoing.py", "test_plat_mac.py", "test_proto2.py",
    "test_route.py", "test_scaled.py", "test_translator.py", "test_updatecheck.py", "test_usage.py", "tk_diag.py",
    "tk_diag2.py", "translator.py", "updatecheck.py", "usage.py", "version.py",
    "plat", "__pycache__", ".pytest_cache",
    "PROTOCOL.md", "MAC.md",                      # the documents moved to the docs folder
)


def _free(path):
    if not os.path.lexists(path):
        return path
    n = 1
    while os.path.lexists("%s.%d" % (path, n)):
        n += 1
    return "%s.%d" % (path, n)


def run(root=None, names=OLD_NAMES):
    """-> the list of names that were moved. Never raises."""
    moved = []
    try:
        root = root or paths.ROOT
        if not os.path.isfile(os.path.join(root, "app", "app.py")):          # the new layout is not there: touch nothing
            return moved
        backup = os.path.join(root, BACKUP)
        for name in names:
            src = os.path.join(root, name)
            if not os.path.lexists(src) or os.path.islink(src):
                continue
            try:
                os.makedirs(backup, exist_ok=True)
                shutil.move(src, _free(os.path.join(backup, name)))
                moved.append(name)
            except OSError as e:
                log.warning("이전 버전 파일 %s 을(를) 옮기지 못했습니다: %s", name, e)
        if moved:
            log.info("이전 버전 파일 %d개를 %s 폴더로 옮겼습니다 (확인 후 폴더째 지워도 됩니다): %s", len(moved), BACKUP, ", ".join(moved))
    except Exception:
        log.exception("이전 버전 파일 정리 실패")
    return moved
