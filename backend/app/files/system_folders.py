"""System-managed folders living inside each user's private file pool.

Every user gets these four folders the moment their account is created
(see ``seed_system_folders`` below, called from every user-provisioning
path) and existing accounts are backfilled by the
``0011_seed_system_folders`` migration. The ``ensure_*`` helpers are
still kept as a defensive safety net so any code path that asks for a
system folder gets one even if seeding was somehow skipped. They are
all protected from rename / delete / move so callers can assume the
rows are stable:

  My files/
  ├── Chat Uploads/        ← every file uploaded from a chat lands here
  └── Generated Files/     ← reserved for future "AI made this for you" flow
      ├── Files/           ← .txt, .md, .pdf, .csv, code, ...
      └── Media/           ← image/audio/video

Routing rules:

* Chat uploads → ``Chat Uploads`` (no per-conversation subfoldering;
  one flat bucket the user can manually re-organise later).
* Generated artefacts → ``Generated Files / Media`` if the MIME type
  starts with ``image/`` / ``audio/`` / ``video/``; otherwise
  ``Generated Files / Files``. PDFs go to **Files** (treated as a
  document, not media).
"""
from __future__ import annotations

from enum import Enum
from typing import Final

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files.models import FileFolder


class SystemKind(str, Enum):
    """Stable identifiers persisted in ``file_folders.system_kind``.

    Treat these strings as part of the schema: renaming a value would
    require a data migration.
    """

    CHAT_UPLOADS = "chat_uploads"
    GENERATED_ROOT = "generated_root"
    GENERATED_FILES = "generated_files"
    GENERATED_MEDIA = "generated_media"


DISPLAY_NAMES: Final[dict[SystemKind, str]] = {
    SystemKind.CHAT_UPLOADS: "Chat Uploads",
    SystemKind.GENERATED_ROOT: "Generated Files",
    SystemKind.GENERATED_FILES: "Files",
    SystemKind.GENERATED_MEDIA: "Media",
}

# A "media" mime is anything that's primarily a moving / sounding /
# pixel-y blob the user would expect to preview rather than read.
# PDFs are deliberately excluded — they're treated as documents and
# routed to the Files subfolder so the Media bucket stays focused.
_MEDIA_PREFIXES: Final[tuple[str, ...]] = ("image/", "audio/", "video/")


def is_media_mime(mime: str | None) -> bool:
    """Return True for image/audio/video MIME types (PDF is *not* media)."""
    if not mime:
        return False
    lowered = mime.lower()
    return any(lowered.startswith(p) for p in _MEDIA_PREFIXES)


# --------------------------------------------------------------------
# Lazy ensure helpers
# --------------------------------------------------------------------
async def _fetch(
    db: AsyncSession, user_id, kind: SystemKind
) -> FileFolder | None:
    return (
        await db.execute(
            select(FileFolder).where(
                FileFolder.user_id == user_id,
                FileFolder.system_kind == kind.value,
            )
        )
    ).scalar_one_or_none()


async def _ensure(
    db: AsyncSession,
    user_id,
    kind: SystemKind,
    *,
    parent_id=None,
) -> FileFolder:
    """Find-or-create the named system folder for ``user_id``.

    Concurrent first-time uploads can race here; the partial unique index
    on ``(user_id, system_kind)`` will reject the loser, which we catch
    inside a SAVEPOINT and resolve by re-fetching. Without the SAVEPOINT
    the surrounding transaction would be poisoned and every subsequent
    statement would fail.
    """
    existing = await _fetch(db, user_id, kind)
    if existing is not None:
        return existing
    try:
        async with db.begin_nested():
            folder = FileFolder(
                user_id=user_id,
                parent_id=parent_id,
                name=DISPLAY_NAMES[kind],
                system_kind=kind.value,
            )
            db.add(folder)
            await db.flush()
        return folder
    except IntegrityError:
        # Someone else created it between the SELECT and the INSERT.
        existing = await _fetch(db, user_id, kind)
        if existing is None:  # pragma: no cover — defensive
            raise
        return existing


async def ensure_chat_uploads(db: AsyncSession, user: User) -> FileFolder:
    return await _ensure(db, user.id, SystemKind.CHAT_UPLOADS)


async def ensure_generated_root(db: AsyncSession, user: User) -> FileFolder:
    return await _ensure(db, user.id, SystemKind.GENERATED_ROOT)


async def ensure_generated_files(db: AsyncSession, user: User) -> FileFolder:
    root = await ensure_generated_root(db, user)
    return await _ensure(
        db, user.id, SystemKind.GENERATED_FILES, parent_id=root.id
    )


async def ensure_generated_media(db: AsyncSession, user: User) -> FileFolder:
    root = await ensure_generated_root(db, user)
    return await _ensure(
        db, user.id, SystemKind.GENERATED_MEDIA, parent_id=root.id
    )


async def seed_system_folders(db: AsyncSession, user: User) -> None:
    """Materialise every system folder for ``user``.

    Called from every user-provisioning path (registration, admin
    create, bootstrap singleton) so the folders are visible from the
    very first time the user opens the Files page — no upload required
    to make them appear. Idempotent: safe to call against a user who
    already has any subset of the folders.

    Does *not* commit; the caller batches this with the surrounding
    transaction and decides when to flush.
    """
    await ensure_chat_uploads(db, user)
    # ensure_generated_files / _media each call ensure_generated_root,
    # which is idempotent — the second call short-circuits on the
    # SELECT and reuses the existing row.
    await ensure_generated_files(db, user)
    await ensure_generated_media(db, user)


# --------------------------------------------------------------------
# Routing
# --------------------------------------------------------------------
async def folder_for_chat_upload(
    db: AsyncSession, user: User
) -> FileFolder:
    """Folder a chat-uploaded file should land in by default."""
    return await ensure_chat_uploads(db, user)


async def folder_for_generated(
    db: AsyncSession, user: User, mime: str | None
) -> FileFolder:
    """Folder a future "AI generated this" file should land in."""
    if is_media_mime(mime):
        return await ensure_generated_media(db, user)
    return await ensure_generated_files(db, user)
