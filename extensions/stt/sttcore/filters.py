"""Throws away what an engine makes up from noise (Whisper is known to write "Thank you." for silence and music)."""
import re

# Short, typical phantom texts. Only dropped when the sound was short or the engine was unsure (see keep()).
PHANTOMS = {
    "thank you", "thanks", "thanks for watching", "thank you for watching", "you", "bye", "bye bye", "okay", "ok", "yeah",
    "so", "uh", "um", "hmm", "mm", "oh", "the end", "subtitles by the amara.org community",
}


def _norm(t):
    return re.sub(r"[^a-z0-9 ]+", "", t.lower()).strip()


def keep(text, audio_s, avg_logprob=None, no_speech_prob=None, min_logprob=-1.6, max_no_speech=0.6):
    """-> (True, "") or (False, reason)."""
    t = text.strip()
    if not t or not re.search(r"\w", t):
        return False, "empty"
    if no_speech_prob is not None and avg_logprob is not None and no_speech_prob > max_no_speech and avg_logprob < -1.0:
        return False, f"no speech ({no_speech_prob:.2f}, logprob {avg_logprob:.2f})"
    if avg_logprob is not None and avg_logprob < min_logprob:
        return False, f"unsure (logprob {avg_logprob:.2f})"
    if _norm(t) in PHANTOMS and audio_s < 2.5 and (avg_logprob is None or avg_logprob < -0.5):
        return False, "phantom phrase"
    return True, ""
