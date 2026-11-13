"""An engine that recognises nothing: it only answers how long the sound was. For tests and for trying the pipeline without a model."""
import time

from .base import Engine, Result


class FakeEngine(Engine):
    name = "fake"
    streaming = True

    def load(self):
        return "fake engine (no model)"

    def transcribe(self, audio, language, prompt):
        time.sleep(float(self.cfg.get("fake_delay", 0.0)))
        return [Result(f"[fake] {len(audio) / 16000:.1f} s of sound", avg_logprob=-0.2, no_speech_prob=0.0, language=language)]
