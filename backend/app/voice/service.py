"""Speech-to-text transcription service.

Resolves the configured STT backend and forwards the audio to it:

* ``local``  — the bundled faster-whisper worker (``WHISPER_URL``). The
  private, self-hosted default; mirrors how the code sandbox and SearXNG
  are reached over the internal docker network.
* ``openai`` — OpenAI's hosted transcription API. Optional; only used
  when ``STT_BACKEND=openai`` *and* an ``OPENAI_API_KEY`` is configured.
  Both go through the same multipart shape, so the call sites are nearly
  identical.

Everything funnels through :func:`transcribe_audio`, which raises
:class:`TranscriptionError` (mapped to a clean HTTP status by the router)
on any failure rather than leaking provider-specific exceptions.
"""
from __future__ import annotations

import logging

import httpx

from app.config import get_settings
from app.voice.schemas import TranscriptionResponse

logger = logging.getLogger("promptly.voice")

# OpenAI's transcription endpoint (OpenAI-compatible multipart form).
_OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions"


class TranscriptionError(Exception):
    """Transcription could not be completed.

    ``status_code`` is the HTTP status the router should surface; defaults
    to 502 (the upstream STT backend misbehaved) but is set to 503 when
    the backend isn't configured at all.
    """

    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


async def transcribe_audio(
    *,
    data: bytes,
    filename: str,
    content_type: str | None,
    language: str | None = None,
) -> TranscriptionResponse:
    """Transcribe a single dictation clip to text.

    Raises :class:`TranscriptionError` on any failure.
    """
    settings = get_settings()
    backend = (settings.STT_BACKEND or "local").strip().lower()

    if backend == "openai":
        return await _transcribe_openai(
            data=data,
            filename=filename,
            content_type=content_type,
            language=language,
        )
    # Default / unknown value → local worker.
    return await _transcribe_local(
        data=data,
        filename=filename,
        content_type=content_type,
        language=language,
    )


async def _transcribe_local(
    *,
    data: bytes,
    filename: str,
    content_type: str | None,
    language: str | None,
) -> TranscriptionResponse:
    settings = get_settings()
    base_url = (settings.WHISPER_URL or "").rstrip("/")
    if not base_url:
        raise TranscriptionError(
            "Voice transcription isn't configured on this server.",
            status_code=503,
        )

    files = {"file": (filename, data, content_type or "application/octet-stream")}
    form = {"language": language or ""}
    timeout = max(5, int(settings.STT_TIMEOUT_S or 60))
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{base_url}/transcribe", files=files, data=form
            )
    except httpx.HTTPError as exc:
        logger.warning("whisper unreachable: %s", exc)
        raise TranscriptionError(
            "Couldn't reach the transcription service. It may still be "
            "loading its model — try again in a moment.",
            status_code=503,
        ) from exc

    if resp.status_code != 200:
        detail = resp.text[:300]
        logger.warning("whisper error %s: %s", resp.status_code, detail)
        raise TranscriptionError(
            f"Transcription failed ({resp.status_code}).",
            status_code=502,
        )

    payload = resp.json()
    return TranscriptionResponse(
        text=str(payload.get("text") or "").strip(),
        language=payload.get("language"),
    )


async def synthesize_speech(
    *,
    text: str,
    voice: str | None = None,
    speed: float = 1.0,
) -> bytes:
    """Synthesize ``text`` to a WAV clip via the Kokoro TTS worker.

    Returns the raw WAV bytes. Raises :class:`TranscriptionError` (reused
    as the module's generic voice error) on any failure.
    """
    settings = get_settings()
    base_url = (settings.TTS_URL or "").rstrip("/")
    if not base_url:
        raise TranscriptionError(
            "Text-to-speech isn't configured on this server.",
            status_code=503,
        )

    body = {
        "text": text,
        "voice": voice or settings.TTS_VOICE or None,
        "speed": speed,
    }
    timeout = max(5, int(settings.TTS_TIMEOUT_S or 60))
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(f"{base_url}/tts", json=body)
    except httpx.HTTPError as exc:
        logger.warning("tts unreachable: %s", exc)
        raise TranscriptionError(
            "Couldn't reach the speech service. It may still be loading its "
            "model — try again in a moment.",
            status_code=503,
        ) from exc

    if resp.status_code != 200:
        detail = resp.text[:300]
        logger.warning("tts error %s: %s", resp.status_code, detail)
        raise TranscriptionError(
            f"Speech synthesis failed ({resp.status_code}).",
            status_code=502,
        )
    return resp.content


async def _transcribe_openai(
    *,
    data: bytes,
    filename: str,
    content_type: str | None,
    language: str | None,
) -> TranscriptionResponse:
    settings = get_settings()
    api_key = (settings.OPENAI_API_KEY or "").strip()
    if not api_key:
        raise TranscriptionError(
            "Cloud transcription is selected but no OpenAI API key is set.",
            status_code=503,
        )

    model = settings.STT_OPENAI_MODEL or "whisper-1"
    files = {"file": (filename, data, content_type or "application/octet-stream")}
    form: dict[str, str] = {"model": model, "response_format": "json"}
    # OpenAI wants the bare ISO-639 code ("en"), not a BCP-47 tag.
    if language:
        lang = language.strip().lower()
        if lang and lang != "auto":
            form["language"] = lang.split("-", 1)[0]
    timeout = max(5, int(settings.STT_TIMEOUT_S or 60))
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                _OPENAI_TRANSCRIBE_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                files=files,
                data=form,
            )
    except httpx.HTTPError as exc:
        logger.warning("openai transcription unreachable: %s", exc)
        raise TranscriptionError(
            "Couldn't reach the cloud transcription service.",
            status_code=502,
        ) from exc

    if resp.status_code != 200:
        detail = resp.text[:300]
        logger.warning("openai transcription error %s: %s", resp.status_code, detail)
        raise TranscriptionError(
            f"Transcription failed ({resp.status_code}).",
            status_code=502,
        )

    payload = resp.json()
    return TranscriptionResponse(
        text=str(payload.get("text") or "").strip(),
        language=payload.get("language"),
    )
