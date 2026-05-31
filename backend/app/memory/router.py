"""Cross-chat memory management API (Phase 6 + Phase 2/3 overhaul).

User-facing CRUD over the caller's own saved facts. Every endpoint is
owner-scoped via ``get_current_user``; a memory belonging to someone
else 404s (never 403s) so its existence isn't probeable.
"""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
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


# ──────────────────────────────────────────────────────────────────────────
# Phase 3.5 — Export / Import
# ──────────────────────────────────────────────────────────────────────────

@router.get("/export")
async def export_memories(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Download all memories as a JSON file.

    The export schema is stable: each entry has ``content``, ``category``,
    ``pinned``, ``source``, ``created_at``, and ``updated_at``.
    ``id`` and ``source_conversation_id`` are intentionally omitted —
    they reference internal DB state that won't be valid after an import
    to a different instance.
    """
    memories = await load_memories(db, user.id)
    payload = [
        {
            "content": m.content,
            "category": m.category,
            "pinned": m.pinned,
            "source": m.source,
            "times_used": m.times_used,
            "created_at": m.created_at.isoformat() if m.created_at else None,
            "updated_at": m.updated_at.isoformat() if m.updated_at else None,
        }
        for m in memories
    ]
    body = json.dumps(payload, indent=2, ensure_ascii=False)
    return StreamingResponse(
        iter([body]),
        media_type="application/json",
        headers={
            "Content-Disposition": 'attachment; filename="promptly-memories.json"'
        },
    )


class MemoryImportResponse(BaseModel):
    imported: int
    skipped: int
    errors: int


@router.post("/import", response_model=MemoryImportResponse)
async def import_memories(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MemoryImportResponse:
    """Merge an exported memory JSON file into the caller's memory store.

    Accepts a JSON array of objects with at minimum a ``content`` field.
    Duplicate content (substring match) and items exceeding the per-user
    cap are silently skipped. Malformed items count as errors.
    Returns a summary of the operation.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Request body must be a JSON array.",
        )
    if not isinstance(body, list):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Expected a JSON array at the top level.",
        )

    existing = await load_memories(db, user.id)
    existing_keys = [_normalise(m.content) for m in existing]
    total = len(existing)

    imported = skipped = errors = 0

    for item in body:
        if not isinstance(item, dict):
            errors += 1
            continue
        content = (item.get("content") or "").strip()
        if not content or len(content) > 600:
            errors += 1
            continue
        if total >= MAX_MEMORIES:
            skipped += 1
            continue
        if _is_duplicate(content, existing_keys):
            skipped += 1
            continue

        raw_cat = (item.get("category") or "").strip().lower()
        category = raw_cat if raw_cat in _VALID_CATEGORIES else None
        pinned = bool(item.get("pinned", False))
        source = "manual"  # imports are always treated as manual

        row = UserMemory(
            user_id=user.id,
            content=content,
            source=source,
            category=category,
            pinned=pinned,
        )
        db.add(row)
        existing_keys.append(_normalise(content))
        total += 1
        imported += 1

    if imported:
        await db.commit()
        # Best-effort embed the newly imported rows.
        try:
            from app.chat.semantic_search import get_embedding_config  # noqa: PLC0415
            cfg = await get_embedding_config(db)
            if cfg:
                # Re-embed everything currently un-embedded for this user.
                fresh = await load_memories(db, user.id)
                for m in fresh:
                    if m.embed_dim is None:
                        await embed_memory_row(db, m, cfg)
                await db.commit()
        except Exception:  # noqa: BLE001
            pass

    return MemoryImportResponse(imported=imported, skipped=skipped, errors=errors)
