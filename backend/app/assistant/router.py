"""``POST /api/assistant``: what you said to the phone's assistant, what to say
back, and what the phone should do. ``/api/maps/assistant`` stays for apps that
were installed before this; it can't ask the phone to do anything but drive."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.maps.assistant import answer_request
from app.maps.router import assistant_user

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
