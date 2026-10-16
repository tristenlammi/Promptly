"""Office files are files (WP-3.2, Part C §3.2–3.3).

Documents have always been Drive files: a ``files`` row plus their
``document_state``. Spreadsheets and whiteboards were workspace-only rows
that reached Drive only as ``.md`` text mirrors, so they couldn't be
searched as themselves, shared, starred or counted against quota.

Every spreadsheet and whiteboard now has a **shell**: a ``files`` row
(``source_kind`` ``sheet`` / ``whiteboard``) that is its identity in Drive.
The content stays where it was — ``spreadsheets`` / ``workspace_canvas``,
with the Yjs state collab writes — and points at its shell through
``file_id`` (``NOT NULL UNIQUE``, never cascaded: deleting a shell while
its content exists fails instead of wiping it).

A shell has no blob of its own. ``size_bytes`` is the real state size (so
quota counts it), ``content_text`` the flattened text (so Drive search
finds it), and a download exports on demand — ``.xlsx`` for a sheet,
``.excalidraw`` for a whiteboard — so nothing on disk can go stale.

This module is the one place that creates shells and the one access
function every office kind answers to.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.files.storage import storage_path_for

# Imported by app.database (for the shell hooks), so User only for typing —
# a runtime import would be circular.
if TYPE_CHECKING:
    from app.auth.models import User

SHEET_MIME = "application/vnd.promptly.sheet+json"
WHITEBOARD_MIME = "application/vnd.promptly.whiteboard+json"

OfficeKind = Literal["document", "sheet", "whiteboard"]
Access = Literal["none", "read", "comment", "edit"]

# shell source_kind → (MIME, filename suffix)
_SHELLS: dict[str, tuple[str, str]] = {
    GeneratedKind.SHEET.value: (SHEET_MIME, ".sheet"),
    GeneratedKind.WHITEBOARD.value: (WHITEBOARD_MIME, ".whiteboard"),
}

OFFICE_SOURCE_KINDS = frozenset(
    {GeneratedKind.DOCUMENT.value, GeneratedKind.SHEET.value, GeneratedKind.WHITEBOARD.value}
)

_RANK = {"none": 0, "read": 1, "comment": 2, "edit": 3}


def is_shell(row: UserFile) -> bool:
    return row.source_kind in _SHELLS


def shell_filename(kind: str, title: str) -> str:
    from app.files.safety import sanitize_filename

    suffix = _SHELLS[kind][1]
    clean = (title or "Untitled").strip()[:240] or "Untitled"
    try:
        return sanitize_filename(f"{clean}{suffix}")
    except Exception:  # noqa: BLE001 — an odd title still gets a shell
        return f"Untitled{suffix}"


def state_size(entity: Any) -> int:
    """Bytes the content really takes: the Yjs state plus the sheet's
    workbook JSON (what quota counts)."""
    n = len(getattr(entity, "yjs_update", b"") or b"")
    data = getattr(entity, "data", None)
    if data is not None:
        n += len(json.dumps(data, separators=(",", ":")).encode("utf-8"))
    return n


def make_shell(
    *, kind: str, owner_id: uuid.UUID, folder_id: uuid.UUID | None, title: str, entity: Any
) -> UserFile:
    """A shell row for ``entity`` (a ``Spreadsheet`` or ``WorkspaceCanvas``);
    the caller adds it and sets ``entity.file_id``. No blob is written."""
    mime, suffix = _SHELLS[kind]
    new_id = uuid.uuid4()
    name = shell_filename(kind, title)
    return UserFile(
        id=new_id,
        user_id=owner_id,
        folder_id=folder_id,
        filename=name,
        original_filename=name,
        mime_type=mime,
        size_bytes=state_size(entity),
        storage_path=storage_path_for(owner_id, new_id, f"{suffix}.export"),
        source_kind=kind,
        content_text=getattr(entity, "content_text", None),
    )


async def _workspace_folder(db: AsyncSession, workspace_id: uuid.UUID | None, sub: str):
    """The workspace's ``sub`` folder (Sheets / Canvases) or its root."""
    from app.chat.models import Workspace
    from app.files.system_folders import get_or_create_subfolder

    if workspace_id is None:
        return None, None
    ws = await db.get(Workspace, workspace_id)
    if ws is None:
        return None, None
    if ws.root_folder_id is None:
        return ws.user_id, None
    folder = await get_or_create_subfolder(
        db, user_id=ws.user_id, parent_id=ws.root_folder_id, name=sub
    )
    return ws.user_id, folder.id


async def add_with_shell(db: AsyncSession, entity: Any, *, kind: str) -> UserFile:
    """Add a new workspace sheet / whiteboard together with its shell
    (flushed, not committed) — instead of ``db.add(entity)``. The shell
    lives in the workspace owner's Drive, which keeps today's owner-pays
    storage model."""
    sub = "Sheets" if kind == GeneratedKind.SHEET.value else "Canvases"
    owner_id, folder_id = await _workspace_folder(db, entity.workspace_id, sub)
    if owner_id is None:
        raise ValueError("A personal sheet or whiteboard needs create_office_file")
    shell = make_shell(
        kind=kind, owner_id=owner_id, folder_id=folder_id, title=entity.title, entity=entity
    )
    db.add(shell)
    await db.flush()
    entity.file_id = shell.id
    db.add(entity)
    await db.flush()
    return shell


async def create_office_file(
    db: AsyncSession,
    *,
    kind: OfficeKind,
    owner: User,
    title: str,
    folder_id: uuid.UUID | None = None,
    workspace_id: uuid.UUID | None = None,
    data: Any = None,
    content_text: str | None = None,
) -> tuple[UserFile, Any]:
    """Create an office file — the shell and its content row — in
    ``owner``'s ``folder_id``. ``workspace_id`` ties a sheet / whiteboard to
    a workspace (the workspace layer adds the navigator item); without it
    the file is personal. Flushed, not committed."""
    from app.chat.models import Spreadsheet, WorkspaceCanvas

    if kind == "document":
        from app.files.documents_router import create_blank_document

        doc = await create_blank_document(db, owner_id=owner.id, folder_id=folder_id, name=title)
        return doc, None
    if kind == "sheet":
        entity: Any = Spreadsheet(workspace_id=workspace_id, title=title, data=data, content_text=content_text)
        skind = GeneratedKind.SHEET.value
    elif kind == "whiteboard":
        entity = WorkspaceCanvas(workspace_id=workspace_id, title=title, yjs_update=b"")
        skind = GeneratedKind.WHITEBOARD.value
    else:  # pragma: no cover — guarded by the Literal
        raise ValueError(f"unknown office kind {kind!r}")
    shell = make_shell(kind=skind, owner_id=owner.id, folder_id=folder_id, title=title, entity=entity)
    db.add(shell)
    await db.flush()
    entity.file_id = shell.id
    db.add(entity)
    await db.flush()
    return shell, entity


async def content_for_shell(db: AsyncSession, row: UserFile) -> Any | None:
    """The ``Spreadsheet`` / ``WorkspaceCanvas`` behind a shell."""
    from app.chat.models import Spreadsheet, WorkspaceCanvas

    model = {
        GeneratedKind.SHEET.value: Spreadsheet,
        GeneratedKind.WHITEBOARD.value: WorkspaceCanvas,
    }.get(row.source_kind or "")
    if model is None:
        return None
    return (await db.execute(select(model).where(model.file_id == row.id))).scalar_one_or_none()


async def shell_for(db: AsyncSession, entity: Any) -> UserFile | None:
    fid = getattr(entity, "file_id", None)
    return await db.get(UserFile, fid) if fid else None


async def sync_shell(
    db: AsyncSession,
    entity: Any,
    *,
    title: str | None = None,
    trashed: bool | None = None,
    content_changed: bool = False,
) -> None:
    """Keep the shell in step with its content: name, trash state, size
    and search text. Doesn't commit."""
    shell = await shell_for(db, entity)
    if shell is None:
        return
    if title is not None:
        shell.filename = shell.original_filename = shell_filename(shell.source_kind, title)
    if trashed is not None:
        shell.trashed_at = datetime.now(timezone.utc) if trashed else None
    if content_changed:
        shell.size_bytes = state_size(entity)
        shell.content_text = getattr(entity, "content_text", None)


async def _workspace_item_for(db: AsyncSession, entity: Any, kind: str):
    from app.chat.models import WorkspaceItem

    item_kind = "sheet" if kind == GeneratedKind.SHEET.value else "canvas"
    return (
        await db.execute(
            select(WorkspaceItem).where(
                WorkspaceItem.ref_id == entity.id, WorkspaceItem.kind == item_kind
            )
        )
    ).scalars().first()


async def get_office_access(db: AsyncSession, row: UserFile, user: User) -> Access:
    """What ``user`` may do with an office file — the one answer for
    Documents, Sheets and Whiteboards (Part C §3.3). Combines ownership,
    Drive grants (``can_edit`` → edit), the workspace role, and the
    workspace item's private-draft flag and trash. Callers turn "none"
    into a 404, never a 403."""
    if row.source_kind == GeneratedKind.DOCUMENT.value:
        from fastapi import HTTPException

        from app.files.documents_router import _load_document
        from app.files.sharing import can_write_document

        try:
            await _load_document(db, row.id, user)
        except HTTPException:
            return "none"
        if await can_write_document(db, row, user):
            return "edit"
        from app.files.sharing import caller_grants_for_file, effective_can_comment

        # A commenter (WP-6.6): reads, and comments, but doesn't edit.
        return "comment" if effective_can_comment(await caller_grants_for_file(db, row, user)) else "read"

    if not is_shell(row) or row.trashed_at is not None:
        return "none"
    best: Access = "none"

    def up(level: Access) -> None:
        nonlocal best
        if _RANK[level] > _RANK[best]:
            best = level

    if row.user_id is not None and row.user_id == user.id:
        up("edit")
    from app.files.sharing import caller_grants_for_file, effective_can_comment, effective_can_edit

    grants = await caller_grants_for_file(db, row, user)
    if grants:
        up("edit" if effective_can_edit(grants) else "comment" if effective_can_comment(grants) else "read")

    entity = await content_for_shell(db, row)
    if entity is not None and entity.workspace_id is not None:
        from fastapi import HTTPException

        from app.workspaces.shares import get_accessible_workspace

        try:
            _ws, role = await get_accessible_workspace(entity.workspace_id, user, db)
        except HTTPException:
            role = None
        item = await _workspace_item_for(db, entity, row.source_kind)
        if item is not None and item.trashed_at is not None:
            # In the workspace's trash: closed to everyone until restored.
            return "none"
        private_to_other = (
            item is not None and item.visibility == "private" and item.created_by != user.id
        )
        if role is not None and not private_to_other:
            up("read" if role == "viewer" else "edit")
    return best


def export_for_download(row: UserFile, entity: Any) -> tuple[bytes, str, str]:
    """(bytes, filename, MIME) for downloading a shell — exported on demand.
    Synchronous (openpyxl / the scene decoder); run it off the event loop."""
    base = (row.filename or "Untitled").rsplit(".", 1)[0] or "Untitled"
    if row.source_kind == GeneratedKind.SHEET.value:
        from app.workspaces.sheet_io import to_xlsx

        return (
            to_xlsx(getattr(entity, "data", None)),
            f"{base}.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    from app.workspaces.export_router import canvas_scene_json

    scene = canvas_scene_json(getattr(entity, "yjs_update", b"") or b"") or json.dumps(
        {"type": "excalidraw", "version": 2, "source": "promptly", "elements": [], "appState": {}, "files": {}}
    )
    return scene.encode("utf-8"), f"{base}.excalidraw", "application/json"


__all__ = [
    "OFFICE_SOURCE_KINDS",
    "SHEET_MIME",
    "WHITEBOARD_MIME",
    "add_with_shell",
    "content_for_shell",
    "create_office_file",
    "export_for_download",
    "get_office_access",
    "is_shell",
    "make_shell",
    "shell_filename",
    "state_size",
    "sync_shell",
]


# ---------------------------------------------------------------------
# Keeping shells in step (one hook, every write path)
# ---------------------------------------------------------------------
# Titles, trash and content change in many places (the item tree, the
# sheet save, the canvas text push, workspace trash, purges). Rather than
# touching each, the session keeps a shell in step with its content and
# its workspace item. Collab's own Yjs stores bypass the ORM and update the
# shell's size in the same SQL (collab/src/server.js).
from sqlalchemy import event as _event, inspect as _inspect, text as _text  # noqa: E402
from sqlalchemy.orm import Session as _Session  # noqa: E402

_PENDING_KEY = "office_shells"


def _changed(obj: Any, *attrs: str) -> bool:
    state = _inspect(obj)
    return any(state.attrs[a].history.has_changes() for a in attrs if a in state.attrs)


@_event.listens_for(_Session, "before_flush")
def _sync_shells(session, _ctx, _instances) -> None:
    from app.chat.models import Spreadsheet, Workspace, WorkspaceCanvas, WorkspaceItem

    pending = session.info.setdefault(_PENDING_KEY, {"drop": set(), "ws": {}})
    for obj in list(session.dirty):
        if isinstance(obj, (Spreadsheet, WorkspaceCanvas)) and obj.file_id:
            if not _changed(obj, "title", "data", "content_text", "yjs_update"):
                continue
            shell = session.get(UserFile, obj.file_id)
            if shell is None:
                continue
            if _changed(obj, "title"):
                shell.filename = shell.original_filename = shell_filename(shell.source_kind, obj.title)
            if _changed(obj, "data", "content_text", "yjs_update"):
                shell.size_bytes = state_size(obj)
                shell.content_text = obj.content_text
        elif isinstance(obj, WorkspaceItem) and obj.kind in ("sheet", "canvas") and obj.ref_id:
            if not _changed(obj, "trashed_at", "title"):
                continue
            model = Spreadsheet if obj.kind == "sheet" else WorkspaceCanvas
            entity = session.get(model, obj.ref_id)
            shell = session.get(UserFile, entity.file_id) if entity is not None else None
            if shell is None:
                continue
            if _changed(obj, "trashed_at"):
                shell.trashed_at = obj.trashed_at
            if _changed(obj, "title") and obj.title:
                shell.filename = shell.original_filename = shell_filename(shell.source_kind, obj.title)
        elif isinstance(obj, Workspace) and _changed(obj, "trashed_at"):
            pending["ws"][obj.id] = obj.trashed_at
    for obj in session.deleted:
        if isinstance(obj, (Spreadsheet, WorkspaceCanvas)) and obj.file_id:
            pending["drop"].add(obj.file_id)
        elif isinstance(obj, Workspace):
            pending["drop"].update(
                session.execute(
                    _text(
                        "SELECT file_id FROM spreadsheets WHERE workspace_id = :w "
                        "UNION SELECT file_id FROM workspace_canvas WHERE workspace_id = :w"
                    ),
                    {"w": obj.id},
                ).scalars()
            )


@_event.listens_for(_Session, "after_flush")
def _settle_shells(session, _ctx) -> None:
    pending = session.info.pop(_PENDING_KEY, None)
    if not pending:
        return
    conn = session.connection()
    for ws_id, trashed_at in pending["ws"].items():
        # A workspace in the trash takes its sheets and whiteboards with it
        # — they'd otherwise stay live in Drive and Search. Restoring brings
        # back those whose item isn't in the workspace's own trash.
        conn.execute(
            _text(
                """
                UPDATE files f SET trashed_at = :t
                  FROM (SELECT s.file_id, i.trashed_at AS item_trashed
                          FROM spreadsheets s
                          LEFT JOIN workspace_items i ON i.ref_id = s.id AND i.kind = 'sheet'
                         WHERE s.workspace_id = :w
                        UNION ALL
                        SELECT c.file_id, i.trashed_at
                          FROM workspace_canvas c
                          LEFT JOIN workspace_items i ON i.ref_id = c.id AND i.kind = 'canvas'
                         WHERE c.workspace_id = :w) x
                 WHERE f.id = x.file_id
                   AND (CAST(:t AS timestamptz) IS NOT NULL OR x.item_trashed IS NULL)
                """
            ),
            {"t": trashed_at, "w": ws_id},
        )
    if pending["drop"]:
        # Content gone → its shell goes too. Only once nothing points at it:
        # the content rows are deleted in this same flush (or cascaded with
        # their workspace), and a shell's FK never cascades.
        conn.execute(
            _text(
                """
                DELETE FROM files f
                 WHERE f.id = ANY(:ids)
                   AND NOT EXISTS (SELECT 1 FROM spreadsheets s WHERE s.file_id = f.id)
                   AND NOT EXISTS (SELECT 1 FROM workspace_canvas c WHERE c.file_id = f.id)
                """
            ),
            {"ids": list(pending["drop"])},
        )
