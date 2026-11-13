"""The engines that exist. Imported only when chosen, so a missing package of one engine never hurts another."""

NAMES = ("whisper", "openai", "fake")


def get_engine(name, cfg, log):
    name = (name or "whisper").lower()
    if name == "whisper":
        from .whisper_fw import WhisperEngine
        return WhisperEngine(cfg, log)
    if name == "openai":
        from .openai_http import OpenAIHttpEngine
        return OpenAIHttpEngine(cfg, log)
    if name == "fake":
        from .fake import FakeEngine
        return FakeEngine(cfg, log)
    raise ValueError(f"unknown engine {name!r} (known: {', '.join(NAMES)})")
