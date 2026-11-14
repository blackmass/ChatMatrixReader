"""DEVELOPMENT TOOL (not used by the program; kept for diagnosing game stutter with test_flip.py; needs `pip install dxcam`).

Screen grabber through DXGI Desktop Duplication (the way OBS's display capture reads the screen), using the package dxcam.

The duplication runs in a CHILD PROCESS (this file started with --worker), not in the program: dxcam is built on comtypes, and comtypes
releases COM pointers from the garbage collector in whatever thread it happens to run - on a real PC that crashed the whole program
once already (see sessions.py). In its own process a mistake can only end the child, and the grabber then raises like any failed grab.

Parent side: DxgiGrabber has the small part of mss's interface that capture.py uses (.monitors, .grab(area) -> .bgra/.width/.height,
use as a context manager). Protocol: one JSON line per request on the child's stdin; the answer on its stdout is "OK <w> <h>\\n" + w*h*4
bytes of BGRA, or "ERR <text>\\n". At start the child says "READY\\n" (or "ERR ...").
Written from dxcam's documented interface; on a real Windows it started and read (dxcam 0.3.0).
"""
import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time

import numpy as np

log = logging.getLogger("cmr.capture")


# ------------------------------------------------------------------------------------------------------------ child side
class Duplicator:
    """One dxcam camera per monitor; an area in desktop coordinates is cut out of whatever monitors it touches."""

    def __init__(self, dxcam, monitors):
        self.dx = dxcam
        self.mons = [tuple(int(x) for x in m) for m in monitors]            # (left, top, width, height), the primary monitor first
        self.cams = {}
        self.cache = {}                                                     # (monitor, region) -> the last picture of it

    def _cam(self, i):
        cam = self.cams.get(i)
        if cam is None:
            try:
                cam = self.dx.create(output_idx=i, output_color="BGRA")
            except TypeError:
                cam = self.dx.create(output_idx=i)
            m = self.mons[i]
            if (int(cam.width), int(cam.height)) != (m[2], m[3]):
                raise OSError("monitor %d: dxcam sees %sx%s, Windows says %dx%d (different monitor order?)" % (i, cam.width, cam.height, m[2], m[3]))
            self.cams[i] = cam
        return cam

    @staticmethod
    def _bgra(f):
        f = np.asarray(f)
        if f.ndim == 3 and f.shape[2] == 3:                                 # a library that gives BGR: add the opaque alpha
            f = np.concatenate([f, np.full(f.shape[:2] + (1,), 255, np.uint8)], axis=2)
        return f

    def _frame(self, i, region):
        cam = self._cam(i)
        key = (i, region)
        for _ in range(60):
            f = cam.grab(region=region)
            if f is not None:
                if len(self.cache) > 16:
                    self.cache.clear()
                f = self._bgra(f)
                self.cache[key] = f
                return f
            if key in self.cache:                                           # no new picture of the screen: nothing changed
                return self.cache[key]
            time.sleep(0.01)                                                # another region took the new picture: wait for the next
        raise OSError("no picture from monitor %d" % i)

    def check(self):
        self._cam(0)

    def grab(self, left, top, w, h):
        out = np.zeros((h, w, 4), np.uint8)                                 # what is outside every monitor stays black (like GDI)
        hit = False
        for i, (ml, mt, mw, mh) in enumerate(self.mons):
            il, it, ir, ib = max(left, ml), max(top, mt), min(left + w, ml + mw), min(top + h, mt + mh)
            if ir <= il or ib <= it:
                continue
            f = self._frame(i, (il - ml, it - mt, ir - ml, ib - mt))
            out[it - top:ib - top, il - left:ir - left, :] = f[:ib - it, :ir - il, :4]
            hit = True
        if not hit:
            raise OSError("the area is outside every monitor")
        return out.tobytes()

    def close(self):
        for cam in self.cams.values():
            try:
                cam.release()
            except Exception:
                pass
        self.cams.clear()
        self.cache.clear()
        import gc
        gc.collect()                                                        # COM pointers are released here, in this thread, now


def serve(dup, inp, out):
    """The child's request loop (binary streams)."""
    for line in iter(inp.readline, b""):
        try:
            req = json.loads(line.decode("utf-8"))
        except ValueError:
            continue
        if req.get("quit"):
            break
        try:
            w, h = int(req["w"]), int(req["h"])
            data = dup.grab(int(req["l"]), int(req["t"]), w, h)
            out.write(b"OK %d %d\n" % (w, h))
            out.write(data)
        except Exception as e:
            out.write(b"ERR " + repr(e).replace("\n", " ")[:300].encode("utf-8", "replace") + b"\n")
        out.flush()


def run_worker(monitors, dxcam=None):
    inp, out = sys.stdin.buffer, sys.stdout.buffer
    sys.stdout = sys.stderr                                                 # anything the library prints must not get into the protocol
    try:
        if dxcam is None:
            import dxcam
        dup = Duplicator(dxcam, monitors)
        dup.check()
    except BaseException as e:
        out.write(b"ERR " + repr(e).replace("\n", " ")[:300].encode("utf-8", "replace") + b"\n")
        out.flush()
        return
    out.write(b"READY\n")
    out.flush()
    try:
        serve(dup, inp, out)
    finally:
        dup.close()


# ----------------------------------------------------------------------------------------------------------- parent side
class Shot:
    def __init__(self, bgra, width, height):
        self.bgra, self.width, self.height = bgra, width, height


class DxgiGrabber:
    def __init__(self, cmd=None, monitors=None, timeout=5.0, start_timeout=40.0):
        self.cmd, self._mons = cmd, monitors
        self.timeout, self.start_timeout = timeout, start_timeout
        self.monitors = []
        self.proc = None
        self.q = queue.Queue()

    def _layout(self):
        if self._mons is None:
            import capture_win
            try:
                import ctypes
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass
            mons = sorted(capture_win._Api().monitors(), key=lambda m: not m[4])      # the primary monitor first
            self._mons = [(m[0], m[1], m[2], m[3]) for m in mons]
        if not self._mons:
            raise OSError("no monitor found")
        left = min(m[0] for m in self._mons)
        top = min(m[1] for m in self._mons)
        right = max(m[0] + m[2] for m in self._mons)
        bottom = max(m[1] + m[3] for m in self._mons)
        self.monitors = [{"left": left, "top": top, "width": right - left, "height": bottom - top}] \
            + [{"left": m[0], "top": m[1], "width": m[2], "height": m[3]} for m in self._mons]

    def __enter__(self):
        self._layout()
        cmd = self.cmd or [sys.executable, "-X", "utf8", os.path.abspath(__file__), "--worker", json.dumps(self._mons)]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)
        threading.Thread(target=self._read, args=(self.proc, self.q), name="dxgi-reader", daemon=True).start()
        try:
            kind, what = self.q.get(timeout=self.start_timeout)
        except queue.Empty:
            self.close()
            raise OSError("the duplication helper did not start in time")
        if kind != "ready":
            self.close()
            raise OSError("the duplication helper: %s" % what)
        m = self._mons[0]
        self.grab({"left": m[0], "top": m[1], "width": 1, "height": 1})        # does it work at all? (raises if not)
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    @staticmethod
    def _read(proc, q):
        try:
            out = proc.stdout
            first = out.readline()
            if first.startswith(b"READY"):
                q.put(("ready", ""))
            else:
                q.put(("err", first.decode("utf-8", "replace").strip() or "ended"))
                return
            while True:
                head = out.readline()
                if not head:
                    break
                if head.startswith(b"OK "):
                    _, w, h = head.split()
                    n = int(w) * int(h) * 4
                    data = out.read(n)
                    q.put(("ok", data if len(data) == n else None))
                else:
                    q.put(("err", head.decode("utf-8", "replace").strip()))
        except Exception as e:
            q.put(("err", repr(e)))
        q.put(("eof", ""))

    def close(self):
        p, self.proc = self.proc, None
        if p is None:
            return
        try:
            p.stdin.write(b'{"quit": true}\n')
            p.stdin.flush()
            p.wait(timeout=2)
        except Exception:
            try:
                p.kill()
            except OSError:
                pass

    def grab(self, area):
        p = self.proc
        if p is None or p.poll() is not None:
            raise OSError("the duplication helper is not running")
        left, top, w, h = int(area["left"]), int(area["top"]), int(area["width"]), int(area["height"])
        if w <= 0 or h <= 0:
            raise ValueError("empty area")
        while not self.q.empty():                                              # an answer that came too late for an earlier request
            self.q.get_nowait()
        try:
            p.stdin.write((json.dumps({"l": left, "t": top, "w": w, "h": h}) + "\n").encode("ascii"))
            p.stdin.flush()
            kind, what = self.q.get(timeout=self.timeout)
        except queue.Empty:
            self.close()
            raise OSError("the duplication helper gave no answer")
        except (OSError, ValueError) as e:
            self.close()
            raise OSError("the duplication helper is gone: %r" % (e,))
        if kind != "ok" or what is None:
            if kind == "eof":
                self.close()
            raise OSError("the duplication helper: %s" % (what or kind))
        return Shot(what, w, h)


if __name__ == "__main__":
    if "--worker" in sys.argv:
        run_worker(json.loads(sys.argv[sys.argv.index("--worker") + 1]))
