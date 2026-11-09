"""Make the fixture clips for the whisper ``/live`` tests (WP-T1), with Kokoro.

No audio lives in the repo: run this in the tts image to synthesise the clips
into a scratch folder, then point the whisper tests at it (``LIVE_CLIPS``):

    docker run --rm -v "$SCRATCH:/clips" -v "$PWD/data/tts:/root/.cache:ro" \
        -v "$PWD/tts/tests:/tests:ro" promptly-tts:<tag> python /tests/make_live_clips.py /clips

Each clip is 16 kHz mono 16-bit: lead-in silence, the parts with the pauses
given between them, and trailing silence long enough for the turn to end.
``manifest.json`` says what each should give.
"""
from __future__ import annotations

import json
import os
import sys
import wave
from pathlib import Path

import numpy as np

SR_OUT = 16_000

# parts: text, or a pause in seconds. expect: what the whisper tests check.
CLIPS = [
    {"id": "calendar", "parts": ["What's on my calendar today?"], "turns": 1, "words": [["calendar", "today"]]},
    {"id": "timer", "parts": ["Set a timer for ten minutes."], "turns": 1, "words": [["timer", "minutes"]]},
    # Kokoro pauses ~300 ms inside "...my calendar on Thursday at nine in the
    # morning?" and Smart Turn rightly calls "...on Thursday?" finished, so the
    # long one is phrased the way Kokoro says without a pause.
    {"id": "dentist", "parts": ["Can you put the dentist in my calendar for Thursday morning at nine thirty"], "turns": 1, "words": [["dentist", "calendar", "thursday"]]},
    {"id": "dentist_pause", "parts": ["Can you add the dentist to my calendar on Thursday at nine in the morning?"], "probe": True},
    {"id": "yes", "parts": ["Yes."], "turns": 1, "words": [["yes"]]},
    {"id": "no", "parts": ["No."], "turns": 1, "words": [["no"]]},
    {
        "id": "two_turns",
        "parts": ["Set a timer.", 2.0, "What's the weather like tomorrow?"],
        "turns": 2,
        "words": [["timer"], ["weather", "tomorrow"]],
    },
    # Real Smart Turn caught this cut-off one as unfinished in WP-T0 (0.34).
    {
        "id": "bunnings",
        "parts": ["I want to go to the", 0.8, "Bunnings near the station, please."],
        "turns": 1,
        "words": [["want", "go", "station"]],
    },
    # Kokoro says this one with a finished, falling tone (WP-T0: 0.99), so the
    # mid-thought test scripts Smart Turn for its first pause.
    {
        "id": "remind",
        "parts": ["Can you remind me to call", 0.9, "Sam tomorrow at nine?"],
        "turns": 1,
        "words": [["remind", "call", "sam", "tomorrow"]],
        "scripted": True,
    },
    {"id": "noise", "noise_s": 3.0, "turns": 0, "words": []},
]

LEAD_S = 0.5
TAIL_S = 2.2


def resample_24k_to_16k(x: np.ndarray) -> np.ndarray:
    """Up 2, low-pass at 7.6 kHz (windowed sinc), down 3."""
    up = np.zeros(len(x) * 2, dtype=np.float64)
    up[::2] = x * 2.0
    taps = 129
    n = np.arange(taps) - (taps - 1) / 2
    cutoff = 7600 / 48_000
    h = 2 * cutoff * np.sinc(2 * cutoff * n) * np.hamming(taps)
    y = np.convolve(up, h, mode="same")
    return y[::3].astype(np.float32)


def main(out_dir: str) -> None:
    from kokoro_onnx import Kokoro

    folder = os.environ.get("TTS_MODEL_DIR", "/root/.cache/kokoro")
    kokoro = Kokoro(os.path.join(folder, "kokoro-v1.0.onnx"), os.path.join(folder, "voices-v1.0.bin"))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    rng = np.random.default_rng(7)
    for clip in CLIPS:
        audio = [np.zeros(int(LEAD_S * SR_OUT), np.float32)]
        segments = []  # (start_s, end_s) of speech
        pos = LEAD_S
        if "noise_s" in clip:
            audio.append((rng.standard_normal(int(clip["noise_s"] * SR_OUT)) * 0.003).astype(np.float32))
            pos += clip["noise_s"]
        for part in clip.get("parts", []):
            if isinstance(part, (int, float)):
                audio.append(np.zeros(int(part * SR_OUT), np.float32))
                pos += part
                continue
            samples, rate = kokoro.create(part, voice="af_heart", speed=1.0, lang="en-us")
            speech = resample_24k_to_16k(np.asarray(samples, dtype=np.float32))
            audio.append(speech)
            segments.append((round(pos, 3), round(pos + len(speech) / SR_OUT, 3)))
            pos += len(speech) / SR_OUT
        audio.append(np.zeros(int(TAIL_S * SR_OUT), np.float32))
        data = np.concatenate(audio)
        name = f"{clip['id']}.wav"
        with wave.open(str(out / name), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR_OUT)
            w.writeframes((np.clip(data, -1, 1) * 32767).astype("<i2").tobytes())
        row = {k: v for k, v in clip.items() if k != "parts"}
        row.update({"file": name, "seconds": round(len(data) / SR_OUT, 2), "speech": segments, "text": [p for p in clip.get("parts", []) if isinstance(p, str)]})
        rows.append(row)
        print(f"{name}: {row['seconds']} s, speech {segments}")
    (out / "manifest.json").write_text(json.dumps({"clips": rows}, indent=2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/clips")
