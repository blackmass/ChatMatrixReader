"""Operating-system layer. Everything that talks to the OS directly lives here; the rest of the program is portable.
Windows: plat/win.py + plat/winutil.py.  macOS: plat/mac.py + plat/macutil.py (same names; needs pyobjc)."""
import sys

if sys.platform == "win32":
    from .win import (Hotkey, Tray, WindowMixin, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
                      WS_EX_TRANSPARENT, _hwnd, _msgbox, _set_exstyle, _single_instance, _user32,
                      KEY_BG, POLL_RESIZE, OPTIONS_KEY, SHIFT_GRACE, RESIZE_CURSOR, FORCE_TWO_WINDOW, RESHOW_FOR_TASKBAR, RIGHT_CLICKS, borderless, set_keycolor, set_blur, setup_front, setup_app,
                      request_permissions)
elif sys.platform == "darwin":
    from .mac import (Hotkey, Tray, WindowMixin, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
                      WS_EX_TRANSPARENT, _hwnd, _msgbox, _set_exstyle, _single_instance, _user32,
                      KEY_BG, POLL_RESIZE, OPTIONS_KEY, SHIFT_GRACE, RESIZE_CURSOR, FORCE_TWO_WINDOW, RESHOW_FOR_TASKBAR, RIGHT_CLICKS, borderless, set_keycolor, set_blur, setup_front, setup_app,
                      request_permissions)
    from . import macutil as winutil              # app.py: "from plat import winutil"
else:
    raise ImportError("ChatMatrix Reader supports Windows and macOS only")
