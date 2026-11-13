"""ChatMatrix STT: listens to one program's sound and prints what is said.

At a terminal (to try it):
    python stt_main.py --list                         which programs are running (and which names --target knows)
    python stt_main.py --target discord --meter       listen to Discord, show a level meter, print sentences
    python stt_main.py --wav sample.wav --fast        recognise a file (no voice chat needed)
    python stt_main.py --engine fake --wav x.wav      without a model (tests the rest)
From the reader: add --json (messages as JSON lines, see sttcore/protocol.py; the process ends when the reader closes its stdin).
"""
import argparse
import logging
import logging.handlers
import os
import signal
import sys
import threading

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")      # the model cache needs no symlinks; the warning only confuses
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from sttcore import VERSION                                   # noqa: E402
from sttcore.protocol import Out                              # noqa: E402


_crash_file = None


def parse(argv):
    p = argparse.ArgumentParser(description="ChatMatrix STT system")
    p.add_argument("--target", help="system | device:<name or number> | discord | wow | program.exe | pid:1234  "
                                    "(system / device = everything an output device plays, works on every Windows; a program name = only that program, needs Windows 10 build 20438+ / 11)")
    p.add_argument("--list-devices", action="store_true", help="list the output devices that can be captured and exit")
    p.add_argument("--wav", help="recognise this WAV file instead (16-bit PCM)")
    p.add_argument("--fast", action="store_true", help="with --wav: do not wait for real time")
    p.add_argument("--list", action="store_true", help="list the running programs (and the target names) and exit")
    p.add_argument("--engine", default="whisper", help="whisper | openai (any server with the OpenAI speech-to-text API) | fake")
    p.add_argument("--model", default="", help="whisper: large-v3-turbo (default), medium, small, base ...")
    p.add_argument("--models-dir", default="", help="where downloaded models are stored (default: the 'models' folder next to this script - never the user's global cache)")
    p.add_argument("--device", default="auto", help="auto | cuda | cpu")
    p.add_argument("--compute", default="auto", help="auto | float16 | int8 ...")
    p.add_argument("--beam", type=int, default=1, help="whisper beam size (1 = fastest)")
    p.add_argument("--no-vad-filter", action="store_true", help="whisper: turn its own voice detection off")
    p.add_argument("--lang", default="en", help="spoken language (en, ko ...) or 'auto'")
    p.add_argument("--prompt", default=None, help="words that help the engine with names (default: raid words)")
    p.add_argument("--end-ms", type=int, default=700, help="quiet time that ends a sentence")
    p.add_argument("--url", default="", help="engine openai: the server address, e.g. http://localhost:8000/v1 (the key: environment CHATMATRIX_STT_API_KEY)")
    p.add_argument("--response-format", default="json", help="engine openai: json | verbose_json | text")
    p.add_argument("--timeout", type=float, default=30.0, help="engine openai: seconds to wait for the server")
    p.add_argument("--check", action="store_true", help="only load the engine (engine openai: ask the server once), print the result and exit")
    p.add_argument("--max-s", type=float, default=12.0, help="longest piece of sound given to the engine")
    p.add_argument("--partial-ms", type=int, default=0, help="live mode: every N ms send the text of the sentence so far (0 = off; Whisper: not recommended)")
    p.add_argument("--min-rms", type=float, default=0.006, help="lowest sound level that counts as speech (0..1)")
    p.add_argument("--max-backlog", type=int, default=3, help="sentences allowed to wait for the engine")
    p.add_argument("--dump-wav", default=None, help="also save the sound the engine hears (16 kHz mono WAV) - to listen to it when nothing is recognised")
    p.add_argument("--probe", type=float, default=0, metavar="SECONDS",
                   help="with --target: listen for N seconds, report what the capture delivers and save probe.wav (no recognition)")
    p.add_argument("--proctap-info", action="store_true", help="show what the installed proc-tap offers (for diagnosing the capture) and exit")
    p.add_argument("--native-check", action="store_true", help="with --target: ask proc-tap's native part whether the capture is really of that process alone")
    p.add_argument("--no-gate", action="store_true", help="with the session method: do not mute the sound while the program itself is quiet")
    p.add_argument("--sessions", action="store_true", help="show which programs play sound on which output device (with --target: mark that program) and exit")
    p.add_argument("--meter", action="store_true", help="show the sound level (once a second, see --meter-ms)")
    p.add_argument("--meter-ms", type=int, default=1000, help="how often the level is reported with --meter (the reader asks for 200)")
    p.add_argument("--json", action="store_true", help="messages as JSON lines (for the reader)")
    p.add_argument("--log", default=None, help="log file (default: chatmatrix_stt.log in the reader's folder)")
    p.add_argument("-v", "--verbose", action="store_true", help="more detail in the log")
    return p.parse_args(argv)


def setup_log(path, verbose):
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    sh.setLevel(logging.WARNING)
    root.addHandler(sh)
    path = path or os.path.join(os.path.dirname(os.path.dirname(HERE)), "chatmatrix_stt.log")
    try:                                                         # a crash inside a native library (no Python error at all) leaves its trace here
        import faulthandler
        global _crash_file
        _crash_file = open(path + ".crash", "a", encoding="utf-8")
        faulthandler.enable(file=_crash_file, all_threads=True)
    except Exception:
        pass
    try:
        fh = logging.handlers.RotatingFileHandler(path, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
        fh.setFormatter(fmt)
        root.addHandler(fh)
    except OSError as e:
        sys.stderr.write(f"(no log file: {e})\n")
    return path


def check_engine(a, out, log):
    """--check: load the engine only (engine openai: one request with a second of silence). The reader's "test connection" button."""
    import time as _t
    from sttcore.engines import get_engine
    t0 = _t.perf_counter()
    try:
        eng = get_engine(a.engine, {"model": a.model, "device": a.device, "compute": a.compute, "beam": a.beam,
                                    "url": a.url, "response_format": a.response_format, "timeout": a.timeout,
                                    "models_dir": a.models_dir}, logging.getLogger("stt.engine"))
        desc = eng.load()
        eng.close()
    except Exception as e:
        log.info("check failed: %s", e)
        out.emit("check", ok=False, msg=str(e))
        return 1
    out.emit("check", ok=True, msg=desc, secs=round(_t.perf_counter() - t0, 2))
    return 0


def confine_downloads(models_dir):
    """Everything a model download writes stays inside the extension's folder: the models themselves (download_root), and - for this
    process only, the user's own environment is not touched - the Hugging Face home (its token / chunk cache / telemetry settings),
    which would otherwise be created in the user's profile. Must run before faster_whisper / huggingface_hub are imported."""
    models_dir = os.path.abspath(models_dir or os.path.join(HERE, "models"))
    os.environ["HF_HOME"] = os.path.join(models_dir, ".hf_home")
    os.environ.pop("HF_HUB_CACHE", None)
    os.environ.pop("HUGGINGFACE_HUB_CACHE", None)
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
    return models_dir


def main(argv=None):
    a = parse(argv)
    a.models_dir = confine_downloads(a.models_dir)
    log_path = setup_log(a.log, a.verbose)
    log = logging.getLogger("stt")
    out = Out(a.json)
    if a.check:
        return check_engine(a, out, log)
    if a.sessions:
        import time as _t
        from sttcore import capture, sessions
        poller = sessions.SessionPoller()
        match = capture.make_matcher(a.target) if a.target else None
        try:
            import psutil
        except ImportError:
            psutil = None

        def role(pid):
            """What kind of process: the program's own, or one of its helpers (Chromium: --type=utility --utility-sub-type=...)."""
            try:
                pr = psutil.Process(pid)
                cmd = pr.cmdline()
                typ = next((x.split("=", 1)[1] for x in cmd if x.startswith("--type=")), "main")
                sub = next((x.split("=", 1)[1] for x in cmd if x.startswith("--utility-sub-type=")), "")
                par = pr.parent()
                return f"{typ}{('/' + sub.split('.')[-1]) if sub else ''}", f"parent {par.pid if par else '?'} {par.name() if par else ''}"
            except Exception:
                return "?", ""

        if a.json:                                             # for the reader's program chooser: one row per program
            poller = sessions.SessionPoller(timeout=20.0)       # the first answer waits for the helper process to import pycaw / comtypes
            rounds, err, fails = [], "", 0
            for round_ in range(4):
                _t.sleep(0.3 if round_ else 0)
                try:
                    rounds.append(poller())
                except Exception as e:                           # one failed reading is not the end: the helper restarts
                    err, fails = str(e), fails + 1
                    log.warning("program list: reading %d failed: %s", round_ + 1, e)
                    if fails >= 2 and not rounds:
                        break
            if not rounds:
                hint = " (is pycaw installed in the extension's .venv?)" if any(w in err.lower() for w in ("pycaw", "no module", "import")) else ""
                if hasattr(poller, "close"):
                    poller.close()
                out.emit("sessions", items=[], error=(err or "no answer") + hint)
                return 4

            def name_of(pid):
                try:
                    return psutil.Process(pid).name() if psutil else ""
                except Exception:
                    return ""
            if hasattr(poller, "close"):
                poller.close()
            out.emit("sessions", items=capture.group_sessions(rounds, name_of))
            return 0
        try:
            for round_ in range(4):                            # a few samples: the peak is only what plays right now
                _t.sleep(0.4 if round_ else 0)
                print(f"--- sample {round_ + 1} ---")
                for s in sorted(poller(), key=lambda x: (x.device, x.pid)):
                    if not s.pid and not a.verbose:            # "system sounds" rows: only with -v
                        continue
                    try:
                        pname = psutil.Process(s.pid).name() if s.pid else "(system sounds)"
                    except Exception:
                        pname = "?"
                    is_t = bool(match and s.pid and match(s.pid))
                    extra = ""
                    if is_t:
                        r, par = role(s.pid)
                        extra = f"   <== target [{r}; {par}]"
                    print(f"  {s.device[:44]:<44} pid {s.pid:>6} {pname[:24]:<24} state {s.state} peak {s.peak:.3f}{extra}")
        except Exception as e:
            import traceback
            traceback.print_exc()
            print("error:", e, "(pip install pycaw)")
            return 4
        return 0
    if a.list_devices:
        from sttcore import capture
        try:
            for idx, name, rate, ch, dflt in capture.list_loopback_devices():
                print(f"{idx:>4}  {name}  ({rate} Hz, {ch} ch){'   <- default (--target system)' if dflt else ''}")
        except Exception as e:
            print("error:", e)
            return 4
        return 0
    if a.list:
        from sttcore import capture
        if a.target:                                            # --list --target chrome : which processes, and which one is picked
            print("\n".join(capture.describe(a.target)))
            return 0
        print("target names: " + ", ".join(sorted(capture.PRESETS)) + ", any program.exe, pid:N")
        for pid, name, ppid, _ in sorted(capture.list_processes(), key=lambda x: x[1].lower()):
            mark = [k for k, v in capture.PRESETS.items() if v.match(name)]
            if mark or a.verbose:
                print(f"{pid:>7}  {name}  {'<- ' + mark[0] if mark else ''}")
        return 0
    if a.proctap_info:
        from sttcore import probe
        return probe.proctap_info(print)
    if not a.target and not a.wav:
        print("give --target <program> or --wav <file> (see --help)", file=sys.stderr)
        return 1
    if a.native_check and a.target:
        from sttcore import capture, probe
        try:
            pid, name = capture.find_target(a.target)
            print(f"checking {name} (pid {pid})")
            return probe.native_check(pid, print)
        except LookupError as e:
            print("error:", e)
            return 4
    if a.probe and a.target:
        from sttcore import capture, probe
        try:
            if a.target.lower() == "system" or a.target.lower().startswith("device:"):
                src = capture.DeviceSource(a.target)
                print(f"probing {a.target} for {a.probe:.0f} s - play something now ...")
            else:
                pid, name = capture.find_target(a.target)
                if capture.ProcessSource.supported(pid)[0]:
                    src = capture.ProcessSource(pid)
                else:
                    src = capture.SessionSource(capture.make_matcher(a.target), a.target, gate=not a.no_gate)
                print(f"probing {name} (pid {pid}) for {a.probe:.0f} s - play something there now ...")
            return probe.probe(src, a.probe, "probe.wav", print)
        except (LookupError, RuntimeError) as e:
            print("error:", e)
            return 4
    log.info("STT %s start: %s", VERSION, vars(a))

    from sttcore import capture
    from sttcore.engines import get_engine
    from sttcore.pipeline import DEFAULT_PROMPT, Pipeline

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    try:
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
    except Exception:
        pass
    if a.json:                                                  # the reader controls us: {"cmd": "stop"} or its end of the pipe
        def watch():
            try:
                for line in sys.stdin:
                    if '"stop"' in line:
                        break
            except Exception:
                pass
            stop.set()
        threading.Thread(target=watch, name="stdin", daemon=True).start()

    try:
        if a.wav:
            source = capture.WavSource(a.wav, realtime=not a.fast)
            listening = f"file {os.path.basename(a.wav)}"
        else:
            if a.target.lower() == "system" or a.target.lower().startswith("device:"):
                source = capture.DeviceSource(a.target)
                listening = "the output device" if a.target.lower() == "system" else a.target
            else:
                pid, name = capture.find_target(a.target)
                ok, why = capture.ProcessSource.supported(pid)
                if ok and capture.needs_sessions(a.target):
                    ok, why = False, "voice chat only: its helper processes are told apart through the audio sessions"
                if ok:
                    source = capture.ProcessSource(pid)
                    listening = f"{name} (pid {pid}) - only its own sound"
                else:                                           # an older Windows 10: find the device the program plays on instead
                    log.info("per-program capture not available (%s): using the audio sessions", why)
                    source = capture.SessionSource(capture.make_matcher(a.target), a.target, gate=not a.no_gate)
                    listening = f"{name} (through its audio session)"
    except (LookupError, RuntimeError, OSError, ValueError) as e:
        log.error("%s", e)
        out.emit("status", state="error", msg=str(e))
        return 4

    cfg = {
        "lang": None if a.lang.lower() == "auto" else a.lang,
        "prompt": DEFAULT_PROMPT if a.prompt is None else a.prompt,
        "meter": a.meter, "meter_s": max(0.1, a.meter_ms / 1000.0), "dump": a.dump_wav, "max_backlog": a.max_backlog, "partial_ms": a.partial_ms, "listening_msg": "listening to " + listening,
        "seg": {"end_ms": a.end_ms, "max_s": a.max_s, "min_rms": a.min_rms},
    }
    ecfg = {"model": a.model, "device": a.device, "compute": a.compute, "beam": a.beam, "vad_filter": not a.no_vad_filter,
            "url": a.url, "response_format": a.response_format, "timeout": a.timeout, "models_dir": a.models_dir}
    try:
        engine = get_engine(a.engine, ecfg, logging.getLogger("stt.engine"))
    except (ValueError, RuntimeError) as e:
        out.emit("status", state="error", msg=str(e))
        return 1
    return Pipeline(source, engine, out, cfg, stop).run()


if __name__ == "__main__":
    try:
        code = main()
    except SystemExit:
        raise
    except BaseException:
        logging.getLogger("stt").exception("the program stopped with an error")
        raise
    logging.getLogger("stt").info("exit code %s", code)
    sys.exit(code)
