"""Editor-state snapshots for office files (WP-3.3, Part C §3.4).

Sharing a sheet or whiteboard widely makes "someone blanked it" a real
risk, and collab overwrote the whole Y.Doc on every store. Every office
file now accumulates ``file_versions``:

* the collab server writes ``auto`` (≤ every 10 minutes of editing, and on
  last disconnect) and ``shrink_guard`` (the current state, before one
  under half its size replaces it) — ``collab/src/server.js``;
* the backend writes ``pre_ai`` before an AI change is applied, ``import``
  before an import replaces content, ``restore`` before a restore, and a
  labelled ``manual`` one before "Clear sheet" (:func:`snapshot_file`).

:func:`prune_versions` keeps them bounded; :func:`restore_version` (the
history panel's Restore, WP-6.2) makes one current again for everyone;
:func:`recover_as_copy` is the admin path (``python -m app.cli versions``).
"""
from __future__ import annotations

import hashlib
import logging
import uuid
import zlib
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.generated_kinds import GeneratedKind
from app.files.models import FileVersion, UserFile

logger = logging.getLogger("promptly.files.versions")

SOURCES = ("auto", "manual", "restore", "import", "pre_ai", "shrink_guard", "edit", "upload", "generated", "dav")

_KIND = {
    GeneratedKind.DOCUMENT.value: "document",
    GeneratedKind.SHEET.value: "sheet",
    GeneratedKind.WHITEBOARD.value: "whiteboard",
}


def kind_of(row: UserFile) -> str | None:
    return _KIND.get(row.source_kind or "")


async def current_state(db: AsyncSession, row: UserFile) -> tuple[bytes, Any]:
    """(Yjs state, sheet workbook JSON or None) as stored now."""
    from app.chat.models import Spreadsheet, WorkspaceCanvas
    from app.files.models import DocumentState

    kind = kind_of(row)
    if kind == "document":
        ds = await db.get(DocumentState, row.id)
        return (ds.yjs_update if ds is not None else b"") or b"", None
    model = Spreadsheet if kind == "sheet" else WorkspaceCanvas
    entity = (await db.execute(select(model).where(model.file_id == row.id))).scalar_one_or_none()
    if entity is None:
        return b"", None
    return entity.yjs_update or b"", getattr(entity, "data", None)


async def snapshot_file(
    db: AsyncSession,
    row: UserFile,
    *,
    source: str,
    label: str | None = None,
    author_id: uuid.UUID | None = None,
    keep_forever: bool = False,
    live_state: bytes | None = None,
) -> FileVersion | None:
    """Keep the file's stored state as a version (flushed, not committed).
    Skips an empty file and one identical to its newest version.
    ``live_state`` — the collab room's in-memory state, newer than what's
    stored — is kept instead when given."""
    if source not in SOURCES:
        raise ValueError(f"unknown version source {source!r}")
    kind = kind_of(row)
    if kind is None:
        return None
    state, data = await current_state(db, row)
    if live_state:
        state = live_state
    if not state and not data:
        return None
    import json

    digest = hashlib.sha256(
        state + (json.dumps(data, sort_keys=True).encode("utf-8") if data is not None else b"")
    ).hexdigest()
    last = (
        await db.execute(
            select(FileVersion.content_hash)
            .where(FileVersion.file_id == row.id)
            .order_by(FileVersion.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if last == digest and not label:
        return None
    v = FileVersion(
        file_id=row.id,
        kind=kind,
        yjs_state=zlib.compress(state) if state else None,
        data=data,
        author_ids=[author_id] if author_id else [],
        source=source,
        label=label,
        keep_forever=keep_forever,
        size_bytes=len(state),
        content_hash=digest,
    )
    db.add(v)
    await db.flush()
    return v


async def prune_versions(db: AsyncSession) -> int:
    """Retention: within 48 hours keep the newest per hour, within 30 days
    the newest per day, and the newest overall per file; labelled and
    keep-forever versions always stay. Returns how many went."""
    result = await db.execute(
        text(
            """
            WITH ranked AS (
              SELECT id,
                     CASE
                       WHEN created_at > now() - interval '48 hours' THEN date_trunc('hour', created_at)
                       WHEN created_at > now() - interval '30 days' THEN date_trunc('day', created_at)
                     END AS bucket,
                     row_number() OVER (
                       PARTITION BY file_id,
                         CASE
                           WHEN created_at > now() - interval '48 hours' THEN date_trunc('hour', created_at)
                           WHEN created_at > now() - interval '30 days' THEN date_trunc('day', created_at)
                         END
                       ORDER BY created_at DESC
                     ) AS rn_bucket,
                     row_number() OVER (PARTITION BY file_id ORDER BY created_at DESC) AS rn_file
                FROM file_versions
               WHERE label IS NULL AND NOT keep_forever
                 -- Uploaded files' versions have their own rule (WP-8.1).
                 AND kind NOT IN ('pdf', 'blob')
            )
            DELETE FROM file_versions
             WHERE id IN (
               SELECT id FROM ranked
                WHERE rn_file > 1 AND (bucket IS NULL OR rn_bucket > 1)
             )
            RETURNING storage_path
            """
        )
    )
    deleted = result.scalars().all()
    # Uploaded files' versions: 30 days, then the newest 100 (WP-8.1).
    from app.files.blob_versions import prune_blob_versions

    blob_gone = await prune_blob_versions(db)
    gone = [p for p in deleted if p] + blob_gone
    if gone:
        # A pruned PDF version's bytes (WP-6.5) go through the normal 14-day
        # deletion — unless the file (or another version) still uses them.
        # The scrubber's orphan walk only quarantines; it never deletes.
        from app.files.tombstones import _referenced_paths, tombstone

        still = await _referenced_paths(db, gone)
        for p in set(gone) - still:
            tombstone(db, p, reason="version_pruned")
    return len(deleted) + len(blob_gone)


async def recover_as_copy(db: AsyncSession, version: FileVersion) -> UserFile:
    """Recreate ``version``'s content as a new file next to the original —
    "(recovered <date>)" — leaving the original untouched (a CRDT merge
    can't take content *out* of a live document). A workspace sheet /
    whiteboard / note copy joins its workspace's tree. Flushed, not
    committed."""
    from app.chat.models import Spreadsheet, WorkspaceCanvas, WorkspaceItem
    from app.files.office import add_with_shell

    original = await db.get(UserFile, version.file_id)
    if original is None:
        raise ValueError("the original file is gone")
    state = zlib.decompress(version.yjs_state) if version.yjs_state else b""
    stamp = version.created_at.strftime("%Y-%m-%d %H:%M")
    base = (original.filename or "Untitled").rsplit(".", 1)[0]
    title = f"{base} (recovered {stamp})"

    if version.kind == "document":
        from app.files.documents_router import _write_rendered, create_blank_document
        from app.files.models import DocumentState

        doc = await create_blank_document(
            db, owner_id=original.user_id, folder_id=original.folder_id, name=title
        )
        ds = await db.get(DocumentState, doc.id)
        if ds is not None:
            ds.yjs_update = state
            ds.version = (ds.version or 0) + 1
        if state:
            _write_rendered(doc, state)
        note = (
            await db.execute(
                select(WorkspaceItem).where(
                    WorkspaceItem.ref_id == original.id, WorkspaceItem.kind == "note"
                )
            )
        ).scalars().first()
        if note is not None:
            db.add(WorkspaceItem(workspace_id=note.workspace_id, kind="note", ref_id=doc.id,
                                 title=title, position=note.position + 0.5,
                                 created_by=note.created_by, visibility=note.visibility))
        await db.flush()
        return doc

    model = Spreadsheet if version.kind == "sheet" else WorkspaceCanvas
    src = (await db.execute(select(model).where(model.file_id == original.id))).scalar_one_or_none()
    if src is None:
        raise ValueError("the original sheet or whiteboard is gone")
    kwargs: dict[str, Any] = {"workspace_id": src.workspace_id, "title": title, "yjs_update": state}
    if version.kind == "sheet":
        kwargs["data"] = version.data
    entity = model(**kwargs)
    if src.workspace_id is None:
        raise ValueError("recovering a personal sheet or whiteboard isn't supported yet")
    shell = await add_with_shell(db, entity, kind=original.source_kind)
    item_kind = "sheet" if version.kind == "sheet" else "canvas"
    item = (
        await db.execute(
            select(WorkspaceItem).where(WorkspaceItem.ref_id == src.id, WorkspaceItem.kind == item_kind)
        )
    ).scalars().first()
    db.add(WorkspaceItem(workspace_id=src.workspace_id, kind=item_kind, ref_id=entity.id, title=title,
                         parent_id=item.parent_id if item is not None else None,
                         position=(item.position + 0.5) if item is not None else 0,
                         created_by=item.created_by if item is not None else None))
    await db.flush()
    return shell


class RestoreError(RuntimeError):
    """A restore that couldn't start — the message is for the person."""


async def room_for(db: AsyncSession, row: UserFile) -> str:
    """The collab room name of an office file."""
    from app.files.office import content_for_shell

    kind = kind_of(row)
    if kind == "document":
        return str(row.id)
    entity = await content_for_shell(db, row)
    if entity is None:
        raise RestoreError("This file's content is missing.")
    return f"{'sheet' if kind == 'sheet' else 'canvas'}:{entity.id}"


async def restore_version(db: AsyncSession, row: UserFile, version: FileVersion, user: Any) -> int:
    """Make ``version`` the file's current state (WP-6.2) — a server-side
    room reset:

    1. collab freezes the room (no stores, no new connections), tells open
       editors to reload, closes them and hands back the live state;
    2. that live state is kept as a "Before restoring …" version;
    3. the chosen state is written (Yjs, plus the sheet's workbook JSON and
       a document's rendered HTML / search text);
    4. the file's edit generation goes up, so any editor still holding the
       old state reloads rather than merging it back;
    5. the room is released.

    Commits. Returns the new generation."""
    from app.collab_internal import release_room, reset_room
    from app.files.office import content_for_shell

    kind = kind_of(row)
    room = await room_for(db, row)
    try:
        live = await reset_room(room)
    except Exception as exc:  # noqa: BLE001 — never write under a live room
        logger.warning("restore of %s: collab reset failed", row.id, exc_info=True)
        raise RestoreError("Live editing couldn't be paused for the restore — try again in a moment.") from exc
    try:
        stamp = version.created_at.strftime("%d %b %Y, %H:%M")
        await snapshot_file(
            db, row, source="restore", label=f"Before restoring the version from {stamp}",
            author_id=getattr(user, "id", None), live_state=live,
        )
        state = zlib.decompress(version.yjs_state) if version.yjs_state else b""
        if kind == "document":
            from app.files.documents_router import _write_rendered
            from app.files.models import DocumentState

            ds = await db.get(DocumentState, row.id)
            if ds is None:
                ds = DocumentState(file_id=row.id, yjs_update=state, version=1)
                db.add(ds)
            else:
                ds.yjs_update = state
                ds.version = (ds.version or 0) + 1
            _write_rendered(row, state)
        else:
            entity = await content_for_shell(db, row)
            if entity is None:
                raise RestoreError("This file's content is missing.")
            entity.yjs_update = state
            if kind == "sheet":
                from app.workspaces.sheet_io import flatten_text

                entity.data = version.data
                entity.content_text = flatten_text(version.data) or None
                entity.data_version = (entity.data_version or 0) + 1
                row.content_text = entity.content_text
        row.collab_epoch = (row.collab_epoch or 0) + 1
        await db.commit()
        return row.collab_epoch
    except Exception:
        await db.rollback()
        raise
    finally:
        await release_room(room)


__all__ = [
    "SOURCES",
    "RestoreError",
    "current_state",
    "kind_of",
    "prune_versions",
    "recover_as_copy",
    "restore_version",
    "room_for",
    "snapshot_file",
]
