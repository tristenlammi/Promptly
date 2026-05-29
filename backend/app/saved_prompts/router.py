"""Saved-prompts CRUD — Phase 3.1.

Per-user reusable prompt templates, surfaced via ``/`` in the composer
and managed from the account page. Every endpoint is owner-scoped
through ``get_current_user``; a prompt belonging to another user 404s
rather than 403s so its existence isn't probeable.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.saved_prompts.models import SavedPrompt
from app.saved_prompts.schemas import (
    SavedPromptCreate,
    SavedPromptResponse,
    SavedPromptUpdate,
)

router = APIRouter()


async def _get_owned(
    prompt_id: uuid.UUID, user: User, db: AsyncSession
) -> SavedPrompt:
    row = await db.get(SavedPrompt, prompt_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Prompt not found"
        )
    return row


@router.get("", response_model=list[SavedPromptResponse])
async def list_prompts(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SavedPrompt]:
    rows = (
        (
            await db.execute(
                select(SavedPrompt)
                .where(SavedPrompt.user_id == user.id)
                .order_by(SavedPrompt.title.asc())
            )
        )
        .scalars()
        .all()
    )
    return list(rows)


@router.post(
    "",
    response_model=SavedPromptResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_prompt(
    payload: SavedPromptCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SavedPrompt:
    row = SavedPrompt(
        user_id=user.id,
        title=payload.title.strip(),
        body=payload.body,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.patch("/{prompt_id}", response_model=SavedPromptResponse)
async def update_prompt(
    prompt_id: uuid.UUID,
    payload: SavedPromptUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SavedPrompt:
    row = await _get_owned(prompt_id, user, db)
    if payload.title is not None:
        row.title = payload.title.strip()
    if payload.body is not None:
        row.body = payload.body
    await db.commit()
    await db.refresh(row)
    return row


@router.delete(
    "/{prompt_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_prompt(
    prompt_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    row = await _get_owned(prompt_id, user, db)
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
