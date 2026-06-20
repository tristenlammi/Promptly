"""Pydantic schemas for the voice (speech-to-text) API."""
from __future__ import annotations

from pydantic import BaseModel


class TranscriptionResponse(BaseModel):
    """Result of transcribing a dictation clip."""

    # The recognised text. May be empty when the clip was silence — the
    # frontend treats "" as "nothing to append" rather than an error.
    text: str
    # ISO-639 language Whisper detected (or echoed back from the hint).
    # ``None`` when the backend doesn't report one.
    language: str | None = None
