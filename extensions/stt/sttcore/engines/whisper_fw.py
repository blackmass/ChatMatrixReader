"""Whisper through faster-whisper (CTranslate2). The first engine.

GPU: needs the CUDA 12 libraries (cuBLAS, cuDNN 9) that faster-whisper's own instructions describe. A model that loads fine can
still fail at the first real call when a DLL is missing, so load() makes a test call with one second of silence and falls
back to the CPU (int8) with a clear message when the GPU does not work.
"""
import glob
import os
import sys

import numpy as np

from .base import Engine, Result

DEFAULT_MODEL = "large-v3-turbo"        # NOTE: this alias needs a faster-whisper version that knows it; "small" / "medium" always work


def add_cuda_dll_dirs(log):
    """On Windows the CUDA libraries that come from pip (nvidia-cublas-cu12, nvidia-cudnn-cu12) lie in site-packages\\nvidia\\*\\bin,
    where nothing looks for them. Make them findable (and say which were found, for the log)."""
    if sys.platform != "win32":
        return []
    found = []
    for base in sys.path:
        if base.lower().endswith("site-packages"):
            found += glob.glob(os.path.join(base, "nvidia", "*", "bin"))
    for d in found:
        try:
            os.add_dll_directory(d)
        except Exception:
            pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
    log.info("CUDA library folders from pip: %s", found or "none (pip install nvidia-cublas-cu12 nvidia-cudnn-cu12)")
    return found


class WhisperEngine(Engine):
    name = "whisper"

    def __init__(self, cfg, log):
        super().__init__(cfg, log)
        self.model = None
        self.device = None
        self._info = {}

    def _make(self, device, compute):
        from faster_whisper import WhisperModel
        size = self.cfg.get("model") or DEFAULT_MODEL
        self.log.info("Whisper: model=%s device=%s compute=%s", size, device, compute)
        kw = {}
        root = self.cfg.get("models_dir")
        if root:                                        # models are stored here, not in the user's global Hugging Face cache
            os.makedirs(root, exist_ok=True)
            kw["download_root"] = root
        m = WhisperModel(size, device=device, compute_type=compute, **kw)
        # the test call: a missing GPU library shows up here, not when the model is created
        list(m.transcribe(np.zeros(16000, np.float32), language="en", beam_size=1)[0])
        return m

    def load(self):
        try:
            import faster_whisper  # noqa: F401
        except ImportError as e:
            raise RuntimeError("faster-whisper is not installed (pip install -r requirements.txt): %s" % e)
        add_cuda_dll_dirs(self.log)
        want = (self.cfg.get("device") or "auto").lower()
        compute = self.cfg.get("compute") or "auto"
        tries = []
        if want in ("auto", "cuda"):
            tries.append(("cuda", "float16" if compute == "auto" else compute))
        if want in ("auto", "cpu") or want == "cuda":
            tries.append(("cpu", "int8" if compute == "auto" or want == "auto" else compute))
        last = None
        for i, (dev, comp) in enumerate(tries):
            try:
                before = self._card_used() if dev == "cuda" else None
                self.model = self._make(dev, comp)
                self.device = dev
                after = self._card_used() if dev == "cuda" else None
                self._info = {"device": dev, "compute": comp, "model": self.cfg.get("model") or DEFAULT_MODEL,
                              "fallback": i > 0 and want in ("auto", "cuda"), "wanted": want}
                if before is not None and after is not None and after > before:
                    # what loading the model (and the test call) added to the card's memory: close to the model's real footprint
                    # (the error is whatever other programs allocated in those few seconds)
                    self._info["vram_model"] = after - before
                    self.log.info("Whisper video memory: card %.2f GB -> %.2f GB (model about %.2f GB)", before / 1024 ** 3, after / 1024 ** 3,
                                  (after - before) / 1024 ** 3)
                note = "" if i == 0 else "  (the GPU did not work: %s)" % (str(last).splitlines()[0][:160] if last else "")
                return f"Whisper {self.cfg.get('model') or DEFAULT_MODEL} on {dev} ({comp}){note}"
            except Exception as e:                      # a missing DLL, no CUDA device, out of memory ...
                last = e
                self.log.warning("Whisper on %s failed: %s", dev, e)
        raise RuntimeError("Whisper could not start: %s" % last)

    def transcribe(self, audio, language, prompt):
        segs, info = self.model.transcribe(
            audio, language=language, beam_size=int(self.cfg.get("beam", 1)),
            condition_on_previous_text=False, initial_prompt=prompt or None,
            vad_filter=bool(self.cfg.get("vad_filter", True)), no_speech_threshold=0.6,
        )
        return [Result(s.text.strip(), getattr(s, "avg_logprob", None), getattr(s, "no_speech_prob", None),
                       getattr(info, "language", None)) for s in segs]

    def _card_used(self):
        """Video memory in use on the whole card (NVIDIA only; None when it cannot be read)."""
        try:
            from .. import nvml
            n = nvml.Nvml.open()
            if n is None:
                return None
            try:
                return n.card(0)["used"]
            finally:
                n.close()
        except Exception:
            return None

    def info(self):
        return dict(self._info)

    def close(self):
        self.model = None
