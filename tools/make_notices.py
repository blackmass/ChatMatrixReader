r"""Writes THIRD-PARTY-NOTICES.txt: the licenses of the libraries that are built into the program (the file goes into the release zip).

    py tools\make_notices.py                            Windows program  (THIRD-PARTY-NOTICES.txt in the project folder)
    py tools\make_notices.py --target aarch64-apple-darwin --out THIRD-PARTY-NOTICES-mac.txt     the macOS program
    py tools\make_notices.py --offline                  does not ask the internet (when every crate is in the cargo cache already)

Where the list comes from: `cargo metadata` for the program (src-tauri/Cargo.toml) and the given system, only what is built INTO the program (not what
only builds or tests it). The license text of each crate is read from the crate's own files (LICENSE*, COPYING*, UNLICENSE*, NOTICE*) in the cargo
cache (~/.cargo/registry/src), so run it after a build on the same PC. Equal texts are written once, with the list of the crates they belong to.
A crate that ships no license file is listed with its license name, authors and address (the text is the standard one of that name:
https://spdx.org/licenses/<name>.html).

The MIT / BSD / Apache / ISC / Zlib licenses ask that the notice goes along with the program (this file does that). MPL-2.0 (a few crates) asks that
the receiver can get the source of those files: they are not changed, and their source is at the addresses listed in the MPL section.
(This is the usual practical way, not legal advice.)"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LICENSE_FILE_START = ("LICENSE", "LICENCE", "COPYING", "UNLICENSE", "NOTICE")
SKIP_SUFFIX = (".spdx",)


def metadata(target, offline):
    cmd = ["cargo", "metadata", "--format-version", "1", "--manifest-path", os.path.join(HERE, "src-tauri", "Cargo.toml"), "--filter-platform", target]
    if offline:
        cmd.append("--offline")
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return json.loads(out)


def built_in_crates(meta):
    """The crates the program is made of: the closure of the normal (not build / dev) dependencies of the root crate."""
    pk = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    root = meta["resolve"]["root"]
    seen, stack = set(), [root]
    while stack:
        i = stack.pop()
        if i in seen:
            continue
        seen.add(i)
        for d in nodes[i]["deps"]:
            if any(k["kind"] is None for k in d["dep_kinds"]):
                stack.append(d["pkg"])
    seen.discard(root)
    return sorted((pk[i] for i in seen), key=lambda p: (p["name"], p["version"]))


def license_files(package):
    folder = os.path.dirname(package["manifest_path"])
    names = [n for n in os.listdir(folder) if n.upper().startswith(LICENSE_FILE_START) and not n.lower().endswith(SKIP_SUFFIX) and os.path.isfile(os.path.join(folder, n))]
    return sorted(names)


def read_text(path):
    return open(path, encoding="utf-8", errors="replace").read().replace("\r\n", "\n").strip("\n")


def build(meta, target):
    crates = built_in_crates(meta)
    groups, missing, mpl = {}, [], []
    for p in crates:
        files = license_files(p)
        label = f"{p['name']} {p['version']}"
        if "MPL-2.0" in (p.get("license") or ""):
            mpl.append(p)
        if not files:
            missing.append(p)
            continue
        folder = os.path.dirname(p["manifest_path"])
        for n in files:
            text = read_text(os.path.join(folder, n))
            key = hashlib.sha256(text.encode("utf-8")).hexdigest()
            groups.setdefault(key, {"text": text, "crates": []})["crates"].append(label)
    own = read_text(os.path.join(HERE, "LICENSE"))
    out = []
    w = out.append
    w("ChatMatrix Reader - third-party notices")
    w("=" * 60)
    w("")
    w("ChatMatrix Reader itself is released under the MIT license:")
    w("")
    w(own)
    w("")
    w("It contains, or downloads, the following work of others. Their licenses are given here as they ask.")
    w("")
    w("-" * 60)
    w("1. The voice recognition (a separate download: extensions/stt)")
    w("-" * 60)
    w("")
    w("- whisper.cpp / ggml (https://github.com/ggml-org/whisper.cpp), MIT license: built into the engine program cmr-stt.exe. The engine is downloaded apart")
    w("  from this program and comes with its own copy of the license (LICENSE-whisper.cpp.txt, in the engine folder).")
    w("- OpenAI Whisper models (https://github.com/openai/whisper), MIT license: the program downloads the model files from")
    w("  https://huggingface.co/ggerganov/whisper.cpp; they are not part of this package.")
    w("- Vulkan is a registered trademark of the Khronos Group Inc. (the GPU engine uses the Vulkan driver of the system).")
    w("")
    w("-" * 60)
    w(f"2. Rust libraries built into the program ({len(crates)}; target {target})")
    w("-" * 60)
    w("")
    w("Name, version, license, address. Texts of the licenses: section 3 (the crates that are listed there under the same text share it).")
    w("Rust standard library (MIT OR Apache-2.0): https://github.com/rust-lang/rust")
    w("")
    for p in crates:
        w(f"- {p['name']} {p['version']}  [{p.get('license') or 'see its license file'}]  {p.get('repository') or p.get('homepage') or ''}".rstrip())
    w("")
    if mpl:
        w("Mozilla Public License 2.0 (MPL-2.0): these crates are used unchanged. Their source code is available from the addresses above, and from")
        w("https://crates.io/crates/<name>/<version>:")
        for p in mpl:
            w(f"  {p['name']} {p['version']}  {p.get('repository') or ''}".rstrip())
        w("")
    w("-" * 60)
    w("3. License texts")
    w("-" * 60)
    for n, g in enumerate(sorted(groups.values(), key=lambda g: (g["crates"][0].lower(), len(g["text"]))), 1):
        w("")
        w(f"[{n}] used by: " + ", ".join(sorted(set(g["crates"]), key=str.lower)))
        w("")
        w(g["text"])
        w("")
        w("- " * 30)
    if missing:
        w("")
        w("-" * 60)
        w("4. Crates that ship no license file")
        w("-" * 60)
        w("")
        w("The license is the standard text of the name given (https://spdx.org/licenses/<name>.html); the authors are named as the crate names them.")
        w("")
        for p in missing:
            who = ", ".join(p.get("authors") or []) or "(no authors given)"
            w(f"- {p['name']} {p['version']}  [{p.get('license') or 'unknown'}]  {p.get('repository') or ''}")
            w(f"    authors: {who}")
    w("")
    return "\n".join(out), len(crates), len(groups), [f"{p['name']} {p['version']}" for p in missing]


def main(argv):
    ap = argparse.ArgumentParser(description="THIRD-PARTY-NOTICES.txt from the crates built into the program")
    ap.add_argument("--target", default="x86_64-pc-windows-msvc")
    ap.add_argument("--out", default=os.path.join(HERE, "THIRD-PARTY-NOTICES.txt"))
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args(argv)
    try:
        meta = metadata(a.target, a.offline)
    except (OSError, subprocess.CalledProcessError) as e:
        detail = getattr(e, "stderr", b"") or b""
        sys.exit(f"cargo metadata failed ({e}). {detail.decode('utf-8', 'replace')[-400:]}\nIs cargo installed and has the program been built here once?")
    text, n_crates, n_texts, missing = build(meta, a.target)
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"{n_crates} libraries, {n_texts} different license texts -> {a.out} ({len(text) / 1024:.0f} KB)")
    if missing:
        print(f"{len(missing)} without a license file (listed by name): " + ", ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
