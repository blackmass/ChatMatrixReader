"""PCM helpers: bytes from the capture -> mono float32 at 16 kHz (what Whisper wants)."""
import numpy as np

TARGET_SR = 16000


def pcm_to_mono(pcm: bytes, channels: int, is_float: bool = False) -> np.ndarray:
    """Interleaved little-endian PCM (16-bit integer, or 32-bit float) -> float32 in [-1, 1], channels averaged."""
    if not pcm:
        return np.zeros(0, np.float32)
    channels = max(1, channels)
    if is_float:
        n = (len(pcm) // 4 // channels) * channels
        x = np.frombuffer(pcm[:n * 4], dtype="<f4").astype(np.float32)
        x = x.reshape(-1, channels).mean(axis=1) if channels > 1 else x
        return np.clip(np.nan_to_num(x), -1.0, 1.0)
    return pcm16_to_mono(pcm, channels)


def pcm16_to_mono(pcm: bytes, channels: int) -> np.ndarray:
    """16-bit little-endian PCM (interleaved) -> float32 in [-1, 1], channels averaged."""
    if not pcm:
        return np.zeros(0, np.float32)
    n = (len(pcm) // 2 // max(1, channels)) * max(1, channels)      # whole frames only
    x = np.frombuffer(pcm[:n * 2], dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    return x


class Resampler:
    """Streaming linear-interpolation resampler (with a light low-pass in front when the rate goes down).
    Good enough for speech recognition; keeps its position between chunks so no click appears at the joins."""

    def __init__(self, sr_in, sr_out=TARGET_SR):
        self.sr_in, self.sr_out = sr_in, sr_out
        self.step = sr_in / sr_out
        self.buf = np.zeros(0, np.float32)
        self.pos = 0.0                                          # where the next output sample lies, in input samples from buf[0]

    def process(self, x: np.ndarray) -> np.ndarray:
        if self.sr_in == self.sr_out:
            return x.astype(np.float32, copy=False)
        buf = np.concatenate([self.buf, x]) if len(self.buf) else x.astype(np.float32, copy=False)
        if self.step > 1.0 and len(buf) >= 3:                   # anti-aliasing: a 3-tap smoothing
            filt = np.convolve(buf, np.array([0.25, 0.5, 0.25], np.float32), mode="same")
            filt[0], filt[-1] = buf[0], buf[-1]
        else:
            filt = buf
        last = len(buf) - 2                                     # the last 2 samples are not final (filter edge): wait for more
        if last <= self.pos:
            self.buf = buf
            return np.zeros(0, np.float32)
        idx = np.arange(self.pos, last, self.step)
        i0 = np.floor(idx).astype(np.int64)
        frac = (idx - i0).astype(np.float32)
        out = filt[i0] * (1.0 - frac) + filt[i0 + 1] * frac
        next_pos = idx[-1] + self.step
        keep = int(np.floor(next_pos))
        self.buf = buf[keep:]
        self.pos = next_pos - keep
        return out.astype(np.float32)


def db(rms: float) -> float:
    return 20.0 * np.log10(max(rms, 1e-6))
