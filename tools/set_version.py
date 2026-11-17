r"""The version of the program: app/core/version.js is the one place that says it; this tool keeps the other places in step.

    py tools\set_version.py                      shows the version and makes the other places agree (no change if they already do)
    py tools\set_version.py 3.0.1                sets the version (VERSION in version.js; the pre-release mark becomes '' = a release) and syncs
    py tools\set_version.py 3.1.0 --pre beta.1   a pre-release: 3.1.0-beta.1  (--pre '' = none)
    py tools\set_version.py --tag                prints the tag of the release: v + the version (for the .bat files)

The other places (they only matter for the program file itself: the version in its properties): src-tauri/Cargo.toml, src-tauri/tauri.conf.json and the
entry of the program in src-tauri/Cargo.lock. If a file was changed, build.bat must be run again.
The pre-release mark 'dev' (while 3.0 is built) is not a release: tools/make_release.py refuses it."""
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION_JS = os.path.join(HERE, "app", "core", "version.js")
CARGO = os.path.join(HERE, "src-tauri", "Cargo.toml")
TAURI = os.path.join(HERE, "src-tauri", "tauri.conf.json")
LOCK = os.path.join(HERE, "src-tauri", "Cargo.lock")


def read(p):
    return open(p, encoding="utf-8").read()


def write(p, text):
    open(p, "w", encoding="utf-8", newline="").write(text)


def current():
    t = read(VERSION_JS)
    v = re.search(r"export const VERSION = '([^']*)';", t)
    p = re.search(r"export const PRERELEASE = '([^']*)';", t)
    if not v or not p:
        sys.exit("app/core/version.js: VERSION / PRERELEASE lines not found (the file looks different from what this tool expects)")
    return v.group(1), p.group(1)


def display(version, pre):
    return version + ("-" + pre if pre else "")


def sub_once(text, pattern, repl, what):
    new, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    if not n:
        sys.exit(f"{what}: the line to change was not found")
    return new


def sync(version, pre):
    shown, changed = version, []                       # (the plain x.y.z: the version in the properties of the program file; a pre-release mark does not belong there)
    cargo = read(CARGO)
    new = sub_once(cargo, r'(\[package\][^\[]*?\nversion = ")[^"]*(")', lambda m: m.group(1) + shown + m.group(2), "Cargo.toml")
    if new != cargo:
        write(CARGO, new); changed.append("src-tauri/Cargo.toml")
    tauri = read(TAURI)
    new = sub_once(tauri, r'("version": ")[^"]*(")', lambda m: m.group(1) + shown + m.group(2), "tauri.conf.json")
    if new != tauri:
        write(TAURI, new); changed.append("src-tauri/tauri.conf.json")
    lock = read(LOCK)
    new = sub_once(lock, r'(name = "chatmatrix-reader"\nversion = ")[^"]*(")', lambda m: m.group(1) + shown + m.group(2), "Cargo.lock")
    if new != lock:
        write(LOCK, new); changed.append("src-tauri/Cargo.lock")
    return changed


def main(argv):
    version, pre = current()
    if "--tag" in argv:
        print("v" + display(version, pre))
        return 0
    args = [a for a in argv if not a.startswith("--") and (argv.index(a) == 0 or argv[argv.index(a) - 1] != "--pre")]
    if "--pre" in argv:
        i = argv.index("--pre")
        pre = argv[i + 1] if i + 1 < len(argv) else ""
        if not re.fullmatch(r"[0-9A-Za-z.]*", pre):
            sys.exit("--pre: letters, digits and dots only (example: beta.1)")
        explicit_pre = True
    else:
        explicit_pre = False
    if args:
        if not re.fullmatch(r"\d+\.\d+\.\d+", args[0]):
            sys.exit("the version must look like 3.0.1")
        version = args[0]
        if not explicit_pre:
            pre = ""                                   # a new version is a release unless a pre-release mark is asked for
    changed_js = False
    if args or explicit_pre:
        t = read(VERSION_JS)
        t2 = sub_once(t, r"(export const VERSION = ')[^']*(')", lambda m: m.group(1) + version + m.group(2), "version.js")
        t2 = sub_once(t2, r"(export const PRERELEASE = ')[^']*(')", lambda m: m.group(1) + pre + m.group(2), "version.js")
        if t2 != t:
            write(VERSION_JS, t2); changed_js = True
    changed = (["app/core/version.js"] if changed_js else []) + sync(version, pre)
    print(f"version {display(version, pre)}  (tag v{display(version, pre)})" + ("  - pre-release mark 'dev': not a release yet" if pre == "dev" else ""))
    if changed:
        print("changed: " + ", ".join(changed))
        if any(c.startswith("src-tauri") for c in changed):
            print("the program must be built again (build.bat) to carry the new version")
    else:
        print("nothing to change: every place agrees")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
