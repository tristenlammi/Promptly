"""Promptly speech-to-text worker (Voice Phase 1).

A tiny FastAPI service wrapping ``faster-whisper``. The backend POSTs a
short audio clip (the browser records dictation with ``MediaRecorder``,
usually WebM/Opus) to ``/transcribe`` and gets back the transcript text.

Design notes
------------
* **One model, loaded once.** ``WhisperModel`` is instantiated at import
  time and reused for every request. The first instantiation downloads
  the model weights from Hugging Face into ``/root/.cache`` — mounted to
  a host volume in compose so it's a one-time cost, not per-boot.
* **int8 on CPU by default.** The defaults (``base`` / ``int8`` / ``cpu``)
  are tuned for "drop in and run" on a homelab box with no GPU. An
  operator with a GPU sets ``WHISPER_DEVICE=cuda`` +
  ``WHISPER_COMPUTE_TYPE=float16`` and can bump ``WHISPER_MODEL`` to
  ``small`` / ``medium`` / ``large-v3`` for higher accuracy.
* **VAD trimming.** ``vad_filter=True`` drops leading/trailing silence so
  a clip where the user paused before speaking still transcribes cleanly
  and a bit faster.
* **Stateless + internal-only.** Like the code sandbox this lives on the
  internal ``promptly`` docker network; only the backend reaches it.
"""
from __future__ import annotations

import logging
import os
import tempfile
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("promptly.whisper")

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
# How many CPU threads CTranslate2 may use per transcription. 0 lets the
# library pick (= number of cores). Capped via env on shared boxes so a
# long clip doesn't peg every core.
CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "0"))
# Hard ceiling on a single clip. Dictation turns are short; anything past
# this is almost certainly a stuck recording or an abusive upload.
MAX_AUDIO_BYTES = int(os.environ.get("WHISPER_MAX_AUDIO_BYTES", str(25 * 1024 * 1024)))

logger.info(
    "Loading Whisper model %r (device=%s compute=%s) — first run downloads weights…",
    MODEL_NAME,
    DEVICE,
    COMPUTE_TYPE,
)
_t0 = time.monotonic()
model = WhisperModel(
    MODEL_NAME,
    device=DEVICE,
    compute_type=COMPUTE_TYPE,
    cpu_threads=CPU_THREADS,
)
logger.info("Model ready in %.1fs", time.monotonic() - _t0)

app = FastAPI(title="Promptly Whisper", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    # BCP-47 / ISO-639 language hint. Empty / "auto" lets Whisper detect.
    language: str | None = Form(default=None),
) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload.")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio exceeds {MAX_AUDIO_BYTES // (1024 * 1024)} MB limit.",
        )

    lang = (language or "").strip().lower()
    if lang in {"", "auto"}:
        lang = None
    elif "-" in lang:
        # Normalise "en-US" → "en"; Whisper wants the bare language code.
        lang = lang.split("-", 1)[0]

    # faster-whisper decodes via PyAV from a path, so spool to a temp file.
    # ``delete=False`` + manual unlink keeps it working on Windows-mounted
    # volumes too (an open NamedTemporaryFile can't be re-opened there).
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        t0 = time.monotonic()
        segments, info = model.transcribe(
            tmp_path,
            language=lang,
            vad_filter=True,
            # ``condition_on_previous_text=False`` stops Whisper from
            # looping/repeating on short clips with little context.
            condition_on_previous_text=False,
        )
        # ``segments`` is a lazy generator — transcription actually runs
        # as we iterate it.
        text = "".join(seg.text for seg in segments).strip()
        elapsed = time.monotonic() - t0
        logger.info(
            "transcribed %d bytes in %.2fs (lang=%s) -> %d chars",
            len(data),
            elapsed,
            info.language,
            len(text),
        )
        return {"text": text, "language": info.language}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface a clean 500
        logger.exception("transcription failed")
        raise HTTPException(
            status_code=500, detail=f"Transcription failed: {exc}"
        ) from exc
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
