"""Lazy-seed the Email Attachments system folder for a user.

Called when a user connects their first email account, not at registration,
so users without email integration never see the folder.
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.files.system_folders import ensure_email_attachments


async def ensure_email_attachments_for_user(
    db: AsyncSession, user_id: uuid.UUID
) -> None:
    """Ensure the Email Attachments system folder exists for user_id.

    Uses the same ensure_* pattern as the other system folders — idempotent,
    race-safe via SAVEPOINT, no-op if already seeded.
    """
    # Build a minimal duck-typed user object so we can reuse _ensure directly.
    class _UserStub:
        id = user_id

    await ensure_email_attachments(db, _UserStub())  # type: ignore[arg-type]
