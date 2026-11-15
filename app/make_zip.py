"""Builds the release zip:  ChatMatrixReader v<version>.zip  (version from version.py), inside this folder (*.zip should be in .gitignore, so old zips are never packed into new ones).

Which files go in? Exactly the ones git would upload: everything in the folder that .gitignore does not exclude
(`git ls-files --cached --others --exclude-standard`). There is no second list to keep; .gitignore decides.
Files whose name starts with a dot (.gitignore, .gitattributes, ...) are left out of the zip.
The macOS launchers get their 'executable' flag set inside the zip.

Run:  py app\make_zip.py        (needs git on PATH; changes nothing in the repository)"""
import os
import subprocess
import sys
import zipfile

APP = os.path.dirname(os.path.abspath(__file__))
HERE = os.path.dirname(APP)                          # the main folder (the repository root): this file lives in its app/ folder
FOLDER = "ChatMatrixReader"                          # the folder name inside the zip
EXECUTABLE = {"run.command", "launch"}               # macOS launchers (by file name)


def version():
    ns = {}
    with open(os.path.join(APP, "version.py"), encoding="utf-8") as f:
        exec(f.read(), ns)
    return ns["DISPLAY"]                              # e.g. 2.0.0-dev


def files():
    out = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                         cwd=HERE, capture_output=True, check=True).stdout.decode("utf-8")
    seen, result = set(), []
    for rel in out.split("\0"):
        if not rel or rel in seen:
            continue
        seen.add(rel)
        path = os.path.join(HERE, rel)
        if (os.path.basename(rel).startswith(".") or rel.lower().endswith(".zip")
                or not os.path.isfile(path)):        # dot-files; zips (earlier releases); deleted but still staged
            continue
        result.append(rel)
    return sorted(result)


def main():
    try:
        names = files()
    except (OSError, subprocess.CalledProcessError) as e:
        sys.exit(f"git을 실행하지 못했습니다 ({e}). git이 설치되어 있고 이 폴더가 저장소인지 확인하세요.")
    out_path = os.path.join(HERE, f"ChatMatrixReader v{version()}.zip")
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in names:
            src = os.path.join(HERE, rel)
            info = zipfile.ZipInfo.from_file(src, f"{FOLDER}/{rel}")
            mode = 0o755 if os.path.basename(rel) in EXECUTABLE else 0o644
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(src, "rb") as f:
                z.writestr(info, f.read())
    print(f"{len(names)}개 파일 -> {out_path}")
    for n in names:
        print("  ", n)


if __name__ == "__main__":
    main()
