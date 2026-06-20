"""Voice API — speech-to-text dictation (Phase 1).

``POST /api/voice/transcribe`` takes a short audio clip recorded by the
browser's ``MediaRecorder`` and returns the transcript. The clip is
transient: we transcribe and discard it, never persisting it as a Drive
file (dictation shouldn't clutter the user's storage).

The heavy lifting lives in :mod:`app.voice.service`, which routes to the
self-hosted Whisper worker or the cloud API based on ``STT_BACKEND``.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response

from app.auth.deps import get_current_user
from app.auth.models import User
from app.config import get_settings
from app.voice.schemas import SpeechRequest, TranscriptionResponse
from app.voice.service import (
    TranscriptionError,
    synthesize_speech,
    transcribe_audio,
)

logger = logging.getLogger("promptly.voice")

router = APIRouter()


@router.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(
    file: UploadFile = File(...),
    # Optional BCP-47 hint (e.g. the browser's ``navigator.language``).
    # Empty / "auto" lets the backend auto-detect.
    language: str | None = Form(default=None),
    user: User = Depends(get_current_user),
) -> TranscriptionResponse:
    settings = get_settings()

    data = await file.read()
    await file.close()
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The recording was empty — try again.",
        )

    cap = int(settings.STT_MAX_AUDIO_BYTES or (25 * 1024 * 1024))
    if len(data) > cap:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Recording exceeds the {cap // (1024 * 1024)} MB limit.",
        )

    try:
        return await transcribe_audio(
            data=data,
            filename=file.filename or "audio.webm",
            content_type=file.content_type,
            language=language,
        )
    except TranscriptionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/tts")
async def tts(
    req: SpeechRequest,
    user: User = Depends(get_current_user),
) -> Response:
    """Synthesize text to speech (read-aloud + voice mode).

    Returns a WAV clip. The client plays it directly; we don't persist
    the audio. Voice mode chunks long replies into sentences and calls
    this once per sentence so playback can start before the whole reply
    is synthesised.
    """
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Nothing to read.",
        )
    try:
        wav = await synthesize_speech(text=text, voice=req.voice, speed=req.speed)
    except TranscriptionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            # Short-lived, per-utterance — let the browser cache within a
            # session (identical sentences re-read) but not persist.
            "Cache-Control": "private, max-age=60",
        },
    )
