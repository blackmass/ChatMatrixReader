"""Runs every app/test_*.py, each in its own process (they are plain scripts, not pytest tests).

    py app\run_tests.py            all of them
    py app\run_tests.py voice      only the ones whose name contains "voice"
Exit code 0 when all passed."""
import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main(argv):
    want = argv[1] if len(argv) > 1 else ""
    failed, count = [], 0
    for path in sorted(glob.glob(os.path.join(HERE, "test_*.py"))):
        name = os.path.basename(path)
        if want not in name:
            continue
        count += 1
        r = subprocess.run([sys.executable, path], cwd=HERE, capture_output=True, text=True, encoding="utf-8", errors="replace")
        print(("ok    " if r.returncode == 0 else "FAIL  ") + name)
        if r.returncode:
            failed.append(name)
            print("\n".join("      " + ln for ln in (r.stdout + r.stderr).strip().splitlines()[-8:]))
    print(f"\n{count - len(failed)}/{count} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
