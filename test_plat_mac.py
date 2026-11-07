"""plat/mac.py logic with fake AppKit / Quartz (no macOS needed): window styling, ordering, game search, key state."""
import os, sys, types, threading, queue

class NSW:
    n = 100
    def __init__(self, title):
        NSW.n += 1
        self._t, self.num, self.lvl, self.mask, self.ign = title, NSW.n, 0, 15, False
        self.calls = []
    def title(self): return self._t
    def windowNumber(self): return self.num
    def setStyleMask_(self, m): self.mask = m; self.calls.append(("mask", m))
    def setTitlebarAppearsTransparent_(self, v): pass
    def setTitleVisibility_(self, v): pass
    def standardWindowButton_(self, b): return None
    def contentView(self): return None
    def setMovableByWindowBackground_(self, v): pass
    def setHasShadow_(self, v): self.calls.append(("shadow", v))
    def setOpaque_(self, v): pass
    def setBackgroundColor_(self, c): pass
    def setExcludedFromWindowsMenu_(self, v): pass
    def setHidesOnDeactivate_(self, v): pass
    def setCollectionBehavior_(self, b): self.calls.append(("beh", b))
    def setLevel_(self, l): self.lvl = l
    def level(self): return self.lvl
    def setIgnoresMouseEvents_(self, v): self.ign = v
    def orderWindow_relativeTo_(self, mode, num): self.calls.append(("order", mode, num)); ORDER.remove(self); ORDER.insert(0, self)
    def orderFrontRegardless(self): self.calls.append(("front",))

ORDER = []
AppKit = types.ModuleType("AppKit")
for n, v in dict(NSWindowStyleMaskTitled=1, NSWindowStyleMaskFullSizeContentView=1 << 15, NSWindowStyleMaskResizable=8,
                 NSWindowStyleMaskBorderless=0, NSWindowTitleHidden=1, NSWindowCloseButton=0, NSWindowMiniaturizeButton=1,
                 NSWindowZoomButton=2, NSWindowCollectionBehaviorCanJoinAllSpaces=1,
                 NSWindowCollectionBehaviorFullScreenAuxiliary=256, NSWindowCollectionBehaviorIgnoresCycle=64).items():
    setattr(AppKit, n, v)
AppKit.NSColor = types.SimpleNamespace(clearColor=lambda: None)
AppKit.NSApp = types.SimpleNamespace(windows=lambda: list(ORDER), orderedWindows=lambda: list(ORDER))
sys.modules["AppKit"] = AppKit
Q = types.ModuleType("Quartz")
Q.kCGWindowListOptionOnScreenOnly, Q.kCGWindowListExcludeDesktopElements, Q.kCGNullWindowID = 1, 16, 0
for n in ("OwnerPID", "OwnerName", "Name", "Number", "Layer", "Bounds"):
    setattr(Q, "kCGWindow" + n, n)
WINS = []
Q.CGWindowListCopyWindowInfo = lambda o, i: list(WINS)
sys.modules["Quartz"] = Q

_real = sys.platform
sys.platform = "darwin"          # let plat/__init__ pick the macOS branch on this Linux box
import plat.mac as mac  # noqa: E402
sys.platform = _real

class Tk:
    def __init__(self, title): self._t = title
    def wm_title(self): return self._t

def win(title):
    w = NSW(title); ORDER.append(w); return Tk(title), w

root, nroot = win("ChatMatrix Reader")
back, nback = win("ChatMatrix Reader (background)")
shad, nshad = win("ChatMatrix Reader (shadow)")
assert mac._hwnd(root) is nroot and mac._hwnd(back) is nback

# styling
mac.borderless(root, True); mac.borderless(back, True)
assert nroot.mask == (1 | (1 << 15)) and nback.mask == nroot.mask
assert ("shadow", False) in nroot.calls and ("beh", 1 | 256 | 64) in nback.calls
n = len(nroot.calls); mac._style(root); assert len(nroot.calls) == n, "style applied twice"

# click-through flag
mac._set_exstyle(root, add=mac.WS_EX_TRANSPARENT); assert nroot.ign
mac._set_exstyle(root, remove=mac.WS_EX_TRANSPARENT); assert not nroot.ign
mac._set_exstyle(root, add=mac.WS_EX_NOACTIVATE | mac.WS_EX_TOOLWINDOW); assert not nroot.ign

class App(mac.WindowMixin):
    pass

import time
a = App()
a.root, a.back, a.shad = root, back, shad
a.two_window, a._shadow_on = True, False
a.cfg = {"wow_window_title": "", "topmost_wow_only": True}
a._game_hwnd, a._game_next_search, a._game_warned, a._follow_failed = None, 0.0, 0.0, False
a._follow_top, a._placed_for, a._follow_logged = False, None, 0.0
a._shadow_active = lambda: False
a.root.after = lambda ms, f: None

# game search: biggest normal-layer window of "Wow"; own pid and other layers ignored
WINS[:] = [
    {"OwnerPID": os.getpid(), "OwnerName": "Python", "Name": "x", "Number": 1, "Layer": 0, "Bounds": {"Width": 900, "Height": 300}},
    {"OwnerPID": 77, "OwnerName": "Wow", "Name": "World of Warcraft", "Number": 555, "Layer": 0, "Bounds": {"Width": 1440, "Height": 900}},
    {"OwnerPID": 77, "OwnerName": "Wow", "Name": "", "Number": 556, "Layer": 0, "Bounds": {"Width": 100, "Height": 50}},
    {"OwnerPID": 90, "OwnerName": "Safari", "Name": "", "Number": 9, "Layer": 0, "Bounds": {"Width": 1600, "Height": 1000}},
    {"OwnerPID": 77, "OwnerName": "Wow", "Name": "", "Number": 557, "Layer": 25, "Bounds": {"Width": 1440, "Height": 900}},
]
assert a._find_game() == 77 and a._game_win == 555
WINS[:] = [w for w in WINS if w["OwnerPID"] != 77]
a._game_checked = 0.0
assert a._find_game() is None and a._game_win is None

# game back: follow logic -> floating when the game is frontmost, just above it otherwise
WINS[:] = [{"OwnerPID": 77, "OwnerName": "Wow", "Name": "", "Number": 555, "Layer": 0, "Bounds": {"Width": 1440, "Height": 900}}]
a._game_checked, a._game_next_search = 0.0, 0.0
for fg, floating in ((77, True), (90, False)):
    mac.macutil.foreground = lambda fg=fg: fg
    a._follow_game()
    assert a._follow_top == floating, (fg, a._follow_top)
    assert all(w.lvl == (3 if floating else 0) for w in (nroot, nback)), fg
assert ("order", 1, 555) in nroot.calls                          # placed above the game window
# stack: shadow-less chain root -> back; force puts back below root
ORDER[:] = [nback, nroot]; a._stack_back()
assert ("order", -1, nroot.num) in nback.calls
n = len(nback.calls); ORDER[:] = [nroot, nback]; a._stack_back(); assert len(nback.calls) == n, "ordered again although right"

# tray / hotkey / single instance
h = mac.Hotkey(queue.Queue()); h.start(); assert h.ok and h.ready.is_set()
assert mac._single_instance() is True
print("ALL MAC LAYER TESTS PASSED")
