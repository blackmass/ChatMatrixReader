r"""Shows how far the release is: what is done, what is missing, and the next step. Changes nothing.

    py tools\release_status.py

It looks at: the version (a pre-release mark 'dev' cannot be released), git (uncommitted changes, not pushed), the engines (engine\stt\dist: the exe and the
license / version files the release needs), the catalog (which release the engine addresses point to), the program (ChatMatrixReader.exe, newer than the sources?),
THIRD-PARTY-NOTICES.txt and release-out\<tag>\ (the zip, the engine files). The order of a release: docs/RELEASE.md (the six steps)."""
import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_zip import display_version, version      # noqa: E402

OK, NO, WARN = "[ OK ]", "[ -- ]", "[ !! ]"
NEED = ["cmr-stt.exe", "cmr-stt.exe.sha256", "LICENSE-whisper.cpp.txt", "LICENSE.txt", "version.json"]


def git(*args):
    try:
        r = subprocess.run(["git"] + list(args), cwd=HERE, capture_output=True)
        return r.returncode, r.stdout.decode("utf-8", "replace").strip()
    except OSError:
        return 127, ""


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def newest_source():
    newest, name = 0.0, ""
    for base in ("src-tauri/src", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "src-tauri/capabilities", "src-tauri/build.rs"):
        p = os.path.join(HERE, base)
        items = os.walk(p) if os.path.isdir(p) else [(os.path.dirname(p), [], [os.path.basename(p)])]
        for root, _, files in items:
            for f in files:
                m = os.path.getmtime(os.path.join(root, f))
                if m > newest:
                    newest, name = m, os.path.relpath(os.path.join(root, f), HERE)
    return newest, name


def main():
    shown, plain = display_version(), version()
    tag = "v" + shown
    steps, todo = [], []

    def line(mark, text):
        steps.append(f"{mark} {text}")

    # 1. version
    pre_dev = shown.endswith("-dev")
    versions_ok = True
    for label, path, pat in (("Cargo.toml", "src-tauri/Cargo.toml", r'\[package\][^\[]*?\nversion = "([^"]*)"'), ("tauri.conf.json", "src-tauri/tauri.conf.json", r'"version": "([^"]*)"')):
        m = re.search(pat, open(os.path.join(HERE, path), encoding="utf-8").read(), re.S)
        if not m or m.group(1) != plain:
            versions_ok = False
    if pre_dev:
        line(WARN, f"버전 {shown}: 개발 중 표시(dev)가 있어서 릴리즈를 만들 수 없습니다.")
        todo.append("버전을 정식으로 바꾸기: set_version.bat " + plain + "  (그다음 커밋)")
    elif not versions_ok:
        line(WARN, f"버전 {shown}: Cargo.toml / tauri.conf.json의 버전이 version.js와 다릅니다.")
        todo.append("set_version.bat 실행 → 코어를 다시 빌드해야 합니다")
    else:
        line(OK, f"버전 {shown} (태그 {tag})")

    # 2. git
    code, branch = git("branch", "--show-current")
    dirty = None
    if code == 0 and branch:
        _, status = git("status", "--porcelain")
        dirty = [l for l in status.splitlines() if l.strip()]
        _, last = git("log", "-1", "--format=%h %s")
        ahead = ""
        c2, up = git("rev-parse", "--abbrev-ref", "@{u}")
        if c2 == 0:
            _, n = git("rev-list", "--count", f"{up}..HEAD")
            ahead = f", 푸시 안 된 커밋 {n}개" if n not in ("", "0") else ", 푸시됨"
        else:
            ahead = ", 아직 푸시 안 한 브랜치"
        if dirty:
            line(WARN, f"git ({branch}): 커밋 안 된 변경 {len(dirty)}개 | 마지막 커밋: {last}{ahead}")
        else:
            line(OK, f"git ({branch}): 모두 커밋됨 | 마지막 커밋: {last}{ahead}")
        if "푸시 안 된" in ahead or "아직 푸시 안 한" in ahead:
            todo.append("커밋 푸시: 푸시되지 않은 커밋이 있습니다")
    else:
        line(WARN, "git: 이 폴더는 git 저장소가 아니거나 git을 찾을 수 없습니다.")

    # 3. engines
    engine_ok = True
    engine_note = []
    dist = os.path.join(HERE, "engine", "stt", "dist")
    kinds = [k for k in ("cpu", "vulkan") if os.path.isfile(os.path.join(dist, f"engine-{k}", "cmr-stt.exe"))]
    if not kinds:
        line(NO, "엔진: engine\\stt\\dist에 빌드된 엔진이 없습니다 (engine build.bat).")
        engine_ok = False
        todo.append("엔진 빌드: engine\\stt\\build.bat (그리고 build.bat vulkan)")
    else:
        for k in kinds:
            folder = os.path.join(dist, f"engine-{k}")
            missing = [n for n in NEED if not os.path.isfile(os.path.join(folder, n))]
            if missing:
                engine_ok = False
                engine_note.append(f"{k}: 빠진 파일 {', '.join(missing)}")
        fixable = [k for k in kinds if any(not os.path.isfile(os.path.join(dist, f"engine-{k}", n)) for n in NEED[2:])]
        if "cpu" not in kinds or "vulkan" not in kinds:
            engine_note.append("종류가 하나뿐입니다 (CPU, Vulkan 둘 다 올리는 것이 원칙)")
        if engine_note:
            line(WARN, "엔진: " + " / ".join(engine_note))
            if not engine_ok:
                todo.append("엔진 정리: release_engines.bat (빠진 라이선스와 version.json은 이전 빌드가 남긴 것에서 만들어 줍니다. 엔진을 다시 빌드할 필요는 없습니다)")
        else:
            line(OK, "엔진: " + ", ".join(kinds) + " 빌드됨 (라이선스, 해시, version.json 있음)")
        if dirty is not None:
            ec, estat = git("status", "--porcelain", "--", "engine/stt", "LICENSE")
            if estat.strip():
                line(WARN, "엔진 소스(engine/stt)에 커밋 안 된 변경이 있습니다: 커밋하고 엔진을 다시 빌드해야 릴리즈할 수 있습니다.")

    # 4. catalog
    cat = open(os.path.join(HERE, "app", "core", "voice_catalog.js"), encoding="utf-8").read()
    tags = sorted(set(re.findall(r"/releases/download/(v[^/]+)/", cat)))
    if not tags:
        line(NO, "카탈로그: 엔진 받을 주소가 아직 비어 있습니다 (release_engines.bat 전).")
        todo.append("엔진 정리: release_engines.bat (카탈로그에 주소와 해시가 채워집니다)")
    elif tags == [tag]:
        line(OK, f"카탈로그: 엔진 주소가 {tag}를 가리킵니다.")
    else:
        line(WARN, f"카탈로그: 엔진 주소가 {', '.join(tags)}를 가리킵니다 (이번 태그는 {tag}).")
        todo.append("엔진 주소를 이번 태그로: release_engines.bat (이전 릴리즈의 엔진을 그대로 쓰려면 이 줄은 무시)")

    # 5. release-out
    out = os.path.join(HERE, "release-out", tag)
    outfiles = sorted(os.listdir(out)) if os.path.isdir(out) else []
    engine_staged = "SHA256SUMS-engine.txt" in outfiles
    if engine_staged:
        line(OK, f"release-out\\{tag}: 엔진 파일 정리됨")
    else:
        line(NO, f"release-out\\{tag}: 엔진 파일이 아직 없습니다 (release_engines.bat).")
        if engine_ok and kinds and tags != [tag]:
            pass

    # 6. program
    exe = os.path.join(HERE, "ChatMatrixReader.exe")
    old = os.path.join(HERE, "ChatMatrixProto.exe")
    if os.path.isfile(old):
        line(WARN, "예전 ChatMatrixProto.exe가 남아 있습니다 (지워도 됩니다).")
    if not os.path.isfile(exe):
        line(NO, "프로그램: ChatMatrixReader.exe가 없습니다 (build.bat).")
        todo.append("코어 빌드: build.bat")
    else:
        newest, name = newest_source()
        if os.path.getmtime(exe) + 2 < newest:
            line(WARN, f"프로그램: ChatMatrixReader.exe가 {name}보다 오래됐습니다 (다시 빌드해야 합니다).")
            todo.append("코어 빌드: build.bat")
        else:
            line(OK, "프로그램: ChatMatrixReader.exe가 최신 소스로 빌드되어 있습니다.")

    # 7. zip
    zips = [f for f in outfiles if f.endswith("-windows-x64.zip")]
    if zips:
        line(OK, f"본체 zip: {zips[0]}")
    else:
        line(NO, f"본체 zip: release-out\\{tag}에 아직 없습니다 (release_core.bat).")

    print(f"\n=== 릴리즈 상태 ({tag}) ===\n")
    print("\n".join(steps))

    # next step (in the order of the release)
    nxt = None
    if pre_dev or not versions_ok:
        nxt = todo[0]
    elif not engine_ok:
        nxt = next((t for t in todo if t.startswith("엔진")), None)
        if nxt and "release_engines" in nxt and not tags:
            nxt = "엔진 정리: release_engines.bat (빠진 파일은 자동으로 만들어 줍니다)"
    elif not tags or (tags != [tag] and not engine_staged):
        nxt = "엔진 정리: release_engines.bat"
    elif dirty:
        nxt = "커밋과 푸시 (카탈로그와 바뀐 파일을 올림)"
    elif any("푸시" in t for t in todo):
        nxt = "커밋 푸시"
    elif not os.path.isfile(exe) or any("코어 빌드" in t for t in todo):
        nxt = "코어 빌드: build.bat"
    elif not zips:
        nxt = "본체 zip: release_core.bat"
    print("\n=== 다음 할 일 ===")
    if nxt:
        print(nxt)
    else:
        print(f"릴리즈 파일이 다 준비되었습니다: release-out\\{tag}\\ 의 파일을 깨끗한 환경에서 실행해 확인하세요.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
