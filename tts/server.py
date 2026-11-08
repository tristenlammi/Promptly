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

``POST /tts/stream`` (Talk, WP-T1) streams the same voice as it's made:
a short first clause, then sentence by sentence, as Opus packets (libopus)
or raw PCM, and stops making audio the moment the caller hangs up.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import threading
import time
import wave
from typing import Literal

import numpy as np
import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import streaming

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
# onnxruntime threads for Kokoro. WP-T0: 4 was as fast as one-per-core on a
# quiet box and 2-3x faster on a busy one (one-per-core oversubscribes).
# 0 = onnxruntime's default.
THREADS = int(os.environ.get("TTS_THREADS", "4"))
# Streams making audio at once; more wait their turn rather than all slowing.
STREAM_SLOTS = max(1, int(os.environ.get("TTS_STREAM_SLOTS", "2")))
OPUS_BITRATE = int(os.environ.get("TTS_OPUS_BITRATE", "32000"))

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

if THREADS > 0:
    import onnxruntime as ort  # noqa: E402

    _opts = ort.SessionOptions()
    _opts.intra_op_num_threads = THREADS
    _opts.inter_op_num_threads = 1
    kokoro = Kokoro.from_session(
        ort.InferenceSession(model_path, sess_options=_opts, providers=["CPUExecutionProvider"]),
        voices_path,
    )
else:
    kokoro = Kokoro(model_path, voices_path)
logger.info("Kokoro ready in %.1fs (threads=%s)", time.monotonic() - _t0, THREADS or "default")

# espeak-ng (the phonemizer) isn't thread-safe; both endpoints phonemize under
# this lock, then synthesise from phonemes in parallel.
_phonemize_lock = threading.Lock()


def _phonemize(text: str) -> str:
    with _phonemize_lock:
        return kokoro.tokenizer.phonemize(text, DEFAULT_LANG)


_stream_slots = asyncio.Semaphore(STREAM_SLOTS)
_streams = {"active": 0, "done": 0, "cancelled": 0, "pieces": 0}

app = FastAPI(title="Promptly TTS", docs_url=None, redoc_url=None)


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: str | None = None
    # Playback speed multiplier. 1.0 is natural; the conversational voice
    # mode may nudge it slightly faster.
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "voice": DEFAULT_VOICE,
        "threads": THREADS or "default",
        "streams": {**_streams, "slots": STREAM_SLOTS},
    }


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
            _phonemize(text),
            voice=req.voice or DEFAULT_VOICE,
            speed=req.speed,
            lang=DEFAULT_LANG,
            is_phonemes=True,
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


# ------------------------------------------------------- POST /tts/stream (Talk)


class StreamRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    # "opus": raw 20 ms Opus packets, each after a 2-byte big-endian length.
    # "pcm": little-endian 16-bit mono samples. Both at 24 kHz.
    format: Literal["opus", "pcm"] = "opus"
    # Speak the first clause on its own (cut to a few words if it runs long),
    # so audio starts ~300 ms in. Off when the caller already sends clauses.
    first_clause: bool = True
    # Silence after the last piece. Talk sends a reply one piece per request
    # (it can't wait for the whole reply), so the pause a sentence or clause
    # ends with is asked for here (WP-T2).
    tail_ms: int = Field(default=0, ge=0, le=1000)


@app.post("/tts/stream")
async def tts_stream(req: StreamRequest) -> StreamingResponse:
    """Speech as it's made: piece by piece, each through Kokoro's ``create_stream``.

    Hanging up cancels: the piece being made finishes (onnxruntime can't be
    interrupted mid-run) and nothing after it is started.
    """
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text.")
    if len(text) > MAX_CHARS:
        raise HTTPException(status_code=413, detail=f"Text exceeds {MAX_CHARS} characters.")
    voice = req.voice or DEFAULT_VOICE
    if voice not in kokoro.voices:
        raise HTTPException(status_code=400, detail=f"Unknown voice {voice!r}.")
    pieces = streaming.split_pieces(text, first_clause=req.first_clause)
    if not pieces:
        raise HTTPException(status_code=400, detail="Nothing to say.")
    pieces[-1].gap_ms = req.tail_ms
    framer = streaming.OpusFramer(OPUS_BITRATE) if req.format == "opus" else None

    def encode(samples: np.ndarray) -> bytes:
        return framer.push(samples) if framer else streaming.pcm16(samples)

    async def audio():
        _streams["active"] += 1
        t0 = time.monotonic()
        first_ms = None
        made = 0
        finished = False
        try:
            for piece in pieces:
                async with _stream_slots:
                    phonemes = await asyncio.to_thread(_phonemize, piece.text)
                    chunks = [
                        samples
                        async for samples, _rate in kokoro.create_stream(
                            phonemes, voice=voice, speed=req.speed, lang=DEFAULT_LANG, is_phonemes=True
                        )
                    ]
                made += 1
                _streams["pieces"] += 1
                for samples in chunks:
                    data = encode(samples)
                    if data:
                        if first_ms is None:
                            first_ms = (time.monotonic() - t0) * 1000
                        yield data
                if piece.gap_ms:
                    data = encode(streaming.silence(piece.gap_ms))
                    if data:
                        yield data
            if framer:
                tail = framer.flush()
                if tail:
                    yield tail
            finished = True
        finally:
            _streams["active"] -= 1
            if finished:
                _streams["done"] += 1
            else:
                _streams["cancelled"] += 1
            logger.info(
                "stream %s: %d of %d pieces, %d chars, first audio %s ms, %.2fs",
                "done" if finished else "cancelled",
                made,
                len(pieces),
                len(text),
                "-" if first_ms is None else f"{first_ms:.0f}",
                time.monotonic() - t0,
            )

    headers = {
        "X-Audio-Format": "opus" if framer else "pcm_s16le",
        "X-Sample-Rate": str(streaming.SAMPLE_RATE),
        "X-Channels": "1",
        "Cache-Control": "no-store",
    }
    if framer:
        headers["X-Frame-Ms"] = str(streaming.FRAME_MS)
        headers["X-Opus-Framing"] = "u16be-length"
    return StreamingResponse(audio(), media_type="application/octet-stream", headers=headers)
