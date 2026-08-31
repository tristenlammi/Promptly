"""Cross-chat memory management API (Phase 6 + Phase 2/3 overhaul).

User-facing CRUD over the caller's own saved facts. Every endpoint is
owner-scoped via ``get_current_user``; a memory belonging to someone
else 404s (never 403s) so its existence isn't probeable.
"""
from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.memory.constants import (
    MAX_MEMORIES,
    MAX_PINNED_MEMORIES,
    MEMORY_CATEGORIES,
)
from app.memory.models import UserMemory
from app.memory.schemas import MemoryCreate, MemoryResponse, MemoryUpdate
from app.memory.service import (
    _is_duplicate,
    _normalise,
    apply_memory_edits,
    consolidate_memories,
    embed_memory_row,
    load_memories,
    plan_memory_edits,
)

logger = logging.getLogger("promptly.memory")

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



async def _guard_pin_cap(user: User, db: AsyncSession, exclude_id=None) -> None:
    """Refuse to pin past the cap.

    Pinned facts are injected into every turn unconditionally, competing
    with retrieval for the same slots — so an uncapped pin list quietly
    turns relevance off and inflates the prompt. The UI calls pinning
    "always keep this in mind", which reads as free, so the limit has to
    be enforced here rather than left to the user to infer.
    """
    stmt = select(func.count()).select_from(UserMemory).where(
        UserMemory.user_id == user.id, UserMemory.pinned.is_(True)
    )
    if exclude_id is not None:
        stmt = stmt.where(UserMemory.id != exclude_id)
    if int(await db.scalar(stmt) or 0) >= MAX_PINNED_MEMORIES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"You can pin up to {MAX_PINNED_MEMORIES} memories. Unpin "
                "one to make room — pinned facts are added to every chat, "
                "so a long list crowds out the ones picked for relevance."
            ),
        )


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
    # Exact-match dedupe only (normalised). The substring-containment rule
    # used for auto-capture is too aggressive for deliberate manual adds —
    # it 409'd legitimate refinements like extending "User likes Python"
    # to "User likes Python and Rust".
    key = _normalise(content)
    if any(key == _normalise(m.content) for m in existing):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That's already in your memory.",
        )

    if payload.pinned:
        await _guard_pin_cap(user, db)

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
        if payload.pinned and not row.pinned:
            await _guard_pin_cap(user, db, exclude_id=row.id)
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
# Consolidation (Memory follow-ups)
# ──────────────────────────────────────────────────────────────────────────

class MemoryConsolidateChange(BaseModel):
    kept_id: str
    text: str
    merged: list[str]


class MemoryConsolidateResponse(BaseModel):
    merged_groups: int
    removed: int
    changes: list[MemoryConsolidateChange]


@router.post("/consolidate", response_model=MemoryConsolidateResponse)
async def consolidate(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MemoryConsolidateResponse:
    """Tidy the caller's memory store: one model pass proposes groups of
    near-duplicate facts, which are merged conservatively (merge-only —
    nothing is deleted except rows absorbed into a merge). User-triggered
    from the Memory panel, so failures surface as errors rather than being
    swallowed like the capture path."""
    try:
        result = await consolidate_memories(db, user_id=user.id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        )
    except Exception:
        logger.exception("Memory consolidation failed user=%s", user.id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "Consolidation didn't complete — the model call failed. "
                "Nothing was changed; try again in a moment."
            ),
        )
    await db.commit()
    return MemoryConsolidateResponse(**result)


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


class MemoryInstructRequest(BaseModel):
    instruction: str


class MemoryEditOp(BaseModel):
    """One proposed change, in the shape the preview renders.

    ``before`` is the row's current text (updates and deletes); ``after``
    is the proposed text (adds and updates). Ids are echoed back on apply
    and re-validated server-side — the plan travels through the client, so
    it is a suggestion, never an authority.
    """

    op: str
    id: str | None = None
    before: str | None = None
    after: str | None = None
    category: str | None = None


class MemoryInstructPlan(BaseModel):
    changes: list[MemoryEditOp]


class MemoryApplyRequest(BaseModel):
    ops: list[MemoryEditOp]


class MemoryApplyResult(BaseModel):
    added: int
    updated: int
    deleted: int


@router.post("/instruct", response_model=MemoryInstructPlan)
async def instruct_memory(
    payload: MemoryInstructRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MemoryInstructPlan:
    """Work out what a plain-English instruction would change.

    Nothing is written — the caller shows the plan and calls
    ``/instruct/apply`` if the user accepts. Editing durable state in bulk
    from an ambiguous sentence ("forget the work stuff") is exactly where
    a preview earns its keep.
    """
    try:
        changes = await plan_memory_edits(
            db, user_id=user.id, instruction=payload.instruction
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    return MemoryInstructPlan(
        changes=[MemoryEditOp(**c) for c in changes]
    )


@router.post("/instruct/apply", response_model=MemoryApplyResult)
async def apply_memory_instruction(
    payload: MemoryApplyRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MemoryApplyResult:
    """Apply a plan the user accepted.

    Ops are re-validated against this user's own rows; an id that isn't
    theirs is skipped rather than rejected, so a partially-stale plan
    (they deleted a row in another tab) still applies what it can.
    """
    result = await apply_memory_edits(
        db, user_id=user.id, ops=[op.model_dump() for op in payload.ops]
    )
    await db.commit()
    return MemoryApplyResult(**result)
