r"""Makes the files of an engine release and tells the program where to download them.

    py tools\engine_release.py v3.0.0              after `build.bat` (and `build.bat vulkan`): takes engine\stt\dist\engine-*\
    py tools\engine_release.py v3.0.0 --dry        shows what it would do, writes nothing
    py tools\engine_release.py v3.0.0 --no-patch   makes the files but leaves app\core\voice_catalog.js alone
    py tools\engine_release.py v3.0.0 --allow-dirty  goes on although engine/stt has changes that are not committed (not for a real release)

For every engine folder that has a cmr-stt.exe it
  1. checks the folder (the licenses are there, the SHA-256 file matches the exe, the version says the engine is the kind the folder is named after),
  2. puts the files to upload into release-out\<tag>\ (the same folder as the program's zip) with names that are unique in one GitHub release:
         cmr-stt-<kind>-windows-x64.exe  BUILD-INFO-engine-<kind>.txt  LICENSE-whisper.cpp.txt  LICENSE-ChatMatrixReader.txt  SHA256SUMS-engine.txt
  3. writes BUILD-INFO-engine-<kind>.txt: tag, how it was built, the commit of this project, the version of whisper.cpp, the SHA-256 of every file,
  4. writes the download addresses and SHA-256 into app\core\voice_catalog.js (between the marks <engine-files>), so the program downloads the engine,
     the licenses and the build info into extensions\stt\engine-<kind>\ and checks every file.
Then commit the changed app\core\voice_catalog.js (git), build the program and make its zip (release_core.bat); upload everything in release-out\<tag>\ to the
GitHub release <tag> by hand.
The engine is a separate download on purpose: the licenses (MIT) must come with it, and so it brings its own copies."""
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(HERE, "app", "core", "voice_catalog.js")
REPO = "blackmass/ChatMatrixReader"
KINDS = ["cpu", "vulkan", "cuda"]
GPU_OF = {"cpu": "none", "vulkan": "vulkan", "cuda": "cuda"}         # what `cmr-stt --version` says for each folder name
NEEDED = ["cmr-stt.exe", "cmr-stt.exe.sha256", "LICENSE-whisper.cpp.txt", "LICENSE.txt", "version.json"]


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_version(path):
    text = open(path, encoding="utf-8-sig", errors="replace").read()
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise ValueError(f"{path}: no JSON line (what `cmr-stt.exe --version` printed)")


def sha_file_value(path):
    """The hash in a file made by `certutil -hashfile x SHA256` (a header line, the hash - maybe with spaces -, a closing line)."""
    for line in open(path, encoding="utf-8", errors="replace").read().splitlines():
        h = line.replace(" ", "").strip().lower()
        if re.fullmatch(r"[0-9a-f]{64}", h):
            return h
    raise ValueError(f"{path}: no SHA-256 found")


ENGINE_SOURCE = ["engine/stt", "LICENSE"]       # what the engine is built from (whisper.version is inside engine/stt)


def git_commit():
    """(text, dirty): the commit the engine source was last changed in; dirty = the engine source has changes that are not committed
    (the rest of the project does not matter for the engine). Without git: unknown, not dirty."""
    try:
        last = subprocess.run(["git", "log", "-1", "--format=%H", "--"] + ENGINE_SOURCE, cwd=HERE, capture_output=True, check=True).stdout.decode().strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--"] + ENGINE_SOURCE, cwd=HERE, capture_output=True, check=True).stdout.decode().strip()
        if not last:
            return "unknown (the engine source is not committed yet)", True
        return last + " (the engine source was last changed here)" + (" + changes that are not committed" if dirty else ""), bool(dirty)
    except (OSError, subprocess.CalledProcessError):
        return "unknown (this folder is not a git checkout)", False


def check_folder(kind, folder):
    for n in NEEDED:
        if not os.path.isfile(os.path.join(folder, n)):
            raise SystemExit(f"{folder}: {n} is missing. Run build.bat again (the release needs the licenses and the version with the engine).")
    exe = os.path.join(folder, "cmr-stt.exe")
    have, want = sha256_of(exe), sha_file_value(os.path.join(folder, "cmr-stt.exe.sha256"))
    if have != want:
        raise SystemExit(f"{folder}: cmr-stt.exe does not match cmr-stt.exe.sha256 (the exe was changed after the build?)")
    ver = read_version(os.path.join(folder, "version.json"))
    if ver.get("gpu") != GPU_OF[kind]:
        raise SystemExit(f"{folder}: the engine says gpu={ver.get('gpu')!r} but the folder is engine-{kind} (expected {GPU_OF[kind]!r}): a folder mixed up?")
    if not ver.get("whisper") or not ver.get("commit"):
        raise SystemExit(f"{folder}: this engine was built without Whisper (version.json has no whisper tag / commit)")
    return ver, have


def build_info(tag, kind, ver, exe_sha, files, commit_text):
    lines = [
        "ChatMatrix Reader - voice recognition engine (cmr-stt)",
        "",
        f"release        : {tag}",
        f"engine kind    : {kind}  (compute: {GPU_OF[kind] if kind != 'cpu' else 'CPU only'}, cpu level: {ver.get('cpu', '?')})",
        f"engine version : {ver.get('engine', '?')}",
        f"whisper.cpp    : {ver.get('whisper')}  commit {ver.get('commit')}  (https://github.com/ggml-org/whisper.cpp)",
        f"source         : https://github.com/{REPO} (engine/stt), commit {commit_text}",
        f"made           : {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "built with     : engine/stt/build.bat (CMake + Visual Studio, static libraries, no DLLs)",
        "licenses       : MIT (this project: LICENSE-ChatMatrixReader.txt; whisper.cpp / ggml: LICENSE-whisper.cpp.txt)",
        "models         : not part of this download (the program gets them from https://huggingface.co/ggerganov/whisper.cpp)",
        "",
        f"SHA-256 of cmr-stt.exe: {exe_sha}",
        "",
        "SHA-256 of every file of this engine (as the program stores them in extensions/stt/engine-" + kind + "/):",
    ]
    for dest, sha in files:
        lines.append(f"  {sha}  {dest}")
    lines += ["", "To check a file by hand (Windows):  certutil -hashfile cmr-stt.exe SHA256", ""]
    return "\n".join(lines)


def catalog_block(base, per_kind):
    out = ["  engines: {"]
    for kind in KINDS:
        files = per_kind.get(kind, [])
        if not files:
            out.append(f"    {kind}: {{ files: [] }},")
            continue
        out.append(f"    {kind}: {{ files: [")
        for dest, asset, sha in files:
            out.append(f"      {{ name: '{dest}', url: '{base}{asset}', sha256: '{sha}' }},")
        out.append("    ] },")
    out.append("  },")
    return "\n".join(out) + "\n"


def patch_catalog(block):
    text = open(CATALOG, encoding="utf-8").read()
    pat = re.compile(r"(  // <engine-files>[^\n]*\n)(.*?)(  // </engine-files>)", re.S)
    if not pat.search(text):
        raise SystemExit("voice_catalog.js has no <engine-files> marks (the file looks different from what this tool expects)")
    new = pat.sub(lambda m: m.group(1) + block + m.group(3), text, count=1)
    open(CATALOG, "w", encoding="utf-8", newline="").write(new)


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    dry, no_patch = "--dry" in argv, "--no-patch" in argv
    if len(args) != 1 or not re.fullmatch(r"v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", args[0]):
        sys.exit("usage: py tools\\engine_release.py v3.0.0 [--dry] [--no-patch]")
    tag = args[0]
    commit_text, dirty = git_commit()
    if dirty and "--allow-dirty" not in argv:
        sys.exit("The engine source (engine/stt, whisper.version) has changes that are not committed: commit them first, build the engines again, then run this.\n"
                 "(An engine must be built from a committed state, so that BUILD-INFO tells which source it is made of. --allow-dirty goes on anyway.)")
    dist = os.path.join(HERE, "engine", "stt", "dist")
    out_dir = os.path.join(HERE, "release-out", tag)
    kinds = [k for k in KINDS if os.path.isfile(os.path.join(dist, f"engine-{k}", "cmr-stt.exe"))]
    if not kinds:
        sys.exit(f"no engine found in {dist} (build it first: engine\\stt\\build.bat, build.bat vulkan)")
    assets, per_kind, shared = [], {}, {}
    if not dry:
        os.makedirs(out_dir, exist_ok=True)
    for kind in kinds:
        folder = os.path.join(dist, f"engine-{kind}")
        ver, exe_sha = check_folder(kind, folder)
        for n, asset in (("LICENSE-whisper.cpp.txt", "LICENSE-whisper.cpp.txt"), ("LICENSE.txt", "LICENSE-ChatMatrixReader.txt")):
            sha = sha256_of(os.path.join(folder, n))
            if asset in shared and shared[asset][0] != sha:
                raise SystemExit(f"{asset} differs between the engine folders: build all engines from the same state of the project")
            shared[asset] = (sha, os.path.join(folder, n))
        exe_asset, info_asset = f"cmr-stt-{kind}-windows-x64.exe", f"BUILD-INFO-engine-{kind}.txt"
        files = [("cmr-stt.exe", exe_sha), ("LICENSE-whisper.cpp.txt", shared["LICENSE-whisper.cpp.txt"][0]), ("LICENSE.txt", shared["LICENSE-ChatMatrixReader.txt"][0])]
        info = build_info(tag, kind, ver, exe_sha, files, commit_text)
        info_sha = hashlib.sha256(info.encode("utf-8")).hexdigest()
        per_kind[kind] = [("cmr-stt.exe", exe_asset, exe_sha), ("LICENSE-whisper.cpp.txt", "LICENSE-whisper.cpp.txt", files[1][1]),
                          ("LICENSE.txt", "LICENSE-ChatMatrixReader.txt", files[2][1]), ("BUILD-INFO.txt", info_asset, info_sha)]
        assets += [(exe_asset, exe_sha), (info_asset, info_sha)]
        print(f"engine-{kind}: whisper.cpp {ver['whisper']}, cmr-stt.exe {exe_sha[:16]}...")
        if not dry:
            shutil.copyfile(os.path.join(folder, "cmr-stt.exe"), os.path.join(out_dir, exe_asset))
            open(os.path.join(out_dir, info_asset), "w", encoding="utf-8", newline="\n").write(info)
    for asset, (sha, src) in shared.items():
        assets.append((asset, sha))
        if not dry:
            shutil.copyfile(src, os.path.join(out_dir, asset))
    base = f"https://github.com/{REPO}/releases/download/{tag}/"
    sums = "".join(f"{sha}  {name}\n" for name, sha in sorted(set(assets)))
    if not dry:
        open(os.path.join(out_dir, "SHA256SUMS-engine.txt"), "w", encoding="utf-8", newline="\n").write(sums)
    print("\nupload these files to the GitHub release " + tag + (f" (from {out_dir}):" if not dry else " (dry run: nothing was written):"))
    for name, sha in sorted(set(assets)):
        print(f"  {name}")
    print("  SHA256SUMS-engine.txt")
    block = catalog_block(base, per_kind)
    if dry or no_patch:
        print("\nthe catalog would get:\n" + block)
    else:
        patch_catalog(block)
        print(f"\nthe download addresses are in {CATALOG}: release the program with it (and run: node tests\\run.mjs)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
