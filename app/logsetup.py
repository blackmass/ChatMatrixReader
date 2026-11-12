"""Logging: rotating file (chatmatrix.log in the main folder) + in-memory ring buffer shown in the options 'log' tab."""
import collections
import logging
import os
import threading
from logging.handlers import RotatingFileHandler

import paths

PATH = os.path.join(paths.ROOT, "chatmatrix.log")


class RingHandler(logging.Handler):
    def __init__(self, size=600):
        super().__init__()
        self.lines = collections.deque(maxlen=size)
        self.lk = threading.Lock()

    def emit(self, record):
        try:
            msg = self.format(record)
        except Exception:
            return
        with self.lk:
            self.lines.append(msg)

    def snapshot(self):
        with self.lk:
            return list(self.lines)


ring = RingHandler()


def setup():
    root = logging.getLogger("cmr")
    if getattr(root, "_cmr_ready", False):
        return
    root.setLevel(logging.INFO)
    try:
        fh = RotatingFileHandler(PATH, maxBytes=512 * 1024, backupCount=2, encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S"))
        root.addHandler(fh)
    except OSError:
        pass                                   # read-only folder: the in-app log still works
    ring.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%H:%M:%S"))
    root.addHandler(ring)
    root._cmr_ready = True
