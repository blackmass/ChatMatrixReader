r"""Lists the files of the project with their size and SHA-256, so that two copies of the project (this PC and another one, or a copy that was overwritten by a zip) can be compared.

    py tools\manifest.py                     writes manifest.txt in the project folder: one line per file, "sha256  size  path" (the files git would upload: .gitignore is the rule)
    py tools\manifest.py --all              the same, but with the files git leaves out as well (docs/, addon/, plugins/, Glossary.txt ...): what is kept only on this PC; not build output, logs, zips
    py tools\manifest.py other-manifest.txt compares this folder with a manifest made on another copy: what is only here, what is only there, what is different (add --all if the other was made with --all)

Only a list is written: no file of the project is changed (manifest.txt / manifest-all.txt are the only things made)."""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "tools"))
import make_zip                                                              # the same rule as the zips: the files git would upload (.gitignore)

OUT = os.path.join(HERE, "manifest.txt")
OUT_ALL = os.path.join(HERE, "manifest-all.txt")


SKIP_DIRS = {"target", "__pycache__", "node_modules", "webview-data", "logs", "extensions", "out", "release-out", "release-mac", ".git"}


def walk_all():
    names = []
    for root, dirs, files in os.walk(HERE):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.lower().endswith((".zip", ".exe")) or f in ("manifest.txt", "manifest-all.txt", "config.json", "usage.json"):
                continue
            names.append(os.path.relpath(os.path.join(root, f), HERE).replace(os.sep, "/"))
    return sorted(names)


def mine(everything=False):
    names = walk_all() if everything else make_zip.all_files()[0]
    out = {}
    for rel in names:
        if rel in ("manifest.txt", "manifest-all.txt") or rel.endswith(".exe"):
            continue
        data = open(os.path.join(HERE, rel), "rb").read()
        text = data.replace(b"\r\n", b"\n")                                   # (a copy made on Windows and one made elsewhere differ only by line ends: they count as the same)
        out[rel] = (hashlib.sha256(text).hexdigest(), len(text))
    return out


def read(path):
    out = {}
    for line in open(path, encoding="utf-8").read().splitlines():
        parts = line.split("  ", 2)
        if len(parts) == 3:
            out[parts[2]] = (parts[0], int(parts[1]))
    return out


def main():
    args = [a for a in sys.argv[1:] if a != "--all"]
    everything = "--all" in sys.argv[1:]
    here = mine(everything)
    if not args:
        with open(OUT_ALL if everything else OUT, "w", encoding="utf-8", newline="\n") as f:
            for rel in sorted(here):
                f.write(f"{here[rel][0]}  {here[rel][1]}  {rel}\n")
        print(f"{len(here)} files -> {OUT_ALL if everything else OUT}")
        return
    other = read(args[0])
    only_here = sorted(set(here) - set(other)); only_there = sorted(set(other) - set(here))
    differ = sorted(p for p in set(here) & set(other) if here[p][0] != other[p][0])
    print(f"same: {len(set(here) & set(other)) - len(differ)}   different: {len(differ)}   only here: {len(only_here)}   only in the other: {len(only_there)}\n")
    for title, items in (("DIFFERENT (same name, other content)", differ), ("ONLY HERE", only_here), ("ONLY IN THE OTHER", only_there)):
        if items:
            print(title)
            for p in items:
                print("   " + p)
            print()


if __name__ == "__main__":
    main()
