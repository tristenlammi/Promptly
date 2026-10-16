"""Recent: who opened or edited which file (WP-3.4, Part C §3.5).

The backend records "opened" when an office file's editor page loads and
"edited" on saves it handles (a sheet save, a whiteboard's text push); the
collab server records "edited" for live Yjs edits in the same transaction
as the store (collab/src/server.js).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import FileActivity

logger = logging.getLogger("promptly.files.activity")


async def record_activity(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    file_id: uuid.UUID | None,
    kind: Literal["opened", "edited"],
) -> None:
    """Upsert the latest time; doesn't commit. Best-effort — a failure is
    logged inside a savepoint and never fails the caller's request."""
    if file_id is None:
        return
    now = datetime.now(timezone.utc)
    stmt = (
        insert(FileActivity)
        .values(user_id=user_id, file_id=file_id, kind=kind, at=now)
        .on_conflict_do_update(
            index_elements=["user_id", "file_id", "kind"], set_={"at": now}
        )
    )
    try:
        async with db.begin_nested():
            await db.execute(stmt)
    except Exception:  # noqa: BLE001
        logger.warning("file activity not recorded", exc_info=True)


__all__ = ["record_activity"]
