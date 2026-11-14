"""DEVELOPMENT TOOL (not used by the program; kept for diagnosing game stutter with test_flip.py).

Windows screen grabber that asks GDI for the plain screen pixels only: mss copies with  SRCCOPY | CAPTUREBLT  (CAPTUREBLT = "include
layered windows"); this one leaves CAPTUREBLT out. The small part of mss's interface that capture.py uses: .monitors (mss order: [0] the
whole desktop, then every monitor), .grab(area) -> object with .bgra / .width / .height, and use as a context manager (create it in the
thread that grabs). Written from the documented GDI calls; `api` is for tests (a stand-in for the Windows libraries).
"""
import ctypes
import logging
from ctypes import wintypes

log = logging.getLogger("cmr.capture")

SRCCOPY = 0x00CC0020          # (no CAPTUREBLT on purpose)
DIB_RGB_COLORS = 0
BI_RGB = 0


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
                ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


class Shot:
    def __init__(self, bgra, width, height):
        self.bgra, self.width, self.height = bgra, width, height


class _Api:
    """The few Windows functions, with their argument types (a handle is 64 bit: without these ctypes would cut it to 32)."""

    def __init__(self):
        u, g = ctypes.windll.user32, ctypes.windll.gdi32
        H = ctypes.c_void_p
        self.user32, self.gdi32 = u, g
        u.GetWindowDC.argtypes, u.GetWindowDC.restype = [H], H
        u.ReleaseDC.argtypes, u.ReleaseDC.restype = [H, H], ctypes.c_int
        g.CreateCompatibleDC.argtypes, g.CreateCompatibleDC.restype = [H], H
        g.CreateCompatibleBitmap.argtypes, g.CreateCompatibleBitmap.restype = [H, ctypes.c_int, ctypes.c_int], H
        g.SelectObject.argtypes, g.SelectObject.restype = [H, H], H
        g.BitBlt.argtypes = [H, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, H, ctypes.c_int, ctypes.c_int, wintypes.DWORD]
        g.BitBlt.restype = wintypes.BOOL
        g.GetDIBits.argtypes = [H, H, wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
        g.GetDIBits.restype = ctypes.c_int
        g.DeleteObject.argtypes, g.DeleteObject.restype = [H], wintypes.BOOL
        g.DeleteDC.argtypes, g.DeleteDC.restype = [H], wintypes.BOOL
        u.GetMonitorInfoW.argtypes, u.GetMonitorInfoW.restype = [H, ctypes.c_void_p], wintypes.BOOL

    def monitors(self):
        """[(left, top, width, height, primary)] of every monitor."""
        out = []
        proc_t = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(wintypes.RECT), ctypes.c_void_p)

        def cb(hmon, _hdc, _rect, _data):
            mi = MONITORINFO()
            mi.cbSize = ctypes.sizeof(MONITORINFO)
            if self.user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                r = mi.rcMonitor
                out.append((r.left, r.top, r.right - r.left, r.bottom - r.top, bool(mi.dwFlags & 1)))
            return 1
        self.user32.EnumDisplayMonitors(None, None, proc_t(cb), None)
        return out


class WinGrabber:
    def __init__(self, api=None):
        self.api = api or _Api()
        self.monitors = []
        self._src = self._mem = self._bmp = self._old = None
        self._size = None
        self._open = False

    def __enter__(self):
        a = self.api
        try:
            a.user32.SetProcessDPIAware()                 # real pixels, like mss does (a no-op when the program is DPI aware already)
        except Exception:
            pass
        self._src = a.user32.GetWindowDC(None)
        if not self._src:
            raise OSError("GetWindowDC failed")
        self._mem = a.gdi32.CreateCompatibleDC(self._src)
        if not self._mem:
            self.close()
            raise OSError("CreateCompatibleDC failed")
        self._open = True
        mons = sorted(a.monitors(), key=lambda m: not m[4])           # the primary monitor first
        if not mons:
            self.close()
            raise OSError("no monitor found")
        left = min(m[0] for m in mons)
        top = min(m[1] for m in mons)
        right = max(m[0] + m[2] for m in mons)
        bottom = max(m[1] + m[3] for m in mons)
        self.monitors = [{"left": left, "top": top, "width": right - left, "height": bottom - top}] \
            + [{"left": m[0], "top": m[1], "width": m[2], "height": m[3]} for m in mons]
        self.grab({"left": mons[0][0], "top": mons[0][1], "width": 1, "height": 1})      # works at all? (raises if not)
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def close(self):
        a = self.api
        try:
            if self._bmp:
                if self._mem and self._old:
                    a.gdi32.SelectObject(self._mem, self._old)
                a.gdi32.DeleteObject(self._bmp)
            if self._mem:
                a.gdi32.DeleteDC(self._mem)
            if self._src:
                a.user32.ReleaseDC(None, self._src)
        except Exception:
            pass
        self._src = self._mem = self._bmp = self._old = None
        self._size = None
        self._open = False

    def grab(self, area):
        if not self._open:
            raise OSError("grabber is closed")
        a = self.api
        left, top, w, h = int(area["left"]), int(area["top"]), int(area["width"]), int(area["height"])
        if w <= 0 or h <= 0:
            raise ValueError("empty area")
        if self._size != (w, h):                           # one bitmap, made again only when the size changes
            if self._bmp:
                a.gdi32.SelectObject(self._mem, self._old)
                a.gdi32.DeleteObject(self._bmp)
                self._bmp = None
            bmp = a.gdi32.CreateCompatibleBitmap(self._src, w, h)
            if not bmp:
                raise OSError("CreateCompatibleBitmap failed")
            self._old = a.gdi32.SelectObject(self._mem, bmp)
            self._bmp, self._size = bmp, (w, h)
        if not a.gdi32.BitBlt(self._mem, 0, 0, w, h, self._src, left, top, SRCCOPY):
            raise OSError("BitBlt failed")
        bi = BITMAPINFO()
        bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bi.bmiHeader.biWidth, bi.bmiHeader.biHeight = w, -h               # negative: top row first
        bi.bmiHeader.biPlanes, bi.bmiHeader.biBitCount, bi.bmiHeader.biCompression = 1, 32, BI_RGB
        buf = (ctypes.c_ubyte * (w * h * 4))()
        if not a.gdi32.GetDIBits(self._mem, self._bmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS):
            raise OSError("GetDIBits failed")
        return Shot(bytes(buf), w, h)
