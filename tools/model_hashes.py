r"""The SHA-256 of the Whisper models, from the official place, written into app/core/voice_catalog.js (so the program checks every model it downloads).

    py tools\model_hashes.py                 shows the hash and size of every model of the catalog (changes nothing)
    py tools\model_hashes.py --write         puts the hashes into app\core\voice_catalog.js (a hash that is already there and differs is NOT replaced: it is shown)
    py tools\model_hashes.py --check         also compares the models you have downloaded (extensions\stt\models\ggml-*.bin) with the official hashes
    py tools\model_hashes.py --from-dir D    reads the pointer files from folder D (ggml-<name>.bin = the small text file) instead of the internet (for tests)

Where the numbers come from: Hugging Face keeps each big file in Git LFS; asking for the "raw" file of the repository gives a tiny text (the LFS pointer):
    version https://git-lfs.github.com/spec/v1
    oid sha256:<64 hex digits>
    size <bytes>
the oid is the SHA-256 of the file as the repository holds it. Only the first bytes are read, so no model is downloaded.
(A hash from the same server that sends the file shows that a download is complete and not damaged, and that it stays the same later; it cannot prove that the
repository itself was not changed. Compare it with the page of the file on huggingface.co if you want to be sure.)"""
import hashlib
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(HERE, "app", "core", "voice_catalog.js")
MODELS_DIR = os.path.join(HERE, "extensions", "stt", "models")
RAW = "https://huggingface.co/ggerganov/whisper.cpp/raw/main/ggml-{name}.bin"
LINE = re.compile(r"^(\s*)(?P<key>'[^']+'|[A-Za-z0-9_-]+): \{ url: MODEL_URL\('(?P<name>[^']+)'\), sha256: '(?P<sha>[0-9a-fA-F]*)', mb: (?P<mb>\d+) \},\s*$")


def catalog_models(text):
    out = []
    for line in text.splitlines():
        m = LINE.match(line)
        if m:
            out.append((m.group("name"), m.group("sha").lower(), int(m.group("mb"))))
    return out


def parse_pointer(text, name):
    sha = re.search(r"^oid sha256:([0-9a-f]{64})\s*$", text, re.M)
    size = re.search(r"^size (\d+)\s*$", text, re.M)
    if not (text.startswith("version https://git-lfs.github.com/spec/v1") and sha and size):
        raise ValueError(f"{name}: the answer is not a Git LFS pointer (first bytes: {text[:80]!r})")
    return sha.group(1), int(size.group(1))


def pointer(name, from_dir):
    if from_dir:
        with open(os.path.join(from_dir, f"ggml-{name}.bin"), "rb") as f:
            return parse_pointer(f.read(2048).decode("utf-8", "replace"), name)
    req = urllib.request.Request(RAW.format(name=name), headers={"User-Agent": "chatmatrix-model-hashes"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return parse_pointer(r.read(2048).decode("utf-8", "replace"), name)


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv):
    write, check = "--write" in argv, "--check" in argv
    from_dir = argv[argv.index("--from-dir") + 1] if "--from-dir" in argv else None
    text = open(CATALOG, encoding="utf-8").read()
    models = catalog_models(text)
    if not models:
        sys.exit("voice_catalog.js: no model lines found (the file looks different from what this tool expects)")
    found, problems = {}, 0
    print(f"{'model':16} {'size (bytes)':>14}  sha256 (official)")
    for name, have, mb in models:
        try:
            sha, size = pointer(name, from_dir)
        except Exception as e:
            print(f"{name:16} {'-':>14}  ERROR: {e}")
            problems += 1
            continue
        found[name] = sha
        note = ""
        if have and have != sha:
            note = "   <-- the catalog has a DIFFERENT hash: " + have
            problems += 1
        if abs(size / 1048576 - mb) > max(3, mb * 0.05):
            note += f"   (size is {size / 1048576:.0f} MB, the catalog says about {mb} MB)"
        print(f"{name:16} {size:>14}  {sha}{note}")
        if check:
            path = os.path.join(MODELS_DIR, f"ggml-{name}.bin")
            if os.path.isfile(path):
                got = file_sha256(path)
                print(f"{'':16} {'':>14}  your file: {'OK, the same' if got == sha else 'DIFFERENT: ' + got}")
                if got != sha:
                    problems += 1
    if write and found:
        lines, changed = text.splitlines(keepends=True), 0
        for i, line in enumerate(lines):
            m = LINE.match(line.rstrip("\r\n"))
            if m and m.group("name") in found and not m.group("sha"):
                lines[i] = line.replace("sha256: ''", f"sha256: '{found[m.group('name')]}'", 1)
                changed += 1
        if changed:
            open(CATALOG, "w", encoding="utf-8", newline="").write("".join(lines))
        print(f"\n{changed} hash(es) written to {CATALOG}")
    elif not write:
        print("\n(nothing was changed; add --write to put the hashes into voice_catalog.js)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
