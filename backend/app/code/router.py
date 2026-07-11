"""User-facing code execution — ``POST /api/code/run``.

Lets a user click "Run" on a code block / code artifact and execute it in the
same hardened sandbox the ``code_interpreter`` chat tool uses — but without a
model in the loop. Gated per-user by ``can_execute_code`` (admins always
allowed); the client hides the button when the flag is off, and this endpoint
re-checks it so a forged request can't bypass the gate.

Phase 1: Python only, one-shot (no streaming). When a ``conversation_id`` is
supplied and owned by the caller, the run shares that conversation's sandbox
session, so it sees files the model created / the user uploaded in that chat
(e.g. "run the script the assistant just wrote").
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Conversation
from app.chat.sandbox_exec import (
    SandboxError,
    SandboxNotConfigured,
    run_python_in_sandbox,
)
from app.database import get_db

logger = logging.getLogger("promptly.code")

router = APIRouter(prefix="/code", tags=["code"])

_MAX_CODE_CHARS = 20_000


class CodeRunRequest(BaseModel):
    code: str = Field(min_length=1, max_length=_MAX_CODE_CHARS)
    # Forward-compatible: only "python" is accepted in Phase 1, but the field
    # ships now so the wire contract doesn't change when JS/other land.
    language: str = "python"
    # When set + owned by the caller, share this conversation's sandbox
    # session so the run sees its uploaded / model-created files.
    conversation_id: uuid.UUID | None = None


class CodeRunOutputFile(BaseModel):
    id: uuid.UUID
    filename: str
    mime_type: str
    size_bytes: int


class CodeRunResponse(BaseModel):
    exit_code: int | None
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    timed_out: bool
    outputs: list[CodeRunOutputFile]


def _user_can_execute_code(user: User) -> bool:
    if getattr(user, "role", None) == "admin":
        return True
    return bool(getattr(user, "can_execute_code", False))


@router.post("/run", response_model=CodeRunResponse)
async def run_code(
    payload: CodeRunRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CodeRunResponse:
    # Defence-in-depth: the client hides the button on this flag, but never
    # trust the client — re-check server-side (mirrors the image-gen gate).
    if not _user_can_execute_code(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to run code.",
        )
    if payload.language != "python":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only Python execution is supported right now.",
        )

    # Share the conversation's sandbox session when supplied and owned.
    session_id: str | None = None
    if payload.conversation_id is not None:
        conv = await db.get(Conversation, payload.conversation_id)
        if conv is not None and conv.user_id == user.id:
            session_id = str(conv.id)

    try:
        result = await run_python_in_sandbox(
            db,
            user=user,
            code=payload.code,
            input_files=None,
            session_id=session_id,
            persist_outputs=True,
        )
    except SandboxNotConfigured as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{e} Ask an admin to enable the sandbox service.",
        ) from e
    except SandboxError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(e),
        ) from e

    logger.info(
        "code_run user=%s exit=%s timed_out=%s outputs=%d",
        user.id, result.exit_code, result.timed_out, len(result.attachments),
    )

    return CodeRunResponse(
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
        stdout_truncated=result.stdout_truncated,
        stderr_truncated=result.stderr_truncated,
        timed_out=result.timed_out,
        outputs=[
            CodeRunOutputFile(
                id=f.id,
                filename=f.filename,
                mime_type=f.mime_type,
                size_bytes=f.size_bytes,
            )
            for f in result.attachments
        ],
    )
