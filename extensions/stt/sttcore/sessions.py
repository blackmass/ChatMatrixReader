"""Which program plays sound on which output device? (Windows audio sessions - works on every Windows 10 / 11, unlike per-process
capture which needs build 20438+.)  Needs the package pycaw (comtypes). Written from the documented COM interfaces and NOT yet run on
a real Windows: `stt_main.py --sessions` shows what it finds, so a mistake here is visible at once.

    enumerate_sessions() -> [Session(device, device_id, pid, state, peak)]
        state: 0 inactive, 1 active (the program has a stream playing), 2 expired
        peak:  0.0 .. 1.0, how loud that program is on that device right now
"""
import logging
from dataclasses import dataclass

log = logging.getLogger("stt.sessions")


@dataclass
class Session:
    device: str            # friendly name of the output device, e.g. "Speakers (Realtek(R) Audio)"
    device_id: str
    pid: int
    state: int
    peak: float


def _load():
    try:
        from pycaw.constants import CLSID_MMDeviceEnumerator
    except ImportError:
        from pycaw.pycaw import CLSID_MMDeviceEnumerator                      # older pycaw
    from pycaw.api.mmdeviceapi import IMMDeviceEnumerator
    from pycaw.api.audiopolicy import IAudioSessionControl2, IAudioSessionManager2
    try:
        from pycaw.api.endpointvolume import IAudioMeterInformation
    except ImportError:
        from pycaw.pycaw import IAudioMeterInformation
    return CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, IAudioSessionManager2, IAudioSessionControl2, IAudioMeterInformation


def _friendly_name(dev, dev_id):
    try:
        from pycaw.pycaw import AudioUtilities
        return AudioUtilities.CreateDevice(dev).FriendlyName or dev_id
    except Exception as e:
        log.debug("no friendly name for %s: %r", dev_id, e)
        return dev_id


def com_init():
    """Call once at the start of every thread that uses enumerate_sessions()."""
    try:
        import comtypes
        comtypes.CoInitialize()
    except Exception:
        pass


def enumerate_sessions():
    from ctypes import POINTER, cast
    from comtypes import CLSCTX_ALL, CLSCTX_INPROC_SERVER, CoCreateInstance
    clsid, IMMDeviceEnumerator, IAudioSessionManager2, IAudioSessionControl2, IAudioMeterInformation = _load()
    enumerator = CoCreateInstance(clsid, IMMDeviceEnumerator, CLSCTX_INPROC_SERVER)
    coll = enumerator.EnumAudioEndpoints(0, 1)                # eRender (0), DEVICE_STATE_ACTIVE (1)
    out = []
    for i in range(coll.GetCount()):
        dev = coll.Item(i)
        dev_id = dev.GetId()
        name = _friendly_name(dev, dev_id)
        try:
            iface = dev.Activate(IAudioSessionManager2._iid_, CLSCTX_ALL, None)
            mgr = cast(iface, POINTER(IAudioSessionManager2))
            senum = mgr.GetSessionEnumerator()
            for j in range(senum.GetCount()):
                ctl = senum.GetSession(j)
                ctl2 = ctl.QueryInterface(IAudioSessionControl2)
                try:
                    peak = float(ctl.QueryInterface(IAudioMeterInformation).GetPeakValue())
                except Exception:
                    peak = 0.0
                out.append(Session(name, dev_id, int(ctl2.GetProcessId()), int(ctl2.GetState()), peak))
        except Exception as e:
            log.warning("sessions of device '%s' unreadable: %r", name, e)
    return out


# ---------------------------------------------------------------------------------------------------------------------------
# The COM calls run in a SEPARATE PROCESS. Reason (seen on a real PC, crash file): comtypes releases its COM pointers from the
# garbage collector, which can run in ANY thread of the program (for example while numpy / onnxruntime are being imported) -
# a Release() on the wrong thread is an access violation that kills the whole program without a Python error. In its own
# process the COM objects live and die in one thread, and if it crashes anyway only the poller restarts.

def _worker():
    """Child process: for every line on stdin, answer one JSON line with the current sessions."""
    import gc
    import json
    import sys
    com_init()
    for line in sys.stdin:
        try:
            data = [[x.device, x.device_id, x.pid, x.state, x.peak] for x in enumerate_sessions()]
            gc.collect()                                  # COM pointers are released here, in this thread, now
            msg = {"ok": data}
        except Exception as e:
            msg = {"err": repr(e)}
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


class SessionPoller:
    """enumerate_sessions() with the same result, computed by the child process. Call it like a function."""

    def __init__(self, timeout=5.0):
        self.timeout, self.proc, self._restarts = timeout, None, 0

    def _start(self):
        import os
        import subprocess
        import sys
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.proc = subprocess.Popen([sys.executable, os.path.abspath(__file__), "--worker"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, creationflags=flags)

    def close(self):
        p, self.proc = self.proc, None
        if p is not None:
            try:
                p.stdin.close()
                p.wait(timeout=2)
            except Exception:
                p.kill()

    def __call__(self):
        import json
        import threading
        if self.proc is None or self.proc.poll() is not None:
            if self.proc is not None:
                self._restarts += 1
                log.warning("the session helper process stopped (exit code %s): restarting (%d)", self.proc.returncode, self._restarts)
            self._start()
        box = []
        def ask():
            try:
                self.proc.stdin.write("\n")
                self.proc.stdin.flush()
                box.append(self.proc.stdout.readline())
            except Exception as e:
                box.append("")
        t = threading.Thread(target=ask, daemon=True)
        t.start()
        t.join(self.timeout)
        if not box or not box[0]:
            self.close()
            raise RuntimeError("the session helper process gave no answer")
        msg = json.loads(box[0])
        if "err" in msg:
            raise RuntimeError(msg["err"])
        return [Session(*row) for row in msg["ok"]]


if __name__ == "__main__":
    import sys
    if "--worker" in sys.argv:
        _worker()
