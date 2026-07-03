"""Scheduled hard-purge of soft-deleted users and organizations.

The Clerk deletion webhooks MARK a row (``deleted_at``) rather than destroying
it, so a deletion is recoverable during ``DELETION_GRACE_DAYS``. This module
performs the eventual, irreversible erasure — run daily by the Arq worker
(:func:`run_purge`), and on demand by the operator's "purge now" endpoints
(:func:`purge_user` / :func:`purge_org` directly, bypassing the grace check).

DB-level ``ON DELETE CASCADE`` does almost all the work: deleting a ``User``
row cascades to their conversations, messages, file rows, workspaces, study
data, tasks, custom models, knowledge/vector chunks, providers, MFA, push,
usage rollups, etc. The ONE thing that does not cascade is the file BYTES on
disk — those are removed explicitly here. Deleting an ``Organization`` row
cascades its config (providers + encrypted keys, custom models, groups,
connectors, model defaults); its members are detached (``org_id`` SET NULL),
never purged — they're separate accounts that keep their own content.
"""
from __future__ import annotations

import logging
import shutil
import uuid
from datetime import datetime, timedelta, timezone

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import Organization, User
from app.config import get_settings
from app.database import SessionLocal
from app.files.models import UserFile
from app.files.storage import absolute_path

logger = logging.getLogger("promptly.deletion")


def grace_cutoff() -> datetime:
    """Rows soft-deleted at or before this instant are eligible for purge."""
    days = max(int(get_settings().DELETION_GRACE_DAYS or 0), 0)
    return datetime.now(timezone.utc) - timedelta(days=days)


def _protected(user: User) -> bool:
    """Never purge the platform operator / any admin account — a hard backstop
    so a bug (or a stray ``deleted_at``) can never erase the owner, even via the
    operator's own "purge now"."""
    return user.role == "admin" or user.is_platform_admin


async def _remove_user_blobs(user_id: uuid.UUID) -> None:
    """Delete every uploaded byte for a user. All of a user's blobs live under
    the ``u_<id>`` bucket (see ``storage.storage_path_for``), so a single
    ``rmtree`` is complete and safe — ``absolute_path`` refuses any path outside
    the upload root. Runs off-loop because it's blocking disk I/O."""
    try:
        bucket = absolute_path(f"u_{user_id}")
    except ValueError:
        return
    await run_in_threadpool(shutil.rmtree, str(bucket), ignore_errors=True)


async def purge_user(db: AsyncSession, user: User) -> bool:
    """Irreversibly hard-delete a user + all their content. Returns ``True`` if
    purged, ``False`` if refused (protected account). Caller commits are handled
    here. Blobs are removed AFTER the DB commit so the two views can't diverge
    if the process dies mid-way (a leftover blob is harmless; a leftover row
    pointing at a deleted blob is not)."""
    if _protected(user):
        logger.warning(
            "refusing to purge protected account %s (%s)", user.id, user.email
        )
        return False
    uid = user.id
    email = user.email
    file_count = (
        await db.execute(
            select(func.count(UserFile.id)).where(UserFile.user_id == uid)
        )
    ).scalar_one()
    await db.delete(user)  # cascades every DB-side belonging
    await db.commit()
    await _remove_user_blobs(uid)  # bytes on disk don't cascade
    logger.info("purged user %s (%s): %d files", uid, email, file_count)
    return True


async def purge_org(db: AsyncSession, org: Organization) -> bool:
    """Irreversibly hard-delete an organization + its config (cascade). Members
    are detached (``org_id`` SET NULL), not purged. No disk blobs are org-owned,
    so there's nothing to clean off disk here."""
    oid = org.id
    name = org.name
    await db.delete(org)
    await db.commit()
    logger.info("purged organization %s (%s)", oid, name)
    return True


async def run_purge() -> dict[str, int]:
    """Daily entrypoint: purge everything past its grace window. One bad row
    never stops the run — each purge is isolated and failures are logged."""
    cutoff = grace_cutoff()
    purged_users = 0
    purged_orgs = 0
    async with SessionLocal() as db:
        users = (
            await db.execute(
                select(User).where(
                    User.deleted_at.is_not(None), User.deleted_at <= cutoff
                )
            )
        ).scalars().all()
        for u in users:
            try:
                if await purge_user(db, u):
                    purged_users += 1
            except Exception:  # noqa: BLE001 - isolate one bad purge
                await db.rollback()
                logger.exception("failed to purge user %s", u.id)

        orgs = (
            await db.execute(
                select(Organization).where(
                    Organization.deleted_at.is_not(None),
                    Organization.deleted_at <= cutoff,
                )
            )
        ).scalars().all()
        for o in orgs:
            try:
                if await purge_org(db, o):
                    purged_orgs += 1
            except Exception:  # noqa: BLE001
                await db.rollback()
                logger.exception("failed to purge organization %s", o.id)

    if purged_users or purged_orgs:
        logger.info(
            "purge run complete: %d users, %d orgs", purged_users, purged_orgs
        )
    return {"users": purged_users, "orgs": purged_orgs}


__all__ = ["grace_cutoff", "purge_org", "purge_user", "run_purge"]
