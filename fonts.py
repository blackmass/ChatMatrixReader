"""Optional extra fonts: put .ttf / .otf / .ttc files into the  fonts  folder next to the program.

They are loaded for this program only (not installed in Windows) and can then be picked in the options.
No folder / no files -> nothing happens and the default font is used.
"""
import ctypes
import sys
import logging
import os
import struct

APP_DIR = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(APP_DIR, "fonts")
EXTS = (".ttf", ".otf", ".ttc")
FR_PRIVATE = 0x10
DEFAULT_FAMILY = "Apple SD Gothic Neo" if sys.platform == "darwin" else "Malgun Gothic"

log = logging.getLogger("cmr.fonts")
log.addHandler(logging.NullHandler())


def _name_table(path):
    """Raw bytes of the 'name' table (it is often near the end of a big Korean font, so seek instead of reading it all)."""
    with open(path, "rb") as f:
        head = f.read(16)
        base = struct.unpack(">I", head[12:16])[0] if head[:4] == b"ttcf" else 0     # collection: first font
        f.seek(base + 4)
        n_tables = struct.unpack(">H", f.read(2))[0]
        f.seek(base + 12)
        dirs = f.read(16 * n_tables)
        for i in range(n_tables):
            if dirs[16 * i:16 * i + 4] == b"name":
                off, length = struct.unpack(">II", dirs[16 * i + 8:16 * i + 16])
                f.seek(off)
                return f.read(min(length, 1024 * 1024))
    return b""


def family_name(path):
    """Family name (name id 1) from a font file, or None."""
    try:
        data = _name_table(path)
        if not data:
            return None
        count, str_off = struct.unpack(">HH", data[2:6])
        best = None
        for j in range(count):
            plat, _enc, lang, nid, ln, so = struct.unpack(">6H", data[6 + 12 * j:18 + 12 * j])
            if nid != 1:
                continue
            raw = data[str_off + so: str_off + so + ln]
            if plat in (0, 3):
                txt, rank = raw.decode("utf-16-be", "ignore"), (0 if lang == 0x409 else 1)
            elif plat == 1:
                txt, rank = raw.decode("mac_roman", "ignore"), 2
            else:
                continue
            if txt and (best is None or rank < best[0]):
                best = (rank, txt)
        return best[1] if best else None
    except Exception as e:
        log.warning("글꼴 이름을 읽지 못했습니다: %s (%s)", path, e)
    return None


def _register_mac(path):
    """Make a font file usable by this process only (CoreText, process scope)."""
    import CoreText
    import Foundation
    url = Foundation.NSURL.fileURLWithPath_(path)
    res = CoreText.CTFontManagerRegisterFontsForURL(url, CoreText.kCTFontManagerScopeProcess, None)
    ok = res[0] if isinstance(res, tuple) else res
    return bool(ok)


def load_all():
    """Load every font in fonts/ privately. -> sorted list of family names ([] if none / not Windows)."""
    try:
        files = sorted(fn for fn in os.listdir(FONT_DIR) if fn.lower().endswith(EXTS))
    except OSError:
        return []
    names = set()
    for fn in files:
        path = os.path.join(FONT_DIR, fn)
        try:
            if sys.platform == "darwin":
                ok = _register_mac(path)
            else:
                ok = ctypes.windll.gdi32.AddFontResourceExW(path, FR_PRIVATE, 0)
        except Exception as e:                                    # not Windows
            log.warning("글꼴 불러오기 실패: %s", e)
            return []
        name = family_name(path) if ok else None
        if ok and not name:
            log.warning("글꼴 이름을 알 수 없어 목록에 넣지 못했습니다: %s", fn)
        log.info("글꼴 %s: %s", "불러옴" if ok else "실패", fn + (f" ({name})" if name else ""))
        if name:
            names.add(name)
    return sorted(names)
