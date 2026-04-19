"""Admin observability endpoints — live log tail + error groups.

Two surfaces:

* ``GET /admin/logs/stream`` — SSE that flushes the in-memory ring
  buffer for backfill, then streams every new log line emitted by
  the backend until the client disconnects. Backed by
  :class:`app.logging_setup.InMemoryRingHandler`.

* ``GET /admin/errors/...`` — paginated grouped view + per-event
  detail + resolve toggle, all reading the ``error_events`` table
  populated by :mod:`app.observability.capture`.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.schemas import (
    ErrorEventDetail,
    ErrorEventRow,
    ErrorGroupRow,
)
from app.auth.deps import require_admin
from app.auth.models import User
from app.database import get_db
from app.logging_setup import get_ring_handler
from app.observability.models import ErrorEvent

router = APIRouter()


# --------------------------------------------------------------------
# Live log tail (SSE)
# --------------------------------------------------------------------
async def _log_event_stream(level: str | None) -> AsyncIterator[bytes]:
    """SSE generator: backfill from the ring buffer, then live-tail.

    A bridge ``asyncio.Queue`` is fed by a sync subscriber; the SSE
    consumer awaits on the queue. We pin the *current* loop so the
    sync subscriber can hop back via ``call_soon_threadsafe`` even
    when log records originate on a thread-pool thread (e.g. inside
    a sync FastAPI dependency).
    """
    ring = get_ring_handler()
    if ring is None:
        # Ring buffer is opt-in via ``configure_logging(enable_ring=True)``;
        # surface a clear single event so the UI tells the operator
        # rather than just spinning empty forever.
        yield _sse({"warning": "log ring buffer disabled"})
        return

    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1000)
    loop = asyncio.get_running_loop()

    def _on_line(line: str) -> None:
        # Best-effort hop into the consumer's loop. Drop the line
        # rather than block if the queue is full — keeps a slow
        # client from back-pressuring the entire logger.
        try:
            loop.call_soon_threadsafe(_safe_put, queue, line)
        except RuntimeError:
            return

    unsubscribe = ring.subscribe(_on_line)
    try:
        # Backfill: ship the snapshot first so the operator opens the
        # console to "what just happened" instead of a blank screen.
        for line in ring.snapshot():
            if not _passes_level(line, level):
                continue
            yield _sse_raw(line)

        yield _sse({"hello": "tail-attached"})

        # Heartbeat every 15s so reverse proxies and the browser
        # both keep the connection open during quiet periods.
        while True:
            try:
                line = await asyncio.wait_for(queue.get(), timeout=15.0)
            except asyncio.TimeoutError:
                yield b": ping\n\n"
                continue
            if not _passes_level(line, level):
                continue
            yield _sse_raw(line)
    finally:
        unsubscribe()


def _safe_put(queue: asyncio.Queue[str], line: str) -> None:
    """Push ``line`` onto ``queue`` without ever raising."""
    try:
        queue.put_nowait(line)
    except asyncio.QueueFull:
        # Drop oldest by popping then pushing — better to lose one
        # line than to drop the freshest, which is what an operator
        # is most likely watching for.
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            return
        try:
            queue.put_nowait(line)
        except asyncio.QueueFull:
            pass


_LEVEL_ORDER = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}


def _passes_level(line: str, minimum: str | None) -> bool:
    """Server-side level filter so the SSE never ships rows the UI hides."""
    if not minimum:
        return True
    floor = _LEVEL_ORDER.get(minimum.upper(), 0)
    if floor <= 0:
        return True
    try:
        record = json.loads(line)
    except (TypeError, ValueError):
        return True
    rec_level = _LEVEL_ORDER.get(str(record.get("level", "")).upper(), 0)
    return rec_level >= floor


def _sse(payload: dict) -> bytes:
    return b"data: " + json.dumps(payload, default=str).encode("utf-8") + b"\n\n"


def _sse_raw(payload: str) -> bytes:
    return b"data: " + payload.encode("utf-8", errors="replace") + b"\n\n"


@router.get("/logs/stream")
async def stream_logs(
    level: str | None = Query(default=None, max_length=16),
    _: User = Depends(require_admin),
) -> StreamingResponse:
    """SSE feed of structured log lines for the admin Live Console."""
    return StreamingResponse(
        _log_event_stream(level),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# --------------------------------------------------------------------
# Errors — grouped + raw detail
# --------------------------------------------------------------------
@router.get("/errors/groups", response_model=list[ErrorGroupRow])
async def list_error_groups(
    status: str = Query(default="open", pattern="^(open|resolved|all)$"),
    q: str | None = Query(default=None, max_length=200),
    user_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[ErrorGroupRow]:
    """Group ``error_events`` by ``fingerprint`` for the issues view.

    ``status=open`` only surfaces fingerprints whose *latest* row is
    unresolved; ``status=resolved`` flips it; ``status=all`` ignores
    the toggle. Search is a case-insensitive ILIKE on the message —
    cheap because we only have ten-ish users.
    """
    # Latest row per fingerprint as a CTE-like subquery so we can
    # filter on its resolved_at without aggregating it away.
    latest_subq = (
        select(
            ErrorEvent.fingerprint.label("fp"),
            func.max(ErrorEvent.created_at).label("last_seen_at"),
        )
        .group_by(ErrorEvent.fingerprint)
        .subquery()
    )

    stmt = (
        select(
            ErrorEvent.fingerprint,
            func.max(ErrorEvent.level),
            func.max(ErrorEvent.logger),
            func.max(ErrorEvent.exception_class),
            func.max(ErrorEvent.message),
            func.count(ErrorEvent.id),
            func.max(ErrorEvent.created_at),
            func.min(ErrorEvent.created_at),
            func.bool_or(ErrorEvent.resolved_at.is_not(None)),
        )
        .group_by(ErrorEvent.fingerprint)
    )
    if user_id is not None:
        stmt = stmt.where(ErrorEvent.user_id == user_id)
    if q:
        stmt = stmt.where(ErrorEvent.message.ilike(f"%{q}%"))

    # Apply the resolved/open filter on the latest row.
    if status != "all":
        # Build a mapping fingerprint -> latest_resolved_at, then
        # filter. Easier than a window function and our cardinality
        # is tiny.
        latest_resolved = (
            select(
                ErrorEvent.fingerprint,
                ErrorEvent.resolved_at,
            )
            .join(
                latest_subq,
                (ErrorEvent.fingerprint == latest_subq.c.fp)
                & (ErrorEvent.created_at == latest_subq.c.last_seen_at),
            )
            .subquery()
        )
        if status == "open":
            stmt = stmt.where(
                ErrorEvent.fingerprint.in_(
                    select(latest_resolved.c.fingerprint).where(
                        latest_resolved.c.resolved_at.is_(None)
                    )
                )
            )
        else:
            stmt = stmt.where(
                ErrorEvent.fingerprint.in_(
                    select(latest_resolved.c.fingerprint).where(
                        latest_resolved.c.resolved_at.is_not(None)
                    )
                )
            )

    stmt = stmt.order_by(desc(func.max(ErrorEvent.created_at))).offset(offset).limit(limit)
    rows = (await db.execute(stmt)).all()

    return [
        ErrorGroupRow(
            fingerprint=str(r[0]),
            level=str(r[1] or "ERROR"),
            logger=str(r[2] or ""),
            exception_class=(str(r[3]) if r[3] else None),
            sample_message=str(r[4] or ""),
            occurrences=int(r[5] or 0),
            last_seen_at=r[6],
            first_seen_at=r[7],
            resolved=bool(r[8]),
        )
        for r in rows
    ]


@router.get(
    "/errors/groups/{fingerprint}/events",
    response_model=list[ErrorEventRow],
)
async def list_group_events(
    fingerprint: str,
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[ErrorEventRow]:
    """The most recent raw events for one fingerprint (drill-down)."""
    rows = (
        await db.execute(
            select(ErrorEvent)
            .where(ErrorEvent.fingerprint == fingerprint)
            .order_by(ErrorEvent.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [ErrorEventRow.model_validate(r) for r in rows]


@router.get("/errors/{event_id}", response_model=ErrorEventDetail)
async def get_error_event(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> ErrorEventDetail:
    row = await db.get(ErrorEvent, event_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Error event not found")
    return ErrorEventDetail.model_validate(row)


@router.post(
    "/errors/groups/{fingerprint}/resolve",
    response_model=int,
)
async def resolve_error_group(
    fingerprint: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> int:
    """Mark every event in the group as resolved by the calling admin.

    Returns the number of rows updated. Idempotent — re-resolving an
    already-resolved group is a no-op.
    """
    now = datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(ErrorEvent).where(
                (ErrorEvent.fingerprint == fingerprint)
                & (ErrorEvent.resolved_at.is_(None))
            )
        )
    ).scalars().all()
    for r in rows:
        r.resolved_at = now
        r.resolved_by_user_id = actor.id
    await db.commit()
    return len(rows)


@router.post(
    "/errors/groups/{fingerprint}/reopen",
    response_model=int,
)
async def reopen_error_group(
    fingerprint: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> int:
    rows = (
        await db.execute(
            select(ErrorEvent).where(
                (ErrorEvent.fingerprint == fingerprint)
                & (ErrorEvent.resolved_at.is_not(None))
            )
        )
    ).scalars().all()
    for r in rows:
        r.resolved_at = None
        r.resolved_by_user_id = None
    await db.commit()
    return len(rows)


__all__ = ["router"]
