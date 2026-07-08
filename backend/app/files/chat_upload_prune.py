"""Orphan pruning for the per-user *Chat Uploads* system folder (D4).

Every file a user attaches in chat lands in their flat ``Chat Uploads``
folder (see :mod:`app.files.system_folders`). Nothing used to remove
those rows, so deleting a conversation left its uploads behind forever —
a slow storage leak, and the source of the duplicate résumés cluttering
the ``@``-mention picker.

A Chat Uploads file is *referenced* while its id appears in some live
``messages.attachments`` snapshot. ``resolve_attachments`` only lets a
user attach files they own, so a given user's upload can only ever be
referenced by that same user's messages — which makes the "is anything
still pointing at this?" check a single scan of the owner's messages.

Pruning is a **soft delete** (``trashed_at``): the files drop out of
Chat Uploads, Drive listings, and the ``@`` picker immediately but land
in Trash, so an accidental sweep is fully recoverable and normal trash
retention reclaims the blobs. We never touch files the user filed into
their own folders — only rows still sitting in the Chat Uploads bucket.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.models import Message
from app.files.models import FileFolder, UserFile
from app.files.system_folders import SystemKind

logger = logging.getLogger(__name__)


async def _referenced_file_ids(db: AsyncSession, user_id: uuid.UUID) -> set[str]:
    """Set of file-id strings still referenced by the user's messages.

    Attachment snapshots store the file id under ``"id"`` (see
    ``attachment_snapshot``). We only scan rows the user authored,
    because that's the only place their own uploads can be referenced.
    """
    referenced: set[str] = set()
    rows = await db.execute(
        select(Message.attachments).where(
            Message.author_user_id == user_id,
            Message.attachments.is_not(None),
        )
    )
    for (atts,) in rows:
        if not atts:
            continue
        for a in atts:
            fid = a.get("id") if isinstance(a, dict) else None
            if fid:
                referenced.add(str(fid))
    return referenced


async def prune_orphaned_chat_uploads(
    db: AsyncSession, user_id: uuid.UUID
) -> int:
    """Trash Chat Uploads files no live message references anymore.

    Commits its own transaction. Returns the number of files trashed.
    A no-op (returns 0) when the user has no Chat Uploads folder or
    every upload is still referenced.
    """
    folder = (
        await db.execute(
            select(FileFolder).where(
                FileFolder.user_id == user_id,
                FileFolder.system_kind == SystemKind.CHAT_UPLOADS.value,
            )
        )
    ).scalar_one_or_none()
    if folder is None:
        return 0

    candidate_ids = (
        (
            await db.execute(
                select(UserFile.id).where(
                    UserFile.folder_id == folder.id,
                    UserFile.user_id == user_id,
                    UserFile.trashed_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    if not candidate_ids:
        return 0

    referenced = await _referenced_file_ids(db, user_id)
    orphan_ids = [fid for fid in candidate_ids if str(fid) not in referenced]
    if not orphan_ids:
        return 0

    now = datetime.now(timezone.utc)
    await db.execute(
        update(UserFile)
        .where(UserFile.id.in_(orphan_ids))
        .values(trashed_at=now)
    )
    await db.commit()
    logger.info(
        "chat-uploads prune trashed %d orphan file(s) for user %s",
        len(orphan_ids),
        user_id,
    )
    return len(orphan_ids)
