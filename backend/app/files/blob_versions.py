"""Versions of uploaded files (WP-8.1, Part C §5.8).

A file's bytes are immutable on disk: new content is written to a new path
and the row moves to it, so a *version* is simply the path it had before
(``file_versions.storage_path``, ``kind='blob'`` — or ``'pdf'`` for a PDF,
whose history can compare text page by page, WP-6.5).

Everything that changes an uploaded file's content goes through
:func:`replace_bytes`:

* an upload with a name already in the folder, when the user picks
  "Replace (keep the old one as a version)" — the same file, same id, so
  its shares, star, comments and links stay;
* an AI document re-rendered after its source was edited, and the source
  itself (they used to be overwritten in place);
* a WebDAV PUT (WP-8.4).

Restoring a version (:func:`restore_bytes`) moves the file back to that
version's bytes, keeping what it replaces as a version first.

Retention (:func:`prune_blob_versions`, part of the nightly prune): every
version is kept for 30 days; after that a file keeps at most its 100 newest.
Named and keep-forever versions always stay. A pruned version's bytes go
through the normal 14-day deletion unless something still uses them.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import FileVersion, UserFile

logger = logging.getLogger("promptly.files.blob_versions")

KINDS = ("pdf", "blob")
KEEP_DAYS = 30
KEEP_MAX = 100
# Uploads, and the AI-authored Markdown source + its rendered PDF. Office
# files (Y.Doc versions), document assets and the like are not versioned
# this way.
_VERSIONED_SOURCE_KINDS = (None, "markdown_source", "rendered_pdf")


class VersionError(Exception):
    pass


def blob_kind(row: UserFile) -> str | None:
    """``'pdf'`` / ``'blob'`` if ``row``'s content is versioned as bytes."""
    from app.files.office import is_shell
    from app.files.pdf_edit import is_editable_pdf

    if not row.storage_path or row.source_kind not in _VERSIONED_SOURCE_KINDS or is_shell(row):
        return None
    return "pdf" if is_editable_pdf(row) else "blob"


async def check_room(db: AsyncSession, row: UserFile, new_size: int) -> None:
    """Refuse a replacement that would take the owner over their storage.
    The bytes it replaces stay, as a version — whether those count yet
    depends on when versions start counting (WP-6.2)."""
    from app.auth.models import User
    from app.files.quota import get_quota

    if row.user_id is None:
        return
    owner = await db.get(User, row.user_id)
    if owner is None:
        return
    quota = await get_quota(db, owner)
    grow = new_size if quota.versions_counted else new_size - row.size_bytes
    if quota.cap_bytes is not None and grow > 0 and quota.used_bytes + grow > quota.cap_bytes:
        raise VersionError("Saving this would go over the storage limit. Free some space or ask an admin.")


def _drop_thumbs(file_id: uuid.UUID) -> None:
    from app.files import storage

    try:
        for p in (storage.UPLOAD_ROOT / "derived" / "thumbs").glob(f"{file_id}-*"):
            p.unlink(missing_ok=True)
    except OSError:
        pass


async def refresh_after_change(row: UserFile) -> None:
    """New bytes: re-read the text (search), drop cached thumbnails and the
    media worker's renditions, and queue whatever reads the file again."""
    from app.files.derivatives import remove_derived
    from app.files.extraction import extract_content_text
    from app.files.media_meta import media_kind
    from app.files.office_formats import office_ext
    from app.tasks.queue import enqueue_media, enqueue_office_text

    await asyncio.to_thread(_drop_thumbs, row.id)
    await asyncio.to_thread(remove_derived, row.id)
    if office_ext(row.filename) is not None:
        row.content_text = None
        await enqueue_office_text(row.id)
    else:
        try:
            row.content_text = await asyncio.to_thread(extract_content_text, row)
        except Exception:  # noqa: BLE001 — search must never break a save
            logger.warning("couldn't re-read the text of %s", row.id, exc_info=True)
    if media_kind(row.mime_type) is not None:
        await enqueue_media(row.id)


async def replace_bytes(
    db: AsyncSession,
    row: UserFile,
    *,
    new_path: str,
    size: int,
    source: str,
    author_id: uuid.UUID | None,
    staged=None,  # noqa: ANN001 — blobstore.Staged (its hashes), if it was staged
    mime: str | None = None,
    label: str | None = None,
) -> FileVersion | None:
    """Make the blob at ``new_path`` (already committed) the file's content;
    what it had becomes a version. Flushed, not committed — the caller
    commits (and then may ``refresh_after_change``)."""
    from app.files import blobstore

    before: FileVersion | None = None
    if row.size_bytes == 0 and row.storage_path:
        # Nothing worth keeping: Finder makes an empty file, then writes the
        # content into it (WP-8.4). Its blob goes the usual way.
        from app.files.tombstones import tombstone

        tombstone(db, row.storage_path, reason="empty_replaced", user_id=row.user_id)
    else:
        before = FileVersion(
            file_id=row.id,
            kind=blob_kind(row) or "blob",
            storage_path=row.storage_path,
            size_bytes=row.size_bytes,
            source=source,
            label=label,
            author_ids=[author_id] if author_id else [],
            content_hash=row.content_sha256,
        )
        db.add(before)
    row.storage_path = new_path
    row.size_bytes = size
    if mime:
        row.mime_type = mime
    # The search index re-reads a file whose modified_at passed its last
    # indexing (WP-5.1).
    row.modified_at = datetime.now(timezone.utc)
    if staged is not None:
        blobstore.record(row, staged)
    else:
        await blobstore.hash_into(row)
    await db.flush()
    return before


async def restore_bytes(db: AsyncSession, row: UserFile, version: FileVersion, user_id: uuid.UUID | None) -> None:
    """Point the file back at ``version``'s bytes, keeping the current ones
    as a version first. Commits."""
    from app.files.storage import absolute_path

    if not version.storage_path or not absolute_path(version.storage_path).exists():
        raise VersionError("That version's file is missing.")
    if version.storage_path == row.storage_path:
        return
    stamp = version.created_at.strftime("%d %b %Y %H:%M") if version.created_at else "earlier"
    await replace_bytes(
        db, row, new_path=version.storage_path, size=version.size_bytes, source="restore",
        author_id=user_id, label=f"Before restoring the version from {stamp}"[:200],
    )
    await refresh_after_change(row)
    await db.commit()


async def prune_blob_versions(db: AsyncSession) -> list[str]:
    """Retention for byte versions: all kept for 30 days, then at most the
    newest 100 per file; named and keep-forever ones always. Returns the
    pruned versions' paths (the caller tombstones the unused ones)."""
    result = await db.execute(
        text(
            f"""
            WITH ranked AS (
              SELECT id, created_at,
                     row_number() OVER (PARTITION BY file_id ORDER BY created_at DESC) AS rn
                FROM file_versions
               WHERE kind IN ('pdf', 'blob') AND label IS NULL AND NOT keep_forever
            )
            DELETE FROM file_versions
             WHERE id IN (
               SELECT id FROM ranked
                WHERE created_at < now() - interval '{KEEP_DAYS} days' AND rn > {KEEP_MAX}
             )
            RETURNING storage_path
            """
        )
    )
    return [p for p in result.scalars().all() if p]


def version_filename(row: UserFile, version: FileVersion) -> str:
    """"report (12 Oct 2026 14.05).pdf" — what a downloaded version is called."""
    stamp = version.created_at.strftime("%d %b %Y %H.%M") if version.created_at else "earlier"
    base, dot, ext = (row.filename or "file").rpartition(".")
    if not dot:
        return f"{row.filename} ({stamp})"
    return f"{base} ({stamp}).{ext}"


__all__ = [
    "KINDS",
    "VersionError",
    "blob_kind",
    "check_room",
    "prune_blob_versions",
    "refresh_after_change",
    "replace_bytes",
    "restore_bytes",
    "version_filename",
]
