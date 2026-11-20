r"""Packs the project into a zip file (only what is needed), into the project folder.

    py tools\make_zip.py mac      what a Mac needs to build and run the program (no tests, no engine, no docs except the Mac one)
    py tools\make_zip.py all      the whole source: everything that .gitignore does not exclude (to keep, or to move the project to another PC)

Which files go in: the ones git would upload (`git ls-files --cached --others --exclude-standard`) when the folder is a git repository;
without git the rules of .gitignore are read here (a simple reader: names, folders ending in /, * and ?).  So .gitignore is the one list to keep.
Left out always: files whose name starts with a dot, *.zip (earlier packages), build output (src-tauri/target ...).
Files that must be run on macOS (*.command) get the 'executable' flag inside the zip.  Changes nothing in the project."""
import fnmatch
import os
import re
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_JS = os.path.join(HERE, "app", "core", "version.js")          # the project folder (this file is in its tools/ folder)
FOLDER = "ChatMatrixReader"                                                 # the folder name inside the zip

# what the "mac" package takes (folders / files, relative to the project folder); everything else is left out
MAC_PARTS = ["app/", "locale/", "fonts/", "plugins/README.txt", "src-tauri/", "tools/mac_make_app.command", "Glossary.sample.txt", "README.md", "LICENSE"]


def display_version():
    """3.0.0, or 3.0.0-beta.1 for a pre-release (the version of the release files and of the tag)."""
    try:
        text = open(os.path.join(APP_JS), encoding="utf-8").read()
        pre = re.search(r"export const PRERELEASE = '([^']*)';", text).group(1)
        return version() + ("-" + pre if pre else "")
    except (OSError, AttributeError):
        return version()


def version():
    try:
        text = open(os.path.join(HERE, "app", "core", "version.js"), encoding="utf-8").read()
        return re.search(r"VERSION\s*=\s*['\"]([^'\"]+)['\"]", text).group(1)
    except (OSError, AttributeError):
        return "dev"


def read_ignore():
    rules = []
    try:
        lines = open(os.path.join(HERE, ".gitignore"), encoding="utf-8").read().splitlines()
    except OSError:
        return rules
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#"):
            rules.append(line)
    return rules


def matches(parts, rule, as_dir=False):
    only_dir = rule.endswith("/")
    pat = rule.rstrip("/")
    anchored = pat.startswith("/") or "/" in pat
    pat = pat.lstrip("/")
    if anchored:                                                             # from the project folder: the path, or a folder on the way
        for n in range(1, len(parts) + 1):
            if n == len(parts) and only_dir and not as_dir:
                continue
            if fnmatch.fnmatchcase("/".join(parts[:n]), pat):
                return True
    else:                                                                    # a name, anywhere
        for n, part in enumerate(parts, 1):
            if n == len(parts) and only_dir and not as_dir:
                continue
            if fnmatch.fnmatchcase(part, pat):
                return True
    return False


def ignored(rel, rules, as_dir=False):
    """Like git: the rules are read in order and the last one that matches decides; a rule that starts with ! takes the file back in.
    as_dir: `rel` is a folder (a folder is left out only when a rule names the folder itself: `docs/*` leaves its files out, not the folder, so that !docs/README.md can take one back)."""
    parts = rel.split("/")
    state = False
    for rule in rules:
        if rule.startswith("!"):
            if matches(parts, rule[1:], as_dir):
                state = False
        elif matches(parts, rule, as_dir):
            state = True
    return state


def all_files():
    try:
        out = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=HERE, capture_output=True, check=True).stdout.decode("utf-8")
        names = [n for n in out.split("\0") if n]
        source = "git"
    except (OSError, subprocess.CalledProcessError):
        rules = read_ignore()
        names = []
        for root, dirs, files in os.walk(HERE):
            rel_root = os.path.relpath(root, HERE).replace(os.sep, "/")
            dirs[:] = [d for d in dirs if not ignored(("" if rel_root == "." else rel_root + "/") + d, rules, as_dir=True) and not d.startswith(".")]
            for f in files:
                rel = f if rel_root == "." else rel_root + "/" + f
                if not ignored(rel, rules):
                    names.append(rel)
        source = ".gitignore"
    seen, result = set(), []
    for rel in names:
        base = os.path.basename(rel)
        if rel in seen or base.startswith(".") or rel.lower().endswith(".zip") or not os.path.isfile(os.path.join(HERE, rel)):
            continue
        seen.add(rel)
        result.append(rel)
    return sorted(result), source


def wanted(rel, mode):
    if mode == "all":
        return True
    return any(rel == p or (p.endswith("/") and rel.startswith(p)) for p in MAC_PARTS)


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if mode not in ("mac", "all"):
        sys.exit("사용법: py tools\\make_zip.py mac   (Mac에서 빌드할 것만)\n        py tools\\make_zip.py all   (소스 전체)")
    names, source = all_files()
    names = [n for n in names if wanted(n, mode)]
    out_path = os.path.join(HERE, f"ChatMatrixReader-v{version()}-source-{mode}.zip" if mode == "mac" else f"ChatMatrixReader-v{version()}-source.zip")
    if os.path.exists(out_path):
        os.remove(out_path)
    total = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in names:
            src = os.path.join(HERE, rel)
            info = zipfile.ZipInfo.from_file(src, f"{FOLDER}/{rel}")
            info.external_attr = (0o100000 | (0o755 if rel.endswith(".command") else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(src, "rb") as f:
                data = f.read()
            total += len(data)
            z.writestr(info, data)
    print(f"{len(names)}개 파일 ({total / 1048576:.1f} MB, 압축 후 {os.path.getsize(out_path) / 1048576:.1f} MB) -> {out_path}")
    print(f"(목록 기준: {source})")


if __name__ == "__main__":
    main()
