"""``POST /api/assistant``: what you said to the phone's assistant, what to say
back, and what the phone should do. ``/api/maps/assistant`` stays for apps that
were installed before this; it can't ask the phone to do anything but drive."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.maps.assistant import answer_request
from app.maps.router import assistant_user
from app.voice.service import TranscriptionError, synthesize_speech

router = APIRouter()


@router.post("")
async def assistant(
    request: Request,
    audio: UploadFile | None = File(default=None),
    text: str | None = Form(default=None, max_length=500),
    state: str = Form(default="{}", max_length=200_000),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(assistant_user),
) -> dict[str, Any]:
    return await answer_request(request, audio, text, state, db, user, phone=True)


class SpeakBody(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@router.post("/speak")
async def speak(body: SpeakBody, user: User = Depends(assistant_user)) -> Response:
    """An answer, in the voice chosen in your account. If this fails, the phone
    falls back to its own voice."""
    words = body.text.strip()
    if not words:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Nothing to say.")
    try:
        wav = await synthesize_speech(text=words, voice=(user.settings or {}).get("tts_voice") or None)
    except TranscriptionError as exc:
        raise HTTPException(exc.status_code, detail=str(exc)) from exc
    return Response(content=wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})
