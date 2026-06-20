"""Promptly text-to-speech worker (Voice Phase 2).

A tiny FastAPI service wrapping Kokoro-82M via ``kokoro-onnx``. The
backend POSTs a chunk of assistant text to ``/tts`` and gets back a WAV
clip to play. Kokoro is small enough to run comfortably in onnxruntime
on CPU and sounds markedly more natural than espeak/Piper.

Design mirrors the Whisper worker:

* **One model, loaded once** at import time and reused per request.
* **Weights auto-download on first boot** into a cache dir mounted to a
  host volume, so the image stays small and the pull is a one-time cost.
* **Stateless + internal-only** — lives on the ``promptly`` network;
  only the backend reaches it.

Audio is returned as 16-bit PCM WAV (Kokoro emits float32 at 24 kHz),
written with the stdlib ``wave`` module so we avoid a libsndfile system
dependency.
"""
from __future__ import annotations

import io
import logging
import os
import time
import wave

import numpy as np
import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("promptly.tts")

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "/root/.cache/kokoro")
# Default voice + language. ``af_heart`` is Kokoro's highest-quality
# American-English female voice; the backend can override per request.
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")
DEFAULT_LANG = os.environ.get("TTS_LANG", "en-us")
# Hard ceiling on a single synthesis request — voice-mode chunks text
# into sentences, so a huge payload is almost certainly a bug/abuse.
MAX_CHARS = int(os.environ.get("TTS_MAX_CHARS", "4000"))

_MODEL_FILE = "kokoro-v1.0.onnx"
_VOICES_FILE = "voices-v1.0.bin"
_RELEASE = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
)


def _ensure_file(path: str, url: str) -> None:
    """Download a model asset to ``path`` if it's not already cached."""
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    logger.info("Downloading %s …", os.path.basename(path))
    tmp = f"{path}.part"
    with requests.get(url, stream=True, timeout=600) as resp:
        resp.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                if chunk:
                    fh.write(chunk)
    os.replace(tmp, path)
    logger.info("Saved %s (%d bytes)", os.path.basename(path), os.path.getsize(path))


model_path = os.path.join(MODEL_DIR, _MODEL_FILE)
voices_path = os.path.join(MODEL_DIR, _VOICES_FILE)
_ensure_file(model_path, f"{_RELEASE}/{_MODEL_FILE}")
_ensure_file(voices_path, f"{_RELEASE}/{_VOICES_FILE}")

logger.info("Loading Kokoro model (voice=%s lang=%s)…", DEFAULT_VOICE, DEFAULT_LANG)
_t0 = time.monotonic()
# Imported after the download so an import-time model probe (if any) sees
# the files in place.
from kokoro_onnx import Kokoro  # noqa: E402

kokoro = Kokoro(model_path, voices_path)
logger.info("Kokoro ready in %.1fs", time.monotonic() - _t0)

app = FastAPI(title="Promptly TTS", docs_url=None, redoc_url=None)


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: str | None = None
    # Playback speed multiplier. 1.0 is natural; the conversational voice
    # mode may nudge it slightly faster.
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "voice": DEFAULT_VOICE}


def _to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(pcm16.tobytes())
    return buf.getvalue()


@app.post("/tts")
def tts(req: TTSRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text.")
    if len(text) > MAX_CHARS:
        raise HTTPException(
            status_code=413, detail=f"Text exceeds {MAX_CHARS} characters."
        )
    try:
        t0 = time.monotonic()
        samples, sample_rate = kokoro.create(
            text,
            voice=req.voice or DEFAULT_VOICE,
            speed=req.speed,
            lang=DEFAULT_LANG,
        )
        wav_bytes = _to_wav(samples, sample_rate)
        logger.info(
            "synthesized %d chars in %.2fs -> %d bytes",
            len(text),
            time.monotonic() - t0,
            len(wav_bytes),
        )
        return Response(content=wav_bytes, media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - clean 500
        logger.exception("synthesis failed")
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}") from exc
