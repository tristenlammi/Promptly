"""Cross-chat memory management API (Phase 6 + Phase 2 overhaul).

User-facing CRUD over the caller's own saved facts. Every endpoint is
owner-scoped via ``get_current_user``; a memory belonging to someone
else 404s (never 403s) so its existence isn't probeable.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.memory.constants import MAX_MEMORIES, MEMORY_CATEGORIES
from app.memory.models import UserMemory
from app.memory.schemas import MemoryCreate, MemoryResponse, MemoryUpdate
from app.memory.service import (
    _is_duplicate,
    _normalise,
    embed_memory_row,
    load_memories,
)

router = APIRouter()

_VALID_CATEGORIES = set(MEMORY_CATEGORIES)


async def _get_owned(
    memory_id: uuid.UUID, user: User, db: AsyncSession
) -> UserMemory:
    row = await db.get(UserMemory, memory_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Memory not found"
        )
    return row


@router.get("", response_model=list[MemoryResponse])
async def list_memories_endpoint(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[UserMemory]:
    return await load_memories(db, user.id)


@router.post("", response_model=MemoryResponse, status_code=status.HTTP_201_CREATED)
async def create_memory(
    payload: MemoryCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserMemory:
    content = payload.content.strip()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Memory text is required",
        )

    existing = await load_memories(db, user.id)
    if len(existing) >= MAX_MEMORIES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Memory is full ({MAX_MEMORIES} max). Delete a few before "
                "adding more."
            ),
        )
    if _is_duplicate(content, [_normalise(m.content) for m in existing]):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That's already in your memory.",
        )

    # Coerce invalid categories to None silently.
    category = payload.category if payload.category in _VALID_CATEGORIES else None

    row = UserMemory(
        user_id=user.id,
        content=content,
        source="manual",
        category=category,
        pinned=payload.pinned,
    )
    db.add(row)
    await db.flush()  # assign id before embedding
    await embed_memory_row(db, row)  # best-effort; no-op without embeddings
    await db.commit()
    await db.refresh(row)
    return row


@router.patch("/{memory_id}", response_model=MemoryResponse)
async def update_memory(
    memory_id: uuid.UUID,
    payload: MemoryUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserMemory:
    row = await _get_owned(memory_id, user, db)
    should_reembed = False

    if payload.content is not None:
        content = payload.content.strip()
        if not content:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Memory text is required",
            )
        row.content = content
        should_reembed = True

    if payload.category is not None:
        # Empty string → clear the category; invalid → None
        row.category = (
            payload.category if payload.category in _VALID_CATEGORIES else None
        )
    elif "category" in payload.model_fields_set and payload.category is None:
        # Explicit null clears the category
        row.category = None

    if payload.pinned is not None:
        row.pinned = payload.pinned

    # Re-embed only when the text changed (vectors must track the text).
    if should_reembed:
        await db.flush()
        await embed_memory_row(db, row)

    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_memory(
    memory_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    row = await _get_owned(memory_id, user, db)
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def clear_memories(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Wipe every saved fact for the caller (the 'forget everything'
    button in account settings)."""
    await db.execute(delete(UserMemory).where(UserMemory.user_id == user.id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
