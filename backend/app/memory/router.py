"""Cross-chat memory management API (Phase 6 + Phase 2/3 overhaul).

User-facing CRUD over the caller's own saved facts. Every endpoint is
owner-scoped via ``get_current_user``; a memory belonging to someone
else 404s (never 403s) so its existence isn't probeable.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.memory.constants import (
    MAX_CONTENT_CHARS,
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
    ``pinned``, ``source``, ``times_used``, ``last_used_at``,
    ``created_at``, and ``updated_at``. ``id`` and
    ``source_conversation_id`` are intentionally omitted — they reference
    internal DB state that won't be valid after an import to a different
    instance. Everything else round-trips through ``/import`` (R-329).
    """
    memories = await load_memories(db, user.id)
    payload = [
        {
            "content": m.content,
            "category": m.category,
            "pinned": m.pinned,
            "source": m.source,
            "times_used": m.times_used,
            "last_used_at": m.last_used_at.isoformat() if m.last_used_at else None,
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
    # Existing facts replaced by a richer imported version of themselves.
    updated: int = 0
    skipped: int
    errors: int


# The values ``UserMemory.source`` takes (no DB CHECK — the model comment
# and every writer agree on these two). ``manual`` renders as "stated" in
# the prompt and is never evicted; ``auto`` is "inferred". An import keeps
# whichever the export recorded, so an inferred fact doesn't come back
# with the authority of something the user typed.
_IMPORT_SOURCES = frozenset({"auto", "manual"})
# A restored usage counter feeds the retrieval re-rank and eviction order.
# Clamped so a hand-edited file can't make one fact permanently dominant.
_MAX_IMPORTED_TIMES_USED = 1000
# Generous for the 200-fact cap (a full export with metadata is ~200 KB);
# just stops someone posting a novel into the parser.
_MAX_IMPORT_BYTES = 2_000_000
# Clock-skew allowance before an imported timestamp counts as "future".
_IMPORT_FUTURE_SLACK = timedelta(minutes=5)
_IMPORT_MIN_YEAR = 2000

# Plain-text import: one fact per line. Leading list markers are noise
# from wherever the facts were copied (another assistant's memory page,
# a markdown note). Bullets need trailing whitespace so "*emphasis*" and
# "-5 degrees" aren't mangled; numbering needs it so "1.5 kg" survives.
_LIST_MARKER_RE = re.compile(
    r"^(?:[-*+]\s+|[•·◦▪‣●]\s*|\d{1,3}[.)]\s+|\[[ xX]\]\s+)"
)
# Structural markdown lines that are never facts.
_NON_FACT_LINE_RE = re.compile(r"^(?:#{1,6}(?:\s|$)|```|~~~|[-*_]{3,}$)")


def _facts_from_text(text: str) -> list[dict]:
    """Split pasted / uploaded plain text into import items, one per line."""
    out: list[dict] = []
    for line in text.lstrip("﻿").splitlines():
        s = line.strip()
        if not s or _NON_FACT_LINE_RE.match(s):
            continue
        # Twice covers "- [ ] fact" and "1. - fact"; more is a pathological
        # input, not a list.
        for _ in range(2):
            stripped = _LIST_MARKER_RE.sub("", s, count=1).strip()
            if stripped == s:
                break
            s = stripped
        if s:
            out.append({"content": s})
    return out


def _parse_import_ts(value, now: datetime) -> datetime | None:
    """ISO-8601 → aware datetime, or ``None`` for anything implausible.

    Garbage, future dates and pre-2000 dates are dropped rather than
    rejected: a bad timestamp shouldn't cost the user the fact, it just
    falls back to "learned now".
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    if dt > now + _IMPORT_FUTURE_SLACK or dt.year < _IMPORT_MIN_YEAR:
        return None
    return dt


def _coerce_times_used(value) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        try:
            n = int(value)
        except (ValueError, OverflowError):  # NaN / inf
            return 0
    elif isinstance(value, str) and value.strip().isdigit():
        n = int(value.strip())
    else:
        return 0
    return max(0, min(n, _MAX_IMPORTED_TIMES_USED))


async def _read_import_items(request: Request) -> list:
    """Normalise the accepted body shapes into a list of items.

    * ``application/json`` array — a Promptly export (or any list of
      ``{"content": ...}`` objects / bare strings).
    * ``application/json`` object ``{"text": "..."}`` — pasted facts,
      one per line (``{"memories": [...]}`` is also accepted).
    * ``text/plain`` / ``text/markdown`` body — an uploaded .txt / .md,
      one fact per line.
    """
    raw = await request.body()
    if len(raw) > _MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Import is too large.",
        )
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype.startswith("text/"):
        return _facts_from_text(raw.decode("utf-8", errors="replace"))

    try:
        body = json.loads(raw)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "Request body must be a JSON array of memories, "
                '{"text": "..."}, or plain text with one fact per line.'
            ),
        )
    if isinstance(body, dict) and isinstance(body.get("text"), str):
        return _facts_from_text(body["text"])
    if isinstance(body, dict) and isinstance(body.get("memories"), list):
        return body["memories"]
    if isinstance(body, list):
        return body
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail='Expected a JSON array at the top level, or {"text": "..."}.',
    )


@router.post("/import", response_model=MemoryImportResponse)
async def import_memories(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MemoryImportResponse:
    """Merge memories into the caller's store.

    Accepts a Promptly export (JSON array), pasted facts as
    ``{"text": "..."}``, or a ``text/plain`` body with one fact per line —
    see ``_read_import_items``. Export metadata (source, times_used,
    last_used_at, created_at, updated_at) is restored when present and
    plausible, so a round trip doesn't reset usage re-rank, staleness, or
    the stated/inferred label (R-329).

    Dedupe uses the shared substring rule with one import-only twist: an
    imported fact that strictly *contains* an existing one is the richer
    version, so it replaces that row's text ("updated") instead of being
    dropped. One contained by (or equal to) an existing fact is skipped.
    Items past the per-user cap are skipped; malformed items are errors.
    """
    items = await _read_import_items(request)

    existing = await load_memories(db, user.id)
    # (normalised key, row, created-by-this-import)
    entries: list[tuple[str, UserMemory, bool]] = [
        (_normalise(m.content), m, False) for m in existing
    ]
    total = len(existing)
    pinned_count = sum(1 for m in existing if m.pinned)
    now = datetime.now(timezone.utc)
    enriched: set[uuid.UUID] = set()

    imported = updated = skipped = errors = 0

    for item in items:
        if isinstance(item, str):
            item = {"content": item}
        if not isinstance(item, dict):
            errors += 1
            continue
        raw_content = item.get("content")
        content = raw_content.strip() if isinstance(raw_content, str) else ""
        if not content or len(content) > MAX_CONTENT_CHARS:
            errors += 1
            continue

        raw_cat = item.get("category")
        raw_cat = raw_cat.strip().lower() if isinstance(raw_cat, str) else ""
        category = raw_cat if raw_cat in _VALID_CATEGORIES else None

        key = _normalise(content)
        if _is_duplicate(content, [k for k, _, _ in entries]):
            if not key or any(k and (key == k or key in k) for k, _, _ in entries):
                # Equal to, or contained by, something already held.
                skipped += 1
                continue
            # Strictly richer than an existing fact: enrich it in place.
            idx = next(i for i, (k, _, _) in enumerate(entries) if k and k in key)
            _, row, is_new = entries[idx]
            row.content = content
            if row.category is None and category:
                row.category = category
            entries[idx] = (key, row, is_new)
            if is_new or row.id in enriched:
                # Merged into a row this import already counted (as
                # imported, or as updated).
                skipped += 1
            else:
                # Text changed → the stored vector no longer matches.
                # Clearing the bookkeeping drops it from similarity search
                # (which filters on embed_model) until the re-embed below.
                row.embed_dim = None
                row.embed_model = None
                row.content_hash = None
                enriched.add(row.id)
                updated += 1
            continue

        if total >= MAX_MEMORIES:
            skipped += 1
            continue

        raw_source = item.get("source")
        source = raw_source if raw_source in _IMPORT_SOURCES else "manual"

        # Pinning is capped (see _guard_pin_cap); past it, import unpinned
        # rather than refuse the fact.
        pinned = item.get("pinned") is True and pinned_count < MAX_PINNED_MEMORIES
        if pinned:
            pinned_count += 1

        created_at = _parse_import_ts(item.get("created_at"), now)
        updated_at = _parse_import_ts(item.get("updated_at"), now)
        if created_at and updated_at and updated_at < created_at:
            updated_at = created_at
        created_at = created_at or updated_at
        updated_at = updated_at or created_at
        last_used_at = _parse_import_ts(item.get("last_used_at"), now)

        kwargs: dict = {
            "user_id": user.id,
            "content": content,
            "source": source,
            "category": category,
            "pinned": pinned,
            "times_used": _coerce_times_used(item.get("times_used")),
            "last_used_at": last_used_at,
        }
        # Omit rather than pass None, so the server default (now) applies.
        if created_at:
            kwargs["created_at"] = created_at
            kwargs["updated_at"] = updated_at
        row = UserMemory(**kwargs)
        db.add(row)
        entries.append((key, row, True))
        total += 1
        imported += 1

    if imported or updated:
        await db.commit()
        # Best-effort embed the new and enriched rows.
        try:
            from app.chat.semantic_search import get_embedding_config  # noqa: PLC0415
            cfg = await get_embedding_config(db)
            if cfg:
                # Re-embed everything currently un-embedded for this user.
                fresh = await load_memories(db, user.id)
                for m in fresh:
                    if m.embed_dim != cfg.dim or m.embed_model != cfg.model_id:
                        await embed_memory_row(db, m, cfg)
                await db.commit()
        except Exception:  # noqa: BLE001
            pass

    return MemoryImportResponse(
        imported=imported, updated=updated, skipped=skipped, errors=errors
    )


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
    except Exception as exc:
        # A provider failure surfaced as a bare 500 (R-289).
        logger.exception("Memory instruct failed user=%s", user.id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "The AI couldn't work that out — the model call failed. "
                "Nothing was changed; try again in a moment."
            ),
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
