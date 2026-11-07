"""Can this computer read the ChatMatrix from the screen?  (macOS first, but it works on Windows too.)

    python3 capture_diag.py            # looks at every monitor, tries the matrix at screen scale 1x and 2x
    python3 capture_diag.py --quartz   # macOS: the grabber the program itself uses (needs pyobjc-framework-Quartz)
    python3 capture_diag.py --native   # macOS: also try the system's own screenshot tool (full panel resolution; needs pillow)
    python3 capture_diag.py --save     # additionally writes the screenshots to diag_monitor<N>.png (look at them yourself first:
                                       # they show your whole screen, so do not post them anywhere you would not post that)

Start WoW (windowed / borderless), make the ChatMatrix addon visible, then run this.
Changes nothing; it only takes a few screenshots."""
import platform
import struct
import sys
import time
import zlib

import numpy as np

import decoder
import proto2
import scaled


def png_bytes(rgb):
    h, w = rgb.shape[:2]
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def find_any(arr, scales=(1, 2)):
    """Try the matrix at screen scale 1 and 2 (macOS Retina). -> list of findings."""
    out = []
    for s in scales:
        for oy in range(s):
            for ox in range(s):
                sub = np.ascontiguousarray(arr[oy::s, ox::s])
                pos = decoder.find_matrix(sub)
                if pos:
                    out.append(("v1", s, (pos[0] * s + ox, pos[1] * s + oy), ""))
                    return out
                hit = proto2.find_and_decode(sub)
                if hit:
                    x, y, f = hit
                    out.append(("v2", s, (x * s + ox, y * s + oy), f"{f.levels} levels, {f.rows} rows, seq {f.seq}"))
                    return out
    return out


def hunt(arr):
    """No exact match? Look for pixels near the colour of the first matrix cell (67,77,1), allowing for blur/scaling,
    and say where they are and how big the patch is."""
    target = np.array([1, 77, 67], dtype=np.int16)                       # BGR
    near = (np.abs(arr[:, :, :3].astype(np.int16) - target) <= 14).all(axis=2)
    ys, xs = np.nonzero(near)
    if len(xs) == 0:
        print("  no pixel anywhere is close to the first-cell colour (67,77,1): the addon is probably not on this screenshot,")
        print("  or its colours are changed a lot (night mode / True Tone / colour filter?)")
        return
    # biggest 12x12 block with the most hits
    cell = 12
    gy, gx = np.histogram2d(ys, xs, bins=[np.arange(0, arr.shape[0] + cell, cell), np.arange(0, arr.shape[1] + cell, cell)])[0], None
    iy, ix = np.unravel_index(int(np.argmax(gy)), gy.shape)
    x0, y0 = ix * cell, iy * cell
    print(f"  {len(xs)} pixels are close to the first-cell colour; the densest spot is around ({x0}, {y0}) "
          f"with {int(gy.max())} of {cell * cell} pixels in a {cell}x{cell} block")
    sub = near[max(0, y0 - 6):y0 + 18, max(0, x0 - 6):x0 + 18]
    print("  (patch around it, # = close to the colour):")
    for row in sub[::1]:
        print("   ", "".join("#" if v else "." for v in row))



def analyse(arr):
    hits = scaled.locate(arr)
    if not hits:
        print("  no v2 preamble pattern (white-black-red-green-blue-yellow-black-white) found at any size")
        return
    x, y, pitch = hits[0]
    print(f"  v2 PREAMBLE FOUND near pixel ({x:.0f}, {y:.0f}); cell size about {pitch:.2f} px ({len(hits)} rows matched)")
    print("  colours of the first 8 cells (R,G,B) - the ideal values are 255/0:")
    for i in range(8):
        px = arr[int(y + pitch / 2), int(x + (i + 0.5) * pitch)]
        print(f"    cell {i}: ({px[2]:3d},{px[1]:3d},{px[0]:3d})")
    res = scaled.fit(arr, x, y, pitch)
    if res[0] is not None:
        f, fx, fy, fp = res
        print(f"  DECODED (cell size {fp:.3f} px): {f.levels} levels, {f.rows} rows, seq {f.seq}, {len(f.lines)} lines"
              "  -> reading this computer is possible")
    else:
        print(f"  could not decode: {res[1]}")


def mac_display_info():
    if sys.platform != "darwin":
        return
    import subprocess
    try:
        out = subprocess.run(["system_profiler", "SPDisplaysDataType"], capture_output=True, text=True, timeout=20).stdout
        keep = [l.strip() for l in out.splitlines() if any(k in l for k in ("Resolution", "UI Looks", "Retina", "Display Type", "Chipset"))]
        print("display (system_profiler):")
        for l in keep:
            print("  ", l)
    except Exception as e:
        print("display info not available:", e)


def native_capture():
    """macOS: take a screenshot with the system's own tool (full panel resolution) and search that. Needs `pip install pillow`."""
    import os
    import subprocess
    import tempfile
    try:
        from PIL import Image
    except ImportError:
        print("native test needs Pillow:  .venv/bin/pip install pillow   (then run again)")
        return
    path = os.path.join(tempfile.gettempdir(), "cm_native.png")
    t0 = time.time()
    subprocess.run(["screencapture", "-x", path], check=True, timeout=20)
    im = Image.open(path).convert("RGB")
    rgb = np.asarray(im)
    arr = np.ascontiguousarray(np.dstack([rgb[:, :, 2], rgb[:, :, 1], rgb[:, :, 0], np.full(rgb.shape[:2], 255, np.uint8)]))
    print(f"\nNATIVE screenshot (screencapture): {arr.shape[1]}x{arr.shape[0]}  ({time.time() - t0:.1f} s)")
    found = find_any(arr, (1, 2, 3, 4))
    if found:
        mode, sc, (x, y), extra = found[0]
        print(f"  MATRIX FOUND: protocol {mode}, at pixel ({x}, {y}), scale {sc}x  {extra}")
        print("  -> cell size on this screenshot:", 4 * sc, "px")
    else:
        print("  matrix not found here by exact search; looking for the v2 pattern at any size ...")
        analyse(arr)
    try:
        os.remove(path)
    except OSError:
        pass


def quartz_test():
    """The grabber that the program itself uses on macOS (capture_mac.MacGrabber, needs pyobjc-framework-Quartz)."""
    import capture_mac
    try:
        with capture_mac.MacGrabber() as g:
            for i, mon in enumerate(g.monitors[1:], 1):
                t0 = time.time()
                shot = g.grab(mon)
                dt = time.time() - t0
                arr = np.frombuffer(shot.bgra, dtype=np.uint8).reshape(shot.height, shot.width, 4)
                print(f"\nmonitor {i} via Quartz: {shot.width}x{shot.height} (display scale {mon['_scale']:g}), "
                      f"method {g._method.__name__ if g._method else '?'}, full grab {dt * 1000:.0f} ms")
                small = {"left": mon["left"] + 200, "top": mon["top"] + mon["height"] - 260, "width": 900, "height": 260}
                t0 = time.time()
                for _ in range(10):
                    g.grab(small)
                print(f"  corner 900x260 grab: {(time.time() - t0) * 100:.1f} ms each")
                hit = scaled.find(arr)
                if hit:
                    x, y, p, f = hit
                    print(f"  MATRIX FOUND at ({x:.1f}, {y:.1f}), cell {p:.3f} px: {f.levels} levels, {f.rows} rows, seq {f.seq}, "
                          f"{len(f.lines)} lines")
                else:
                    print("  matrix not found in this grab")
                    analyse(arr)
    except PermissionError:
        print("Screen recording permission is missing: allow Terminal in System Settings > Privacy & Security > "
              "Screen & System Audio Recording, then quit and reopen Terminal.")
    except ImportError:
        print("pyobjc is missing:  .venv/bin/pip install pyobjc-framework-Quartz")


def main():
    mac_display_info()
    if "--quartz" in sys.argv:
        quartz_test()
        return
    if "--native" in sys.argv:
        native_capture()
        return
    save = "--save" in sys.argv
    import mss
    print("Python", platform.python_version(), "|", platform.platform(), "| mss", getattr(mss, "__version__", "?"))
    with (getattr(mss, "MSS", None) or mss.mss)() as sct:
        for i, mon in enumerate(sct.monitors[1:], 1):
            t0 = time.time()
            shot = sct.grab(mon)
            arr = np.frombuffer(shot.bgra, dtype=np.uint8).reshape(shot.height, shot.width, 4)
            ratio = shot.width / max(1, mon["width"])
            colors = len(np.unique(arr[::7, ::7, :3].reshape(-1, 3), axis=0))
            print(f"\nmonitor {i}: mss says {mon['width']}x{mon['height']} at ({mon['left']},{mon['top']}), "
                  f"screenshot is {shot.width}x{shot.height}  (pixels per mss unit: {ratio:g})")
            print(f"  looks like: {colors} different colours in a sample, mean brightness {arr[::5, ::5, :3].mean():.0f}")
            if colors < 20:
                print("  !! almost no colours: the capture may be blocked (macOS: System Settings > Privacy & Security > "
                      "Screen Recording > allow Terminal / Python, then restart it)")
            found = find_any(arr)
            if found:
                mode, s, (x, y), extra = found[0]
                print(f"  MATRIX FOUND: protocol {mode}, at screen pixel ({x}, {y}), screen scale {s}x  {extra}")
                print("  -> on-screen cell size is", 4 * s, "px" + ("  (the reader needs a 2x mode for this)" if s == 2 else ""))
            else:
                print("  matrix not found by exact search; looking for the v2 pattern at any size ...")
                analyse(arr)
            if save:
                with open(f"diag_monitor{i}.png", "wb") as f:
                    f.write(png_bytes(arr[:, :, [2, 1, 0]]))
                print(f"  wrote diag_monitor{i}.png")
            print(f"  ({time.time() - t0:.1f} s)")
    print("\nDone. Paste everything above (without the png files).")


if __name__ == "__main__":
    main()
