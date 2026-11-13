"""Layer 3: a recognition engine. To add one (Qwen3-ASR, ...): write a file in this folder with a subclass of Engine and
register it in __init__.py. The STT system calls load() once, transcribe() for every sentence, close() at the end."""
from dataclasses import dataclass


@dataclass
class Result:
    text: str
    avg_logprob: float = None          # the engine's own confidence, if it has one (None = unknown)
    no_speech_prob: float = None
    language: str = None


class Engine:
    name = "base"
    streaming = False      # True: the engine can work on a sentence that is still being spoken (cheaply). False (Whisper): partial
                           # results mean running the whole sentence again and again - possible, but not recommended.

    def __init__(self, cfg, log):
        self.cfg = cfg                  # dict: model, device, compute, ... (whatever the engine knows)
        self.log = log

    def load(self):
        """Load the model (slow). Raise with a clear message when it cannot work. Return a short description."""
        raise NotImplementedError

    def transcribe(self, audio, language, prompt):
        """audio: float32 numpy array, mono, 16 kHz. language: "en" or None (detect). prompt: text that helps with names.
        Returns a list of Result."""
        raise NotImplementedError

    def info(self):
        """What the reader may show the user about how this engine runs: {"device": "cuda" | "cpu", "compute": "float16", "model": "...",
        "fallback": True when the wanted device did not work and another one is used}. {} = nothing to tell."""
        return {}

    def close(self):
        pass
