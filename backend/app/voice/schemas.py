"""Pydantic schemas for the voice (speech-to-text / text-to-speech) API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class TranscriptionResponse(BaseModel):
    """Result of transcribing a dictation clip."""

    # The recognised text. May be empty when the clip was silence — the
    # frontend treats "" as "nothing to append" rather than an error.
    text: str
    # ISO-639 language Whisper detected (or echoed back from the hint).
    # ``None`` when the backend doesn't report one.
    language: str | None = None


class SpeechRequest(BaseModel):
    """Request to synthesize a chunk of text to speech."""

    text: str = Field(..., min_length=1, max_length=4000)
    # Optional Kokoro voice override (e.g. "af_heart"). Falls back to the
    # server default when omitted.
    voice: str | None = None
    # Playback speed multiplier; 1.0 is natural.
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
