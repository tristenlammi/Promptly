"""Talk's speed numbers for Admin -> Talk, and keeping them short-lived (WP-T6).

``talk_metrics`` holds timings only (``models.py``): no words, no audio,
nothing that says what was talked about. The summary reads only timing
columns and the device, so what an admin sees can't carry words either.
Rows older than :data:`KEEP_DAYS` are deleted every night
(``prune_talk_metrics`` in ``tasks/worker.py``).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import TalkMetric

logger = logging.getLogger("promptly.talk")

KEEP_DAYS = 30
DEVICES = ("web", "android", "car")

# What the admin screen shows, in the order a turn goes through them:
# key -> column. Each is a time in milliseconds.
TIMINGS: dict[str, Any] = {
    "end_of_turn": TalkMetric.endpoint_ms,  # last word -> it decided you'd finished
    "transcript": TalkMetric.stt_ms,  # last word -> the final transcript in hand
    "model": TalkMetric.ttft_ms,  # the model asked -> its first words
    "first_audio": TalkMetric.first_audio_ms,  # last word -> the first sound back
    "barge_in": TalkMetric.barge_in_ms,  # heard you talk over it -> it went quiet
}


def _stats(row: Any, key: str) -> dict[str, int | None]:
    median, p90, n = getattr(row, f"{key}_p50"), getattr(row, f"{key}_p90"), getattr(row, f"{key}_n")
    return {
        "median_ms": None if median is None else int(round(median)),
        "p90_ms": None if p90 is None else int(round(p90)),
        "count": int(n or 0),
    }


def _columns() -> list[Any]:
    cols: list[Any] = [
        func.count(TalkMetric.id).label("turns"),
        func.count(func.distinct(TalkMetric.session_id)).label("conversations"),
        func.count(func.distinct(TalkMetric.user_id)).label("people"),
        func.coalesce(func.sum(TalkMetric.barge_ins), 0).label("barge_ins"),
        func.count(TalkMetric.id).filter(TalkMetric.fast_path.is_(True)).label("fast_path"),
    ]
    for key, col in TIMINGS.items():
        cols += [
            func.percentile_cont(0.5).within_group(col.asc()).label(f"{key}_p50"),
            func.percentile_cont(0.9).within_group(col.asc()).label(f"{key}_p90"),
            func.count(col).label(f"{key}_n"),
        ]
    return cols


def _block(row: Any) -> dict[str, Any]:
    return {
        "turns": int(row.turns or 0),
        "conversations": int(row.conversations or 0),
        "people": int(row.people or 0),
        "barge_ins": int(row.barge_ins or 0),
        "fast_path": int(row.fast_path or 0),
        "timings": {key: _stats(row, key) for key in TIMINGS},
    }


async def summary(db: AsyncSession, *, days: int = 7) -> dict[str, Any]:
    """Medians and the slow end (90th percentile) of each step, over the last
    ``days``, for everything and per device. Numbers and device names only."""
    days = max(1, min(int(days), KEEP_DAYS))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    where = TalkMetric.created_at >= since
    overall = (await db.execute(select(*_columns()).where(where))).one()
    per_device = (
        await db.execute(select(TalkMetric.device, *_columns()).where(where).group_by(TalkMetric.device))
    ).all()
    devices = sorted(
        ({"device": row.device, **_block(row)} for row in per_device if row.device in DEVICES),
        key=lambda d: DEVICES.index(d["device"]),
    )
    return {"days": days, "keep_days": KEEP_DAYS, "all": _block(overall), "devices": devices}


async def prune(db: AsyncSession, *, keep_days: int = KEEP_DAYS) -> int:
    """Delete timings older than ``keep_days``. Commits; returns how many went."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
    result = await db.execute(delete(TalkMetric).where(TalkMetric.created_at < cutoff))
    await db.commit()
    return int(result.rowcount or 0)


async def prune_talk_metrics() -> int:
    """The nightly job: Talk's timings are kept for :data:`KEEP_DAYS` days."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        gone = await prune(db)
    if gone:
        logger.info("talk: pruned %d timing rows older than %d days", gone, KEEP_DAYS)
    return gone
