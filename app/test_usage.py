import json, os, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage

d = tempfile.mkdtemp()
usage.PATH = os.path.join(d, "usage.json")

def fresh():
    usage._state = None

assert usage.total() == 0
assert usage.add(40_000) is None
assert usage.add(59_999) is None              # 99,999
assert usage.add(1) == 100_000                # passes 100k
assert usage.add(10) is None
assert usage.add(250_000) == 350_010          # jumps past 200k and 300k: one notice with the total
assert usage.add(150_000) == 500_010
fresh()                                       # survives a restart
assert usage.total() == 500_010
assert usage.add(1) is None                   # no repeated notice for the same level
# new month starts again
fresh()
json.dump({"month": "2000-01", "chars": 999, "notified": 9}, open(usage.PATH, "w"))
assert usage.total() == 0
# broken file
fresh()
open(usage.PATH, "w").write("not json")
assert usage.total() == 0 and usage.add(5) is None
print("usage ok")
