"""Makes engine/stt/tests/golden/ from the 2.x Python reader (the "answer sheet" of the C++ engine).

    python tools/make_golden_stt.py <path to the 2.x folder  extensions/stt>

Needs numpy. The input sounds are made here (seeded, so the same every time) and saved as 16 bit PCM; the expected results are what the
2.x Segmenter / filters.keep give for them. The C++ tests (engine/stt/tests) must reproduce them.
"""
import os
import sys

import numpy as np

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine", "stt", "tests", "golden")
SR = 16000
CHUNKS = [1000, 3200, 777, 480, 9600, 160, 2048]            # the sound is fed in pieces of these sizes, round and round


def noise(rng, sec, amp):
    return (rng.standard_normal(int(sec * SR)) * amp).astype(np.float64)


def speech(rng, sec, amp, f0=140.0, syll=4.0, floor=0.0):
    """Something with the energy shape of speech: harmonics of a voice, rising and falling like syllables, over a little noise."""
    t = np.arange(int(sec * SR)) / SR
    env = 0.55 + 0.45 * np.sin(2 * np.pi * syll * t + rng.uniform(0, 6.28)) ** 2
    x = sum(np.sin(2 * np.pi * f0 * k * t + k) / k for k in range(1, 9))
    x = x / np.max(np.abs(x))
    return x * env * amp + rng.standard_normal(len(t)) * floor


def build(name, rng):
    n = lambda s, a: noise(rng, s, a)
    sp = lambda s, a, **k: speech(rng, s, a, **k)
    if name == "basic":
        parts = [n(2.0, .003), sp(1.5, .1), n(1.2, .003), sp(3.0, .2), n(2.0, .003), sp(0.2, .1), n(1.0, .003), sp(1.0, .15), n(1.0, .003)]
    elif name == "quiet":
        parts = [n(2.0, .001), sp(1.6, .03), n(1.5, .001), sp(2.0, .025), n(1.5, .001)]
    elif name == "noisy":
        parts = [n(3.0, .02), sp(2.0, .2), n(1.5, .02), sp(2.5, .25), n(1.5, .02), sp(0.1, .2), n(1.5, .02)]
    elif name == "long":
        parts = [n(1.0, .003)]
        for _ in range(5):                                   # 20 s of talk with short dips every ~4 s, no real pause
            parts += [sp(3.6, .15), sp(0.3, .015)]
        parts += [n(2.0, .003)]
    elif name == "flush":
        parts = [n(1.5, .003), sp(2.0, .15), n(1.0, .003), sp(1.4, .15)]       # ends while speaking
    elif name == "quick":
        parts = [n(1.0, .003)] + [x for _ in range(6) for x in (sp(0.8, .15), n(0.5, .003))]
    else:
        raise KeyError(name)
    x = np.concatenate(parts)
    return np.clip(x, -1, 1)


# name, params of the Segmenter, flush at the end?
CASES = [
    ("basic", {}, True), ("basic", {"end_ms": 400, "min_ms": 200}, True), ("quiet", {}, True), ("noisy", {}, True),
    ("long", {}, True), ("long", {"max_s": 5.0}, True), ("flush", {}, True), ("flush", {}, False), ("quick", {"end_ms": 300}, True),
]


def run(ext_dir):
    sys.path.insert(0, ext_dir)
    from sttcore.segmenter import Segmenter
    from sttcore import filters
    os.makedirs(OUT, exist_ok=True)
    made = []
    for i, (name, params, flush) in enumerate(CASES):
        rng = np.random.RandomState(100 + sorted({c[0] for c in CASES}).index(name))        # (the same sound for the cases that share a name)
        x16 = (build(name, rng) * 32767).astype("<i2")
        tag = f"seg{i}_{name}"
        x16.tofile(os.path.join(OUT, f"in_{name}.pcm"))
        samples = x16.astype(np.float32) / 32768.0
        seg = Segmenter(**params)
        lines = [f"# {name} params={params} flush={flush}", f"input in_{name}.pcm", "params " + " ".join(f"{k}={v}" for k, v in params.items()), f"flush {1 if flush else 0}",
                 "chunks " + " ".join(map(str, CHUNKS))]
        pos, k, got = 0, 0, []
        while pos < len(samples):
            c = CHUNKS[k % len(CHUNKS)]; k += 1
            got += seg.feed(samples[pos:pos + c]); pos += c
        if flush:
            got += seg.flush()
        for s in got:
            lines.append(f"seg {len(s)} {float(np.sum(s, dtype=np.float64)):.6f} {float(s[0]):.6f} {float(s[-1]):.6f}")
        lines.append(f"end speaking={1 if seg.speaking else 0}")
        open(os.path.join(OUT, tag + ".txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
        made.append((tag, len(got)))
    # the filter: (text, audio seconds, avg_logprob, no_speech_prob)
    cases = [
        ("Hello there", 3.0, None, None), ("", 1.0, None, None), ("   ", 1.0, None, None), ("...", 1.0, None, None), ("♪♪", 2.0, -0.2, 0.1),
        ("Thank you.", 1.2, -0.7, 0.1), ("Thank you.", 1.2, -0.3, 0.1), ("Thank you.", 3.0, -0.9, 0.1), ("Thank you.", 1.2, None, None),
        ("Thanks for watching!", 2.0, -1.0, 0.2), ("You", 1.0, -0.6, 0.0), ("okay", 2.4, None, None), ("Okay", 2.6, None, None),
        ("The end", 1.0, -1.2, 0.3), ("Subtitles by the Amara.org community", 2.0, -0.8, 0.2),
        ("I think so", 2.0, -1.7, 0.1), ("I think so", 2.0, -1.6, 0.1), ("I think so", 2.0, -1.59, 0.1), ("something", 2.0, -1.2, 0.7), ("something", 2.0, -0.8, 0.9),
        ("something", 2.0, -1.0, 0.7), ("something", 2.0, -1.01, 0.61), ("something", 2.0, -1.01, 0.6),
        ("안녕하세요", 1.5, -0.4, 0.1), ("네", 0.6, -0.9, 0.2), ("こんにちは", 1.0, -0.5, 0.1), ("你好", 1.0, -0.5, 0.1), ("…", 1.0, -0.5, 0.1), ("！？", 1.0, None, None),
        ("😀", 1.0, None, None), ("a", 1.0, None, None), ("_", 1.0, None, None), ("1", 1.0, None, None), ("“”", 1.0, None, None), ("—", 1.0, None, None),
        ("  Thank you  ", 1.0, -0.8, 0.1), ("THANK YOU!!!", 1.0, -0.8, 0.1), ("Bye-bye", 1.0, -0.8, 0.1), ("Mm.", 1.0, None, None), ("Uh... um", 1.0, -0.9, 0.1),
        ("Ünïcödé", 1.0, None, None), ("Привет", 1.0, -0.3, 0.1), ("مرحبا", 1.0, -0.3, 0.1),
    ]
    lines = ["# text<TAB>audio_s<TAB>avg_logprob|-<TAB>no_speech_prob|-<TAB>ok<TAB>reason"]
    for text, a, lp, nsp in cases:
        ok, why = filters.keep(text, a, lp, nsp)
        lines.append("\t".join([text, repr(a), "-" if lp is None else repr(lp), "-" if nsp is None else repr(nsp), "1" if ok else "0", why]))
    open(os.path.join(OUT, "filters.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print("segmenter:", made, " filters:", len(cases))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    run(sys.argv[1])
