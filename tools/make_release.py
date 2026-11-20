r"""Makes the Windows release zip: only what release/files-windows.txt lists, with BUILD-INFO.txt (what it was built from, SHA-256 of every file).

    py tools\make_release.py v3.0.0
    py tools\make_release.py v3.0.1 --reuse-exe     a release whose Rust sources did not change: the program file of the earlier build is used again (no build.bat)

Before it, in this order:
    build.bat                         the program (ChatMatrixReader.exe) from the sources
    py tools\make_notices.py          THIRD-PARTY-NOTICES.txt (the licenses of the libraries inside the program)
    (the engine is a separate download: build.bat in engine\stt, then py tools\engine_release.py v3.0.0)
Then upload release-out\<tag>\ChatMatrixReader-v<version>-windows-x64.zip (and the engine files) to the GitHub release by hand.

The tag must be "v" + the version in app/core/version.js (the one place where the version is changed), so that a zip is never named after another version.
Checks: every listed file exists; the program is not older than the Rust sources (a stale build); the licenses are in the zip."""
import datetime
import hashlib
import os
import re
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_zip import display_version, ignored, read_ignore, version      # the same .gitignore rules as the other package tools

LIST = os.path.join(HERE, "release", "files-windows.txt")
CARGO = os.path.join(HERE, "src-tauri", "Cargo.toml")
TAURI = os.path.join(HERE, "src-tauri", "tauri.conf.json")
CATALOG = os.path.join(HERE, "app", "core", "voice_catalog.js")
FOLDER = "ChatMatrixReader"
EXE = "ChatMatrixReader.exe"


def entries():
    out = []
    for line in open(LIST, encoding="utf-8").read().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out


def expand(entry, rules):
    path = os.path.join(HERE, entry.rstrip("/"))
    if entry.endswith("/"):
        if not os.path.isdir(path):
            raise SystemExit(f"{entry}: the folder is not there")
        found = []
        for root, dirs, files in os.walk(path):
            rel_root = os.path.relpath(root, HERE).replace(os.sep, "/")
            dirs[:] = [d for d in dirs if not d.startswith(".") and not ignored(rel_root + "/" + d, rules, as_dir=True) and d != "__pycache__"]
            for f in files:
                rel = rel_root + "/" + f
                if not f.startswith(".") and not f.lower().endswith(".zip") and not ignored(rel, rules):
                    found.append(rel)
        return sorted(found)
    if not os.path.isfile(path):
        hint = {"THIRD-PARTY-NOTICES.txt": "run: py tools\\make_notices.py", EXE: "run: build.bat"}.get(entry, "")
        raise SystemExit(f"{entry}: the file is not there. {hint}".strip())
    return [entry]


def stale_exe(reuse=False):
    """The sources that are newer than the program: a build that was not redone. With reuse (--reuse-exe) the two files that only hold the version number are
    not looked at (set_version.py changes them): a real change of the Rust sources still counts."""
    exe = os.path.join(HERE, EXE)
    newest, newest_name = 0.0, ""
    for base in ("src-tauri/src", "src-tauri/capabilities", "src-tauri/build.rs") + (() if reuse else ("src-tauri/Cargo.toml", "src-tauri/tauri.conf.json")):
        p = os.path.join(HERE, base)
        for root, _, files in (os.walk(p) if os.path.isdir(p) else [(os.path.dirname(p), [], [os.path.basename(p)])]):
            for f in files:
                m = os.path.getmtime(os.path.join(root, f))
                if m > newest:
                    newest, newest_name = m, os.path.relpath(os.path.join(root, f), HERE)
    return newest_name if os.path.getmtime(exe) + 2 < newest else ""


def tool_version(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, check=True).stdout.decode().strip().splitlines()[0]
    except (OSError, subprocess.CalledProcessError, IndexError):
        return "unknown"


def commit():
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True, check=True).stdout.decode().strip()
        dirty = subprocess.run(["git", "status", "--porcelain"], cwd=HERE, capture_output=True, check=True).stdout.decode().strip()
        return out + (" (with changes that are not committed)" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown (this folder is not a git checkout)"


def notes(tag, out_dir, info):
    """What to look at before the files are uploaded."""
    print(f"\nupload everything in  {out_dir}  to the GitHub release {tag}.")
    # what is in the folder now: the program's zip and, when release_engines.bat was run for this version, the engines (so the whole upload can be seen here)
    try:
        for name in sorted(os.listdir(out_dir)):
            path = os.path.join(out_dir, name)
            if os.path.isfile(path):
                kind = "engine" if name.startswith(("cmr-stt-", "BUILD-INFO-engine", "SHA256SUMS-engine", "LICENSE")) else "program"
                print(f"  {os.path.getsize(path) / 1048576:8.2f} MB  {name}   [{kind}]")
    except OSError:
        pass
    engine = os.path.isfile(os.path.join(out_dir, "SHA256SUMS-engine.txt"))
    urls = set(re.findall(r"/releases/download/(v[^/]+)/", open(CATALOG, encoding="utf-8").read()))
    if not engine:
        print("NOTE: the engine files are not in this folder (release_engines.bat was not run for this version).")
        if urls:
            print(f"      The program downloads the engine from the release {', '.join(sorted(urls))}: that release (and its files) must stay on GitHub.")
        else:
            print("      The catalog has no engine addresses at all: the install buttons of the voice recognition will say the engine is not up yet.")
    elif urls and urls != {tag}:
        print(f"WARNING: the catalog points to the engine of {', '.join(sorted(urls))}, not of {tag}: run release_engines.bat again (and commit voice_catalog.js).")
    if "not committed" in info or "not a git checkout" in info:
        print("WARNING: the sources have changes that are not committed (or this is not a git checkout): BUILD-INFO.txt says so. Commit first, build again, then make the zip.")


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def main(argv):
    reuse = "--reuse-exe" in argv
    argv = [a for a in argv if a != "--reuse-exe"]
    if len(argv) != 1 or not re.fullmatch(r"v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", argv[0]):
        sys.exit("usage: py tools\\make_release.py v3.0.0 [--reuse-exe]")
    tag, ver, shown = argv[0], version(), display_version()
    if tag != "v" + shown:
        sys.exit(f"the tag {tag} does not match the version in app/core/version.js ({shown}): change the version there first (py tools\\set_version.py 3.0.1) or give the matching tag")
    if shown.endswith("-dev"):
        sys.exit(f"the version is {shown}: the pre-release mark 'dev' means the program is still being built. Release with: py tools\\set_version.py {ver}  (or a mark like beta.1)")
    for label, path, pattern in (("src-tauri/Cargo.toml", CARGO, r'\[package\][^\[]*?\nversion = "([^"]*)"'), ("src-tauri/tauri.conf.json", TAURI, r'"version": "([^"]*)"')):
        m = re.search(pattern, open(path, encoding="utf-8").read(), re.S)
        if not m or m.group(1) != ver:
            sys.exit(f"{label} says version {m.group(1) if m else '?'}, version.js says {ver}: run  py tools\\set_version.py  and build the program again (build.bat)")
    rules = read_ignore()
    names = []
    for e in entries():
        for n in expand(e, rules):
            if n not in names:
                names.append(n)
    for must in ("LICENSE", "THIRD-PARTY-NOTICES.txt", EXE):
        if must not in names:
            sys.exit(f"{must} is not in release/files-windows.txt: a release without it is not allowed")
    old = stale_exe(reuse)
    if old:
        sys.exit(f"{EXE} is older than {old}: the Rust sources changed after the last build, so the program must be built again (build.bat); --reuse-exe is only for a release whose Rust sources did not change.")
    data = {}
    for n in names:
        data[n] = open(os.path.join(HERE, n), "rb").read()
    lines = [
        "ChatMatrix Reader " + shown + " - Windows",
        "",
        f"release        : {tag}",
        f"made           : {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        f"source         : https://github.com/blackmass/ChatMatrixReader , commit {commit()}",
        ("built with     : the program file is the one of an earlier build (the Rust sources did not change); the rest is from this release" if reuse
         else f"built with     : build.bat ({tool_version(['rustc', '--version'])}; {tool_version(['cargo', '--version'])})"),
        "license        : MIT (LICENSE); the libraries inside and what the program downloads: THIRD-PARTY-NOTICES.txt",
        "not in this zip: the voice recognition engine and the models (downloaded by the program from this GitHub release / huggingface.co; every file is checked by SHA-256)",
        "",
        f"SHA-256 of {EXE}: {sha256_bytes(data[EXE])}",
        "",
        "SHA-256 of every file of this zip (BUILD-INFO.txt itself is not in the list):",
    ]
    for n in names:
        lines.append(f"  {sha256_bytes(data[n])}  {n}")
    lines += ["", "To check a file by hand (Windows):  certutil -hashfile <file> SHA256", ""]
    info = "\n".join(lines)
    out_dir = os.path.join(HERE, "release-out", tag)
    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, f"ChatMatrixReader-v{shown}-windows-x64.zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names + ["BUILD-INFO.txt"]:
            content = info.encode("utf-8") if n == "BUILD-INFO.txt" else data[n]
            z.writestr(zipfile.ZipInfo(f"{FOLDER}/{n}", date_time=datetime.datetime.now().timetuple()[:6]), content, zipfile.ZIP_DEFLATED)
    zsha = hashlib.sha256(open(zip_path, "rb").read()).hexdigest()
    open(os.path.join(out_dir, "SHA256SUMS.txt"), "w", encoding="utf-8", newline="\n").write(f"{zsha}  {os.path.basename(zip_path)}\n")
    total = sum(len(v) for v in data.values())
    print(f"{len(names) + 1} files ({total / 1048576:.1f} MB, zip {os.path.getsize(zip_path) / 1048576:.1f} MB) -> {zip_path}")
    print(f"SHA-256 of the zip: {zsha}  (also in release-out\\{tag}\\SHA256SUMS.txt)")
    notes(tag, out_dir, info)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
