"""Permanent deletion of Drive rows — one implementation for every caller.

Trash's "Delete forever", Empty trash, the admin purge, the 30-day trash
retention sweep and the orphaned-asset sweep all go through here, so they
agree on two rules:

* blobs are tombstoned (:mod:`app.files.tombstones`), never unlinked on the
  spot — every permanent delete is recoverable for 14 days;
* a document's inline images and audio go with the document (R-027).

Nothing here commits; callers commit once for the whole operation.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.generated_kinds import GeneratedKind
from app.files.models import FileFolder, UserFile
from app.files.tombstones import tombstone_files

logger = logging.getLogger("promptly.files.purge")

# Drive trash keeps items this long, like workspace trash.
TRASH_RETENTION_DAYS = 30


async def descendant_folder_ids(db: AsyncSession, root_id: uuid.UUID) -> list[uuid.UUID]:
    """``root_id`` plus every folder below it."""
    out: list[uuid.UUID] = []
    frontier = [root_id]
    while frontier:
        out.extend(frontier)
        frontier = list(
            (await db.execute(select(FileFolder.id).where(FileFolder.parent_id.in_(frontier))))
            .scalars()
            .all()
        )
    return out


async def document_asset_rows(db: AsyncSession, doc_ids) -> list[UserFile]:
    """Inline images/audio belonging to the given documents."""
    doc_ids = list(doc_ids)
    if not doc_ids:
        return []
    return list(
        (
            await db.execute(
                select(UserFile).where(
                    UserFile.source_kind == GeneratedKind.DOCUMENT_ASSET.value,
                    UserFile.source_file_id.in_(doc_ids),
                )
            )
        )
        .scalars()
        .all()
    )


async def purge_file_rows(db: AsyncSession, rows, *, reason: str = "purge") -> int:
    """Hard-delete ``rows`` (plus any document's assets); tombstone blobs."""
    rows = list(rows)
    if not rows:
        return 0
    # A workspace sheet / whiteboard shell goes with its content (the
    # workspace's own trash purges both) — never on its own, which its FK
    # forbids (WP-3.2). A personal one (no workspace, WP-3.4) is the file:
    # its content goes first, then the shell.
    shell_ids = [
        r.id
        for r in rows
        if r.source_kind in (GeneratedKind.SHEET.value, GeneratedKind.WHITEBOARD.value)
    ]
    if shell_ids:
        from sqlalchemy import text as _text

        held = set(
            (
                await db.execute(
                    _text(
                        "SELECT file_id FROM spreadsheets WHERE file_id = ANY(:ids) AND workspace_id IS NOT NULL "
                        "UNION SELECT file_id FROM workspace_canvas WHERE file_id = ANY(:ids) "
                        "AND workspace_id IS NOT NULL"
                    ),
                    {"ids": shell_ids},
                )
            ).scalars()
        )
        rows = [r for r in rows if r.id not in held]
        if not rows:
            return 0
        personal = [r.id for r in rows if r.id in set(shell_ids)]
        if personal:
            await db.execute(
                _text("DELETE FROM spreadsheets WHERE file_id = ANY(:ids) AND workspace_id IS NULL"),
                {"ids": personal},
            )
            await db.execute(
                _text("DELETE FROM workspace_canvas WHERE file_id = ANY(:ids) AND workspace_id IS NULL"),
                {"ids": personal},
            )
            from app.files.office_router import whiteboard_thumb_path

            for fid in personal:
                whiteboard_thumb_path(fid).unlink(missing_ok=True)
    doc_ids = [r.id for r in rows if r.source_kind == GeneratedKind.DOCUMENT.value]
    # Their first-page thumbnails (Docs, Office files) go with them.
    from app.files import doc_thumbs

    for r in rows:
        doc_thumbs.remove(r.id)
    if doc_ids:
        seen = {r.id for r in rows}
        rows.extend(a for a in await document_asset_rows(db, doc_ids) if a.id not in seen)
    tombstone_files(db, rows, reason=reason)
    from app.files.derivatives import remove_derived

    for r in rows:
        # Renditions are regenerable — they go now, not with the blob (WP-7.4).
        remove_derived(r.id)
        await db.delete(r)
    return len(rows)


async def purge_folder_subtree(db: AsyncSession, folder: FileFolder, *, reason: str = "purge") -> int:
    """Hard-delete ``folder``, its subfolders and the trashed files inside.

    A file restored on its own into a still-trashed folder is live: it's
    lifted to the owner's root (the FK's SET NULL) rather than destroyed.
    Returns how many files were purged.
    """
    ids = await descendant_folder_ids(db, folder.id)
    files = (
        (
            await db.execute(
                select(UserFile).where(
                    UserFile.folder_id.in_(ids), UserFile.trashed_at.is_not(None)
                )
            )
        )
        .scalars()
        .all()
    )
    n = await purge_file_rows(db, files, reason=reason)
    await db.delete(folder)
    return n


async def purge_expired_trash(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Drive trash retention: purge what's sat in the trash past the window.

    Drive trash had no retention at all — items stayed (and counted against
    quota) forever, though the Chat Uploads pruner relied on "normal trash
    retention" to finish its job. Returns rows purged.
    """
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=TRASH_RETENTION_DAYS)
    n = 0
    folders = (
        (
            await db.execute(
                select(FileFolder).where(
                    FileFolder.trashed_at.is_not(None),
                    FileFolder.trashed_at < cutoff,
                    FileFolder.system_kind.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    gone: set[uuid.UUID] = set()
    for f in folders:
        if f.id in gone:
            continue
        gone.update(await descendant_folder_ids(db, f.id))
        n += await purge_folder_subtree(db, f, reason="trash_expired")
        await db.flush()
    files = (
        (
            await db.execute(
                select(UserFile).where(
                    UserFile.trashed_at.is_not(None),
                    UserFile.trashed_at < cutoff,
                )
            )
        )
        .scalars()
        .all()
    )
    n += await purge_file_rows(db, files, reason="trash_expired")
    return n


async def purge_orphan_document_assets(db: AsyncSession) -> int:
    """Assets whose document is gone (older builds SET NULL'd the link and
    left the rows hidden but still counted against quota)."""
    rows = (
        (
            await db.execute(
                select(UserFile).where(
                    UserFile.source_kind == GeneratedKind.DOCUMENT_ASSET.value,
                    UserFile.source_file_id.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    return await purge_file_rows(db, rows, reason="orphan_asset")


async def purge_unreferenced_document_assets(db: AsyncSession, *, min_age_days: int = 7) -> int:
    """Images and audio no longer used by their (live) document — deleted
    from the text, not in any saved version, not in its HTML — and at least
    a week old (WP-4.6, R-228: they used to stay forever, invisible but
    counted against quota). Removed through the normal purge, so the blob
    keeps its 14-day recovery window."""
    from datetime import datetime, timedelta, timezone

    from app.files.models import DocumentState, DocumentVersion
    from app.files.storage import absolute_path

    cutoff = datetime.now(timezone.utc) - timedelta(days=min_age_days)
    assets = (
        await db.execute(
            select(UserFile).where(
                UserFile.source_kind == GeneratedKind.DOCUMENT_ASSET.value,
                UserFile.source_file_id.is_not(None),
                UserFile.trashed_at.is_(None),
                UserFile.created_at < cutoff,
            )
        )
    ).scalars().all()
    by_doc: dict = {}
    for a in assets:
        by_doc.setdefault(a.source_file_id, []).append(a)
    unused: list[UserFile] = []
    for doc_id, rows in by_doc.items():
        doc = await db.get(UserFile, doc_id)
        if doc is None or doc.trashed_at is not None:
            continue  # trash and purge of the document take its assets
        corpus: list[bytes] = []
        state = await db.get(DocumentState, doc_id)
        if state is not None and state.yjs_update:
            corpus.append(bytes(state.yjs_update))
        for (html,) in (await db.execute(select(DocumentVersion.html).where(DocumentVersion.file_id == doc_id))).all():
            corpus.append((html or "").encode("utf-8"))
        try:
            corpus.append(absolute_path(doc.storage_path).read_bytes())
        except OSError:
            continue  # can't see the document's HTML — don't guess
        blob = b" ".join(corpus).lower()
        unused.extend(a for a in rows if str(a.id).lower().encode() not in blob)
    if not unused:
        return 0
    return await purge_file_rows(db, unused, reason="unreferenced_asset")


__all__ = [
    "TRASH_RETENTION_DAYS",
    "purge_unreferenced_document_assets",
    "descendant_folder_ids",
    "document_asset_rows",
    "purge_expired_trash",
    "purge_file_rows",
    "purge_folder_subtree",
    "purge_orphan_document_assets",
]
