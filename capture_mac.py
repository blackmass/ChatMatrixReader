"""Screen grabbing on macOS at the display's real pixel resolution (needs pyobjc-framework-Quartz).

mss on macOS returns a screenshot reduced to "points" (a Retina screen at half size), which blurs the matrix cells.
This class has the small part of mss's interface that capture.py uses (.monitors, .grab(area) -> .bgra/.width/.height),
but captures at full resolution. Coordinates are in screen PIXELS (points x display scale), per display.
"""
import logging
import subprocess
import tempfile
import os

import numpy as np

log = logging.getLogger("cmr.capture")


class Shot:
    def __init__(self, arr):
        self.height, self.width = arr.shape[:2]
        self.bgra = np.ascontiguousarray(arr).tobytes()


def to_bgra(data, width, height, bytes_per_row, little_endian=True, alpha_first=True):
    """Raw pixel bytes of a 32-bit CGImage -> (height, width, 4) BGRA uint8. The usual macOS format is
    'premultiplied first, 32-bit little endian' = B,G,R,A in memory."""
    a = np.frombuffer(data, dtype=np.uint8)
    a = a[:height * bytes_per_row].reshape(height, bytes_per_row)[:, :width * 4].reshape(height, width, 4)
    if little_endian and alpha_first:                         # B G R A
        return a.copy()
    if (not little_endian) and alpha_first:                   # A R G B
        return a[:, :, [3, 2, 1, 0]].copy()
    if little_endian:                                         # R G B A (alpha last, little endian = A B G R)
        return a[:, :, [1, 2, 3, 0]].copy()
    return a[:, :, [2, 1, 0, 3]].copy()                       # R G B A


class MacGrabber:
    def __init__(self, quartz=None):
        self.Q = quartz
        self.monitors = []
        self._method = None
        self._warned = False

    def __enter__(self):
        if self.Q is None:
            import Quartz
            self.Q = Quartz
        Q = self.Q
        pre = getattr(Q, "CGPreflightScreenCaptureAccess", None)
        if pre is not None and not pre():
            req = getattr(Q, "CGRequestScreenCaptureAccess", None)
            if req is not None:
                req()                                          # shows the system dialog once
            raise PermissionError("screen recording permission missing")
        err, ids, n = Q.CGGetActiveDisplayList(16, None, None)
        mons = []
        for did in list(ids)[:n]:
            b = Q.CGDisplayBounds(did)
            scale = 1.0
            try:
                mode = Q.CGDisplayCopyDisplayMode(did)
                pw = Q.CGDisplayModeGetPixelWidth(mode)
                if pw and b.size.width:
                    scale = pw / b.size.width
            except Exception:
                pass
            mons.append({"left": int(round(b.origin.x * scale)), "top": int(round(b.origin.y * scale)),
                         "width": int(round(b.size.width * scale)), "height": int(round(b.size.height * scale)),
                         "_id": did, "_scale": scale, "_ox": b.origin.x, "_oy": b.origin.y})
        if not mons:
            raise RuntimeError("no display found")
        mons.sort(key=lambda m: (m["_ox"] != 0 or m["_oy"] != 0))          # the main display (origin 0,0) first
        allm = {"left": min(m["left"] for m in mons), "top": min(m["top"] for m in mons),
                "width": max(m["left"] + m["width"] for m in mons) - min(m["left"] for m in mons),
                "height": max(m["top"] + m["height"] for m in mons) - min(m["top"] for m in mons)}
        self.monitors = [allm] + mons
        log.info("맥 화면: %s", " | ".join(f"{m['width']}x{m['height']} (배율 {m['_scale']:g})" for m in mons))
        return self

    def __exit__(self, *a):
        return False

    # ------------------------------------------------------------------
    def _monitor_of(self, area):
        for m in self.monitors[1:]:
            if m["left"] <= area["left"] < m["left"] + m["width"] and m["top"] <= area["top"] < m["top"] + m["height"]:
                return m
        return self.monitors[1]

    def grab(self, area):
        m = self._monitor_of(area)
        s = m["_scale"]
        lx, ly = (area["left"] - m["left"]) / s, (area["top"] - m["top"]) / s       # display-local points
        w, h = max(1, area["width"]) / s, max(1, area["height"]) / s
        methods = [self._display_rect, self._window_list, self._cli] if self._method is None else [self._method]
        last = None
        for fn in methods:
            try:
                arr = fn(m, lx, ly, w, h)
                if self._method is None:
                    self._method = fn
                    log.info("맥 캡처 방식: %s", fn.__name__)
                return Shot(arr)
            except Exception as e:
                last = e
                if self._method is None:
                    log.info("맥 캡처 방식 %s 실패: %r", fn.__name__, e)
        raise RuntimeError(f"screen capture failed: {last!r}")

    def _image_to_array(self, img):
        Q = self.Q
        if img is None:
            raise RuntimeError("no image")
        w, h = Q.CGImageGetWidth(img), Q.CGImageGetHeight(img)
        bpr = Q.CGImageGetBytesPerRow(img)
        bits = Q.CGImageGetBitsPerPixel(img)
        if bits != 32:
            raise RuntimeError(f"unexpected pixel format ({bits} bits)")
        info = Q.CGImageGetBitmapInfo(img)
        little = (info & 0x7000) == 0x2000                                # kCGBitmapByteOrder32Little
        alpha = info & 0x1F
        alpha_first = alpha in (1, 2, 5, 6)                               # PremultipliedFirst / First / NoneSkipFirst
        data = Q.CGDataProviderCopyData(Q.CGImageGetDataProvider(img))
        return to_bgra(bytes(data), w, h, bpr, little, alpha_first)

    def _display_rect(self, m, lx, ly, w, h):
        Q = self.Q
        rect = Q.CGRectMake(lx, ly, w, h)
        return self._image_to_array(Q.CGDisplayCreateImageForRect(m["_id"], rect))

    def _window_list(self, m, lx, ly, w, h):
        Q = self.Q
        rect = Q.CGRectMake(m["_ox"] + lx, m["_oy"] + ly, w, h)
        img = Q.CGWindowListCreateImage(rect, Q.kCGWindowListOptionOnScreenOnly, Q.kCGNullWindowID,
                                        Q.kCGWindowImageBestResolution)
        return self._image_to_array(img)

    def _cli(self, m, lx, ly, w, h):
        """Last resort: the system's screencapture tool (slow, needs Pillow)."""
        from PIL import Image
        path = os.path.join(tempfile.gettempdir(), "cm_grab.png")
        rect = f"{m['_ox'] + lx:.0f},{m['_oy'] + ly:.0f},{max(1, round(w))},{max(1, round(h))}"
        subprocess.run(["screencapture", "-x", "-R", rect, path], check=True, timeout=10)
        rgb = np.asarray(Image.open(path).convert("RGB"))
        return np.dstack([rgb[:, :, 2], rgb[:, :, 1], rgb[:, :, 0], np.full(rgb.shape[:2], 255, np.uint8)])
