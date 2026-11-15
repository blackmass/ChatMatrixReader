"""Self-test for resmeter: the pure parts, and (on Linux) a real busy child process."""
import subprocess
import sys
import time

import resmeter as rm

assert rm.fmt_bytes(None) == "-" and rm.fmt_bytes(512 * 1024 ** 2) == "512 MB" and rm.fmt_bytes(2.5 * 1024 ** 3) == "2.5 GB"
assert rm.fmt_pct(None) == "-" and rm.fmt_pct(12.4) == "12%"

w = rm.Window(10)
assert w.avg() is None and w.max() is None
for t, v in ((0, 0), (1, 0), (2, 30), (3, 0)):
    w.add(v, t)
assert w.max() == 30 and abs(w.avg() - 7.5) < 1e-9
w.add(None, 4)
assert len(w.items) == 4, "None is not a reading"
w.add(0, 13)                                             # the first readings are older than 10 s now
assert w.max() == 0 and len(w.items) == 2, len(w.items)

# GPU: the Task Manager rule - engines of one kind add up, the busiest kind counts, only our processes
eng = [("pid_10_luid_0x0_0x1_phys_0_eng_0_engtype_3D", 5.0), ("pid_10_luid_0x0_0x1_phys_0_eng_1_engtype_3D", 3.0),
       ("pid_10_luid_0x0_0x1_phys_0_eng_5_engtype_Compute_0", 20.0), ("pid_99_luid_0x0_0x1_phys_0_eng_0_engtype_3D", 70.0),
       ("pid_11_luid_0x0_0x1_phys_0_eng_5_engtype_Compute_0", 4.0)]
assert rm.gpu_percent(eng, {10, 11}) == 24.0, rm.gpu_percent(eng, {10, 11})
assert rm.gpu_percent(eng, {5}) == 0.0 and rm.gpu_percent([], {10}) == 0.0
assert rm.gpu_percent([("pid_1_x_engtype_3D", 250.0)], {1}) == 100.0
mem = [("pid_10_luid_0x0_0x1_phys_0", 1000.0), ("pid_11_luid_0x0_0x1_phys_0", 24.0), ("pid_99_luid_0x0_0x1_phys_0", 5e9)]
assert rm.vram_bytes(mem, {10, 11}) == 1024.0 and rm.vram_bytes(mem, set()) == 0.0

ada = [("luid_0x0_0x1_phys_0", 3.0e9), ("luid_0x0_0x2_phys_0", 1.0e9)]
assert rm.adapter_bytes(ada) == 4.0e9 and rm.adapter_bytes([]) == 0
assert rm.has_instance(mem, {10}) and not rm.has_instance(mem, {7}) and not rm.has_instance([], {10})

# no pid / unknown pid never raises
m = rm.ResourceMeter()
s = m.sample(0)
assert s.cpu is None and s.ram is None
if sys.platform.startswith("linux"):
    p = subprocess.Popen([sys.executable, "-c", "import time\nt=time.time()\nwhile time.time()-t<4: pass"])
    try:
        m.sample(p.pid)
        time.sleep(1.2)
        s = m.sample(p.pid)
        assert s.ram and s.ram > 1024 * 1024, s
        assert s.cpu is not None and s.cpu > 0.5 / (__import__("os").cpu_count() or 1) * 100 * 0.5, s      # one core busy
    finally:
        p.kill()
        p.wait()
    assert m.sample(p.pid).ram is None, "a finished process gives nothing"
m.close()
print("test_resmeter OK")

# ---- the WMI way (PowerShell helper): answer lines and the helper protocol, with a fake helper instead of PowerShell
import json as _json
import sys as _sys
r = rm.parse_wmi(_json.dumps({"e": [{"n": "pid_42_luid_0x0_0x1_phys_0_eng_3_engtype_Compute_0", "v": 7.5}], "m": {"n": "pid_42_luid_x_phys_0", "v": 2e9}}))
assert r and rm.gpu_percent(r[0], {42}) == 7.5 and rm.vram_bytes(r[1], {42}) == 2e9, r
assert rm.parse_wmi("nonsense") is None and rm.parse_wmi("[]") is None
assert rm.parse_wmi('{"e": null, "m": null}') == ([], [])
fake = "import sys,json\nfor l in sys.stdin:\n  ids=l.strip().split(',')\n  print(json.dumps({'e':[{'n':'pid_%s_x_engtype_3D_0'%ids[0],'v':3}],'m':[]}),flush=True)\n"
w = rm._Wmi([_sys.executable, "-c", fake])
got = w.query({7, 9})
assert got and got[0] == [("pid_7_x_engtype_3D_0", 3.0)] and got[1] == [], got
assert w.query({8})[0][0][0].startswith("pid_8_")
w.close()
w2 = rm._Wmi([_sys.executable, "-c", "pass"])             # a helper that ends at once (no PowerShell): not measurable, no hang
assert w2.query({1}, timeout=3) is None and w2.failed
w2.close()
print("test_resmeter: wmi OK")
