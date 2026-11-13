"""NVIDIA's own management library (nvml.dll - it comes with the graphics driver, nothing to install), through ctypes.

    Nvml.open()  ->  Nvml or None (no NVIDIA driver, or no library): the caller simply goes without
    n.card(i)    ->  {"total", "used", "util", "temp"} of the whole card (bytes / percent / degrees; None where it cannot be read)
    n.process_mem(pids)  ->  video memory in use by these processes, or None when the driver does not tell
                         (the driver model of a normal GeForce under Windows (WDDM) often answers "not available" for it)

Everything is read-only, and every call is guarded: a driver that answers oddly gives None, never an exception.
"""
import ctypes
import sys

NOT_AVAILABLE = 0xFFFFFFFFFFFFFFFF          # NVML_VALUE_NOT_AVAILABLE
INSUFFICIENT_SIZE = 7


class _Mem(ctypes.Structure):
    _fields_ = [("total", ctypes.c_ulonglong), ("free", ctypes.c_ulonglong), ("used", ctypes.c_ulonglong)]


class _Util(ctypes.Structure):
    _fields_ = [("gpu", ctypes.c_uint), ("memory", ctypes.c_uint)]


class _Proc(ctypes.Structure):                # nvmlProcessInfo_v2_t (the layout of the _v2 / _v3 calls)
    _fields_ = [("pid", ctypes.c_uint), ("usedGpuMemory", ctypes.c_ulonglong),
                ("gpuInstanceId", ctypes.c_uint), ("computeInstanceId", ctypes.c_uint)]


def _find():
    if sys.platform == "win32":
        names = ["nvml.dll", r"C:\Program Files\NVIDIA Corporation\NVSMI\nvml.dll"]
        loader = ctypes.WinDLL
    else:
        names = ["libnvidia-ml.so.1"]
        loader = ctypes.CDLL
    last = None
    for n in names:
        try:
            return loader(n)
        except OSError as e:
            last = e
    raise OSError(f"no NVML library ({last})")


def _prepare(lib):
    """Argument types for the calls we make (a fake library in the tests may refuse attributes: that is fine)."""
    c_void, c_uint, p = ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER
    table = {
        "nvmlInit_v2": [], "nvmlShutdown": [],
        "nvmlDeviceGetCount_v2": [p(c_uint)],
        "nvmlDeviceGetHandleByIndex_v2": [c_uint, p(c_void)],
        "nvmlDeviceGetMemoryInfo": [c_void, p(_Mem)],
        "nvmlDeviceGetUtilizationRates": [c_void, p(_Util)],
        "nvmlDeviceGetTemperature": [c_void, c_uint, p(c_uint)],
        "nvmlDeviceGetComputeRunningProcesses_v3": [c_void, p(c_uint), c_void],
        "nvmlDeviceGetComputeRunningProcesses_v2": [c_void, p(c_uint), c_void],
    }
    for name, args in table.items():
        f = getattr(lib, name, None)
        if f is not None:
            try:
                f.argtypes = args
                f.restype = ctypes.c_int
            except (AttributeError, TypeError):
                pass


class Nvml:
    def __init__(self, lib):
        self.lib = lib
        _prepare(lib)
        if lib.nvmlInit_v2() != 0:
            raise OSError("nvmlInit failed")
        count = ctypes.c_uint(0)
        if lib.nvmlDeviceGetCount_v2(ctypes.byref(count)) != 0:
            raise OSError("no NVIDIA device")
        self.handles = []
        for i in range(count.value):
            h = ctypes.c_void_p()
            if lib.nvmlDeviceGetHandleByIndex_v2(i, ctypes.byref(h)) == 0:
                self.handles.append(h)
        if not self.handles:
            raise OSError("no NVIDIA device")

    @classmethod
    def open(cls):
        try:
            return cls(_find())
        except Exception:
            return None

    def count(self):
        return len(self.handles)

    def card(self, i=0):
        out = {"total": None, "used": None, "util": None, "temp": None}
        try:
            h = self.handles[i]
            m = _Mem()
            if self.lib.nvmlDeviceGetMemoryInfo(h, ctypes.byref(m)) == 0:
                out["total"], out["used"] = int(m.total), int(m.used)
            u = _Util()
            if self.lib.nvmlDeviceGetUtilizationRates(h, ctypes.byref(u)) == 0:
                out["util"] = int(u.gpu)
            t = ctypes.c_uint(0)
            if self.lib.nvmlDeviceGetTemperature(h, 0, ctypes.byref(t)) == 0:        # 0 = NVML_TEMPERATURE_GPU
                out["temp"] = int(t.value)
        except Exception:
            pass
        return out

    def _procs(self, h):
        fn = getattr(self.lib, "nvmlDeviceGetComputeRunningProcesses_v3", None) or getattr(self.lib, "nvmlDeviceGetComputeRunningProcesses_v2", None)
        if fn is None:
            return None
        count = ctypes.c_uint(0)
        rc = fn(h, ctypes.byref(count), None)
        if rc == 0 and count.value == 0:
            return []
        if rc != INSUFFICIENT_SIZE and rc != 0:
            return None
        n = count.value + 8                                   # a few more: processes can start between the two calls
        arr = (_Proc * n)()
        count = ctypes.c_uint(n)
        if fn(h, ctypes.byref(count), arr) != 0:
            return None
        return [arr[k] for k in range(min(count.value, n))]

    def process_mem(self, pids):
        """Video memory of the given processes on all cards; None when none of them is listed with a usable number."""
        total, got = 0, False
        try:
            for h in self.handles:
                for pr in self._procs(h) or []:
                    if pr.pid in pids and pr.usedGpuMemory != NOT_AVAILABLE:
                        total += int(pr.usedGpuMemory)
                        got = True
        except Exception:
            return None
        return total if got else None

    def close(self):
        try:
            self.lib.nvmlShutdown()
        except Exception:
            pass
