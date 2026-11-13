"""Any server that speaks the OpenAI speech-to-text API:  POST <base>/audio/transcriptions  (multipart: file, model, language, prompt,
response_format)  ->  {"text": "..."}  (verbose_json: also "segments" with avg_logprob / no_speech_prob).

OpenAI itself, Groq, vLLM (also with Qwen3-ASR), LocalAI, speaches ... Only the Python standard library and numpy are used.
Every finished sentence is one request; the server may be on this PC or far away - THE SOUND IS SENT THERE (the reader says so).

Errors are raised as  RuntimeError("[code] detail")  with a code the reader turns into its own words:
    no_connection | not_found | unauthorized | bad_request | server_error | timeout | bad_response | bad_address
"""
import io
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave

import numpy as np

from .base import Engine, Result

ENV_KEY = "CHATMATRIX_STT_API_KEY"        # the key travels in the environment, not on the command line (visible to every program)


def endpoint(base):
    """http://localhost:8000/v1  ->  http://localhost:8000/v1/audio/transcriptions  (an address that already ends so is kept)."""
    u = (base or "").strip().rstrip("/")
    p = urllib.parse.urlparse(u)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise RuntimeError("[bad_address] the address must start with http:// or https:// (for example http://localhost:8000/v1)")
    if u.endswith("/audio/transcriptions"):
        return u
    return u + "/audio/transcriptions"


def wav_bytes(audio):
    """float32 mono 16 kHz -> a WAV file (16 bit) in memory."""
    pcm = (np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def multipart(fields, file_name, file_bytes):
    """-> (body, content type). fields: {name: text}."""
    boundary = "----cmstt" + uuid.uuid4().hex
    parts = []
    for k, val in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n'.encode() + str(val).encode("utf-8") + b"\r\n")
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file_name}"\r\n'
                  "Content-Type: audio/wav\r\n\r\n").encode() + file_bytes + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def parse_response(raw, response_format):
    """Server answer (bytes) -> list of Result."""
    text = raw.decode("utf-8", errors="replace")
    try:
        data = json.loads(text)
    except ValueError:
        if response_format == "text":
            return [Result(text.strip())] if text.strip() else []
        raise RuntimeError("[bad_response] the answer is not JSON: " + text[:120].replace("\n", " "))
    if not isinstance(data, dict):
        raise RuntimeError("[bad_response] unexpected answer: " + text[:120].replace("\n", " "))
    lang = data.get("language") if isinstance(data.get("language"), str) else None
    segs = data.get("segments")
    if isinstance(segs, list) and segs:
        out = []
        for s in segs:
            if isinstance(s, dict) and isinstance(s.get("text"), str):
                out.append(Result(s["text"], _num(s.get("avg_logprob")), _num(s.get("no_speech_prob")), lang))
        if out:
            return out
    if not isinstance(data.get("text"), str):
        raise RuntimeError('[bad_response] the answer has no "text": ' + text[:120].replace("\n", " "))
    t = data["text"].strip()
    return [Result(t, None, None, lang)] if t else []


def _num(x):
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


class OpenAIHttpEngine(Engine):
    name = "openai"
    streaming = False                       # one request per sentence: no cheap "text so far" (the reader does not offer live mode)

    def __init__(self, cfg, log):
        super().__init__(cfg, log)
        self.url = endpoint(cfg.get("url"))
        self.key = cfg.get("api_key") or os.environ.get(ENV_KEY, "")
        self.model = cfg.get("model") or "whisper-1"
        self.fmt = cfg.get("response_format") if cfg.get("response_format") in ("json", "verbose_json", "text") else "json"
        self.timeout = max(2.0, float(cfg.get("timeout") or 30))

    def load(self):
        t0 = time.perf_counter()
        self.transcribe(np.zeros(16000, np.float32), None, None)       # a second of silence: is the server there, are address / key / model right?
        host = urllib.parse.urlparse(self.url).netloc
        return f"OpenAI-compatible server {host}, model {self.model} - answered in {time.perf_counter() - t0:.1f} s"

    def transcribe(self, audio, language, prompt):
        fields = {"model": self.model, "response_format": self.fmt, "temperature": 0}
        if language:
            fields["language"] = language
        if prompt:
            fields["prompt"] = prompt
        body, ctype = multipart(fields, "speech.wav", wav_bytes(audio))
        headers = {"Content-Type": ctype, "Accept": "application/json"}
        if self.key:
            headers["Authorization"] = "Bearer " + self.key
        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")[:200].replace("\n", " ")
            except Exception:
                pass
            code = {401: "unauthorized", 403: "unauthorized", 404: "not_found"}.get(e.code)
            if code is None:
                code = "bad_request" if 400 <= e.code < 500 else "server_error"
            raise RuntimeError(f"[{code}] HTTP {e.code} {detail}") from None
        except socket.timeout:
            raise RuntimeError(f"[timeout] no answer within {self.timeout:.0f} s") from None
        except urllib.error.URLError as e:
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                raise RuntimeError(f"[timeout] no answer within {self.timeout:.0f} s") from None
            raise RuntimeError(f"[no_connection] {e.reason}") from None
        except (ConnectionError, OSError) as e:
            raise RuntimeError(f"[no_connection] {e}") from None
        return parse_response(raw, self.fmt)
