r"""Runs every check the project has, each with the time it NORMALLY takes, and says so when one takes much longer than that.

    py tools\check.py            all checks
    py tools\check.py unit e2e   only these (unit, locale, browser, e2e)

The point is not only the result: all of these run on this machine and wait for nothing outside it, so a check that takes much longer than its normal time is not
"slow", it is STUCK (a page waiting for an event that never comes, a loop). Such a check is stopped at about three times its normal time and reported as stuck,
with what to look at; one that finishes but takes more than twice the normal time is reported as slow. The normal times are for a development PC (the numbers in
BASE); raise them when the project grows by much.
"""
import re
import subprocess
import sys
import time

BASE = {          # name: (command, normal seconds)
    "unit": (["node", "tests/run.mjs"], 12),
    "locale": (["node", "tools/locale_keys.mjs", "locale/en-US.txt"], 3),
    "browser": (["node", "tests/browser/run.mjs"], 6),
    "e2e": (["node", "tests/browser/e2e.mjs"], 36),
}


def main():
    names = [a for a in sys.argv[1:] if a in BASE] or list(BASE)
    bad = 0
    for name in names:
        cmd, normal = BASE[name]
        limit = normal * 3 + 5
        t0 = time.time()
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=limit)
            out = (r.stdout + r.stderr).decode("utf-8", "replace")
            code = r.returncode
        except subprocess.TimeoutExpired as e:
            took = time.time() - t0
            tail = ((e.stdout or b"") + (e.stderr or b"")).decode("utf-8", "replace").strip().splitlines()[-3:]
            print(f"[STUCK] {name}: stopped after {took:.0f} s (normal {normal} s). Something waits for something that never comes. Last lines: {' | '.join(tail)}")
            bad += 1
            continue
        took = time.time() - t0
        fails = [l.strip() for l in out.splitlines() if "FAIL" in l or "ERROR" in l]
        last = [l.strip() for l in out.splitlines() if l.strip()][-1:] or [""]
        verdict = "ok" if code == 0 and not fails else "FAILED"
        speed = "" if took <= normal * 2 else f"   [SLOW: {took:.0f} s, normal {normal} s: look for a wait that is too long before running it again]"
        print(f"[{verdict}] {name}: {took:.0f} s{speed}   {last[0][:90]}")
        for l in fails[:6]:
            print("        " + l[:200])
        if verdict != "ok":
            bad += 1
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
