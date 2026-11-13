"""How much of the computer a program (and the programs it started) uses: CPU, memory, graphics card.

    ResourceMeter().sample(pid)  ->  Sample          one reading; call it about once a second from a thread
    Window(seconds)                                  average / maximum of the last readings (pure, tested)
    fmt_bytes(n), fmt_pct(x)                         text helpers

Used by the options window to show what the voice recognition costs. Everything that is not available is None (shown as "-"),
and nothing here may ever raise into the caller.

Windows: CPU time and memory from the process itself; the graphics card from the performance counters the Task Manager shows
("GPU Engine" / "GPU Process Memory", per process, every vendor, Windows 10 1709+). No extra package is needed.
Linux: CPU and memory from /proc (for tests and for people running the reader there). macOS: nothing (all None).
"""
import base64
import collections
import json
import logging
import os
import queue
import re
import subprocess
import sys
import threading
import time

log = logging.getLogger("cmr.res")


# ------------------------------------------------------------------------------------------------ pure helpers
def fmt_bytes(n):
    if n is None:
        return "-"
    n = float(n)
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.1f} GB"
    return f"{n / 1024 ** 2:.0f} MB"


def fmt_pct(x):
    return "-" if x is None else f"{x:.0f}%"


class Window:
    """The readings of the last `seconds` seconds: average and maximum. A short burst (speech) is not lost in a plain average
    of a mostly quiet minute, and not mistaken for the normal load either."""

    def __init__(self, seconds=10.0):
        self.seconds = seconds
        self.items = collections.deque()

    def add(self, value, now):
        if value is not None:
            self.items.append((now, float(value)))
        while self.items and now - self.items[0][0] > self.seconds:
            self.items.popleft()

    def clear(self):
        self.items.clear()

    def avg(self):
        return sum(v for _, v in self.items) / len(self.items) if self.items else None

    def max(self):
        return max(v for _, v in self.items) if self.items else None


class Sample:
    __slots__ = ("cpu", "ram", "gpu", "vram", "vram_total", "vram_all")

    def __init__(self, cpu=None, ram=None, gpu=None, vram=None, vram_total=None, vram_all=None):
        self.cpu, self.ram, self.gpu, self.vram, self.vram_total, self.vram_all = cpu, ram, gpu, vram, vram_total, vram_all

    def __repr__(self):
        return f"Sample(cpu={self.cpu}, ram={self.ram}, gpu={self.gpu}, vram={self.vram}, vram_total={self.vram_total}, vram_all={self.vram_all})"


_ENG = re.compile(r"pid_(\d+)_.*?engtype_(\w+)", re.I)
_PROC = re.compile(r"pid_(\d+)_", re.I)


def gpu_percent(items, pids):
    """items: [(counter instance name, percent)] of "GPU Engine\\Utilization Percentage". The Task Manager's rule: the engines of
    one kind (3D, Compute, Copy ...) are added up, and the busiest kind is the load of the process; several processes add up."""
    kinds = {}
    for name, val in items:
        m = _ENG.search(name or "")
        if m and int(m.group(1)) in pids:
            kinds[m.group(2).lower()] = kinds.get(m.group(2).lower(), 0.0) + float(val)
    return min(100.0, max(kinds.values())) if kinds else 0.0


def vram_bytes(items, pids):
    """items: [(instance name, bytes)] of "GPU Process Memory\\Dedicated Usage": the sum over the processes."""
    total = 0.0
    for name, val in items:
        m = _PROC.search(name or "")
        if m and int(m.group(1)) in pids:
            total += float(val)
    return total


def adapter_bytes(items):
    """items: [(instance name, bytes)] of "GPU Adapter Memory\\Dedicated Usage": the video memory in use on the whole card (all programs)."""
    return sum(float(v) for _, v in items)


def has_instance(items, pids):
    """Does the counter list an instance (pid_N_...) of one of our processes? (The instances of a program that has not used the card yet
    do not exist: a counter that was set up before that never lists them.)"""
    for name, _v in items:
        m = _PROC.search(name or "")
        if m and int(m.group(1)) in pids:
            return True
    return False


# ------------------------------------------------------------------------------------------------ the meter
class ResourceMeter:
    def __init__(self):
        self._last_cpu = None            # (monotonic seconds, cpu seconds of the whole tree)
        self._impl = _WinImpl() if sys.platform == "win32" else (_LinuxImpl() if sys.platform.startswith("linux") else None)
        self._warned = False

    def sample(self, pid, extra_pids=None):
        """extra_pids: processes that belong to the program although the process tree does not show it (the program tells its own id)."""
        s = Sample()
        if self._impl is None or not pid:
            return s
        try:
            pids = self._impl.tree(pid)
            if not pids:
                self._last_cpu = None
                return s
            pids = set(pids) | {int(x) for x in (extra_pids or ()) if x}
            cpu_s, ram = self._impl.cpu_and_ram(pids)
            now = time.monotonic()
            if cpu_s is not None and self._last_cpu is not None and now > self._last_cpu[0]:
                s.cpu = max(0.0, min(100.0, (cpu_s - self._last_cpu[1]) / (now - self._last_cpu[0]) / (os.cpu_count() or 1) * 100.0))
            self._last_cpu = (now, cpu_s) if cpu_s is not None else None
            s.ram = ram
            g = self._impl.gpu(pids)
            if g:
                s.gpu, s.vram, s.vram_total, s.vram_all = g
        except Exception:
            if not self._warned:                                  # one line, not one per second
                self._warned = True
                log.exception("resource measurement failed")
        return s

    def close(self):
        if self._impl is not None:
            try:
                self._impl.close()
            except Exception:
                pass


# ------------------------------------------------------------------------------------------------ Linux (/proc)
class _LinuxImpl:
    def __init__(self):
        self.tick = os.sysconf("SC_CLK_TCK")
        self.page = os.sysconf("SC_PAGE_SIZE")

    @staticmethod
    def _stat(pid):
        with open(f"/proc/{pid}/stat", "rb") as f:
            raw = f.read().decode("utf-8", "replace")
        rest = raw[raw.rindex(")") + 2:].split()                  # after "pid (comm) "
        return rest                                                # rest[0]=state, [1]=ppid, [11]=utime, [12]=stime

    def tree(self, pid):
        kids = {}
        for d in os.listdir("/proc"):
            if d.isdigit():
                try:
                    kids.setdefault(int(self._stat(d)[1]), []).append(int(d))
                except (OSError, ValueError, IndexError):
                    pass
        try:
            self._stat(pid)
        except OSError:
            return set()
        out, todo = set(), [pid]
        while todo:
            p = todo.pop()
            if p not in out:
                out.add(p)
                todo.extend(kids.get(p, ()))
        return out

    def cpu_and_ram(self, pids):
        cpu, ram = 0.0, 0
        for p in pids:
            try:
                st = self._stat(p)
                cpu += (int(st[11]) + int(st[12])) / self.tick
                with open(f"/proc/{p}/statm") as f:
                    ram += int(f.read().split()[1]) * self.page
            except (OSError, ValueError, IndexError):
                pass
        return cpu, ram

    def gpu(self, pids):
        return None

    def close(self):
        pass


# ------------------------------------------------------------------------------------------------ Windows
class _WinImpl:
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ct, self.wt = ctypes, wintypes
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k = k
        k.OpenProcess.restype = wintypes.HANDLE
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]

        class PE(ctypes.Structure):
            _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                        ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                        ("szExeFile", ctypes.c_wchar * 260)]
        self.PE = PE
        k.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PE)]
        k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PE)]

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]
        self.PMC = PMC
        self.psapi = ctypes.WinDLL("psapi", use_last_error=True)
        self.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        self.pdh = _Pdh(ctypes, wintypes)
        self.wmi = _Wmi()
        self._vram_total = None
        self._vram_total_tried = False

    # ---- processes
    def tree(self, pid):
        ct, k = self.ct, self.k
        snap = k.CreateToolhelp32Snapshot(0x2, 0)                  # TH32CS_SNAPPROCESS
        if not snap or snap == ct.c_void_p(-1).value:
            return {pid}
        parents = {}
        try:
            e = self.PE()
            e.dwSize = ct.sizeof(self.PE)
            ok = k.Process32FirstW(snap, ct.byref(e))
            while ok:
                parents[e.th32ProcessID] = e.th32ParentProcessID
                ok = k.Process32NextW(snap, ct.byref(e))
        finally:
            k.CloseHandle(snap)
        if pid not in parents:
            return set()
        out, changed = {pid}, True
        while changed:
            changed = False
            for p, par in parents.items():
                if par in out and p not in out:
                    out.add(p)
                    changed = True
        return out

    def cpu_and_ram(self, pids):
        ct, wt, k = self.ct, self.wt, self.k
        cpu, ram, got = 0.0, 0, False
        for p in pids:
            h = k.OpenProcess(0x1000, False, p)                    # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                continue
            try:
                c, e, kt, ut = wt.FILETIME(), wt.FILETIME(), wt.FILETIME(), wt.FILETIME()
                if k.GetProcessTimes(h, ct.byref(c), ct.byref(e), ct.byref(kt), ct.byref(ut)):
                    cpu += ((kt.dwHighDateTime << 32 | kt.dwLowDateTime) + (ut.dwHighDateTime << 32 | ut.dwLowDateTime)) / 1e7
                    got = True
                m = self.PMC()
                m.cb = ct.sizeof(self.PMC)
                if self.psapi.GetProcessMemoryInfo(h, ct.byref(m), m.cb):
                    ram += m.WorkingSetSize
            finally:
                k.CloseHandle(h)
        return (cpu if got else None), ram

    # ---- graphics card
    ENG = "\\GPU Engine(*)\\Utilization Percentage"
    MEM = "\\GPU Process Memory(*)\\Dedicated Usage"
    _built = None                       # when the counters were set up (monotonic)
    _seen = False                       # an instance of our processes was listed at the last set-up
    _logged = 0

    def _rebuild(self, now, pids):
        """Set the counters up again. A wildcard counter lists the instances that exist AT THE MOMENT it is added: a program that starts
        using the card later (the model is loaded a few seconds after the process starts) would never show up. So this is repeated:
        every few seconds, and quickly while none of our processes is listed yet. The rate counters need two readings: a short pause."""
        self.pdh.reset()
        for path in (self.ENG, self.MEM):
            self.pdh.add(path)
        self.pdh.collect()
        time.sleep(0.25)
        self.pdh.collect()
        self._built = now
        mem = self.pdh.values(self.MEM)
        eng = self.pdh.values(self.ENG)
        self._seen = bool(mem) and has_instance(mem, pids) or bool(eng) and has_instance(eng, pids)
        if self._logged < 4 and (self._seen or self._logged == 0):
            self._logged += 1
            log.info("GPU counters set up: %d engine / %d memory instances, ours listed: %s (pids %s)",
                     len(eng or []), len(mem or []), self._seen, sorted(pids)[:6])

    def gpu(self, pids):
        """-> (gpu percent, video memory bytes, None, None) of THIS program (its processes), None where it is not known. Two ways to the
        same Windows counters: the counters directly (fast), and - when those do not list the program - WMI through a PowerShell
        helper. The whole card's figures are deliberately not used: they say nothing about this program."""
        now = time.monotonic()
        if self._built is None or now - self._built > 5.0 or (not self._seen and now - self._built > 1.5):
            self._rebuild(now, pids)
        else:
            self.pdh.collect()
        eng, mem = self.pdh.values(self.ENG), self.pdh.values(self.MEM)
        if has_instance(mem or [], pids) or has_instance(eng or [], pids):
            return (gpu_percent(eng, pids) if eng is not None else None), (vram_bytes(mem, pids) if mem is not None else None), None, None
        got = self.wmi.query(pids)                                  # the second way
        if got is not None:
            eng, mem = got
            if has_instance(mem, pids) or has_instance(eng, pids):
                return gpu_percent(eng, pids), vram_bytes(mem, pids), None, None
        return None

    def _total(self):
        """The card's memory size: only nvidia-smi tells it without extra packages (other makes: not shown)."""
        if not self._vram_total_tried:
            self._vram_total_tried = True
            try:
                import subprocess
                out = subprocess.run(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"], capture_output=True,
                                     timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.decode("utf-8", "replace")
                vals = [float(x) for x in out.split() if x.replace(".", "", 1).isdigit()]
                self._vram_total = max(vals) * 1024 * 1024 if vals else None
            except Exception:
                self._vram_total = None
        return self._vram_total

    def close(self):
        self.pdh.close()
        self.wmi.close()


_PS_SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $ids = @($l.Split(',') | Where-Object { $_ })
  $pat = '^pid_(' + ($ids -join '|') + ')_'
  $e = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.Name -match $pat } | ForEach-Object { [pscustomobject]@{ n = $_.Name; v = [double]$_.UtilizationPercentage } })
  $m = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object { $_.Name -match $pat } | ForEach-Object { [pscustomobject]@{ n = $_.Name; v = [double]$_.DedicatedUsage } })
  [Console]::Out.WriteLine(([pscustomobject]@{ e = $e; m = $m } | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}
"""


def parse_wmi(line):
    """One answer line of the helper -> ([(instance, percent)], [(instance, bytes)]) or None."""
    try:
        d = json.loads(line)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict):
        return None

    def items(x):
        if isinstance(x, dict):
            x = [x]
        return [(str(i.get("n", "")), float(i.get("v", 0) or 0)) for i in (x or []) if isinstance(i, dict)]
    return items(d.get("e")), items(d.get("m"))


class _Wmi:
    """The same GPU counters through WMI (Win32_PerfFormattedData_GPUPerformanceCounters_*), asked of a PowerShell helper that stays
    running (starting PowerShell every second would cost more than it measures). One line with the process ids in, one line of JSON out.
    Used only when the counters read directly do not list the program. No PowerShell / no such WMI class = query() gives None."""

    def __init__(self, cmd=None):
        self.cmd = cmd
        self.proc = None
        self.lines = queue.Queue()
        self.failed = False

    def _start(self):
        cmd = self.cmd or ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
                           base64.b64encode(_PS_SCRIPT.encode("utf-16-le")).decode()]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                     encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        threading.Thread(target=self._read, args=(self.proc,), name="wmi-reader", daemon=True).start()

    def _read(self, proc):
        try:
            for line in proc.stdout:
                self.lines.put(line)
        except Exception:
            pass
        self.lines.put(None)

    def query(self, pids, timeout=8.0):
        if self.failed:
            return None
        try:
            if self.proc is None or self.proc.poll() is not None:
                self.lines = queue.Queue()
                self._start()
            while not self.lines.empty():                          # an answer that came too late for an earlier question
                self.lines.get_nowait()
            self.proc.stdin.write(",".join(str(int(p)) for p in sorted(pids)) + "\n")
            self.proc.stdin.flush()
            line = self.lines.get(timeout=timeout)
        except (OSError, ValueError, queue.Empty):
            self.close()
            return None
        if line is None:
            self.failed = True                                      # the helper ended by itself (no PowerShell, or it refused)
            return None
        return parse_wmi(line)

    def close(self):
        p, self.proc = self.proc, None
        if p is not None:
            try:
                p.kill()
            except OSError:
                pass


class _Pdh:
    """Windows performance counters with wildcard instances: reset() / add(path) / collect() / values(path)."""
    PDH_MORE_DATA = 0x800007D2
    FMT = 0x200 | 0x8000                                         # PDH_FMT_DOUBLE | PDH_FMT_NOCAP100

    def __init__(self, ct, wt):
        self.ct, self.wt = ct, wt
        self.dll = ct.WinDLL("pdh")
        self.query = None
        self.counters = {}

        class VAL(ct.Structure):
            _fields_ = [("CStatus", wt.DWORD), ("v", ct.c_double)]

        class ITEM(ct.Structure):
            _fields_ = [("szName", ct.c_void_p), ("val", VAL)]
        self.ITEM = ITEM
        self.dll.PdhOpenQueryW.argtypes = [ct.c_wchar_p, ct.c_size_t, ct.POINTER(ct.c_void_p)]
        self.dll.PdhAddEnglishCounterW.argtypes = [ct.c_void_p, ct.c_wchar_p, ct.c_size_t, ct.POINTER(ct.c_void_p)]
        self.dll.PdhCollectQueryData.argtypes = [ct.c_void_p]
        self.dll.PdhGetFormattedCounterArrayW.argtypes = [ct.c_void_p, wt.DWORD, ct.POINTER(wt.DWORD), ct.POINTER(wt.DWORD), ct.c_void_p]
        self.dll.PdhCloseQuery.argtypes = [ct.c_void_p]

    def reset(self):
        """A new query: the wildcard counters list the instances that exist now."""
        self.close()
        q = self.ct.c_void_p()
        if self.dll.PdhOpenQueryW(None, 0, self.ct.byref(q)) != 0:
            raise OSError("PdhOpenQuery failed")
        self.query = q

    def add(self, path):
        c = self.ct.c_void_p()
        if self.dll.PdhAddEnglishCounterW(self.query, path, 0, self.ct.byref(c)) == 0:
            self.counters[path] = c
            return True
        return False

    def collect(self):
        if self.query is not None:
            self.dll.PdhCollectQueryData(self.query)

    def values(self, path):
        """-> [(instance, value)] ; None when this counter does not exist on this PC (old Windows, no GPU counters)."""
        c = self.counters.get(path)
        if c is None:
            return None
        ct = self.ct
        size, count = self.wt.DWORD(0), self.wt.DWORD(0)
        r = self.dll.PdhGetFormattedCounterArrayW(c, self.FMT, ct.byref(size), ct.byref(count), None)
        if r != self.PDH_MORE_DATA or size.value == 0:
            return []
        buf = ct.create_string_buffer(size.value)
        r = self.dll.PdhGetFormattedCounterArrayW(c, self.FMT, ct.byref(size), ct.byref(count), buf)
        if r != 0:
            return []
        items = ct.cast(buf, ct.POINTER(self.ITEM))
        out = []
        for i in range(count.value):
            it = items[i]
            if it.szName and it.val.CStatus in (0, 1):
                out.append((ct.wstring_at(it.szName), it.val.v))
        return out

    def close(self):
        if self.query is not None:
            self.dll.PdhCloseQuery(self.query)
            self.query = None
        self.counters = {}
