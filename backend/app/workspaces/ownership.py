"""Hand a workspace to a new owner — the piece offboarding was missing (R-004).

Everything in a workspace is stored under its *owner's* account: the
``My files / Workspaces / <title>`` folder tree, every member's notes,
canvases and uploads, the backing files of sheets, rosters and discussions.
Deleting the owner used to cascade all of it away, including work other
members wrote. :func:`transfer_workspace` re-owns the workspace and that
content to someone else first, so a user can be deleted without taking the
team's work with them.

Blob paths don't move (``u_<old>/…`` stays where it is): the deferred
deletion sweep never unlinks a path that a row still references, so the
departing user's bucket keeps exactly the bytes the new owner needs.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import (
    Conversation,
    Roster,
    Spreadsheet,
    Workspace,
    WorkspaceCanvas,
    WorkspaceFile,
    WorkspaceItem,
    WorkspaceShare,
    WorkspaceTask,
)
from app.files.generated_kinds import GeneratedKind
from app.files.models import FileFolder, ResourceGrant, UserFile
from app.files.system_folders import ensure_workspaces_root


async def _folder_subtree(db: AsyncSession, root_id: uuid.UUID | None) -> list[uuid.UUID]:
    if root_id is None:
        return []
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


async def workspace_file_ids(db: AsyncSession, ws: Workspace) -> set[uuid.UUID]:
    """Every file the workspace uses, wherever it's filed.

    Unlike the AI allow-list this ignores visibility, trash and context
    switches — a transfer must carry private drafts and trashed items too.
    """
    out: set[uuid.UUID] = set()
    items = (
        (await db.execute(select(WorkspaceItem).where(WorkspaceItem.workspace_id == ws.id)))
        .scalars()
        .all()
    )
    by_kind: dict[str, list[WorkspaceItem]] = {}
    for it in items:
        by_kind.setdefault(it.kind, []).append(it)
    for kind in ("note", "board", "file"):
        out.update(it.ref_id for it in by_kind.get(kind, []) if it.ref_id)
    for kind, model in (("canvas", WorkspaceCanvas), ("sheet", Spreadsheet), ("roster", Roster)):
        ref_ids = [it.ref_id for it in by_kind.get(kind, []) if it.ref_id]
        if ref_ids:
            out.update(
                r
                for (r,) in await db.execute(
                    select(model.text_file_id).where(model.id.in_(ref_ids))
                )
                if r is not None
            )
    out.update(
        r
        for (r,) in await db.execute(
            select(WorkspaceCanvas.text_file_id).where(WorkspaceCanvas.workspace_id == ws.id)
        )
        if r is not None
    )
    for it in by_kind.get("discussion", []):
        raw = (it.config or {}).get("text_file_id")
        try:
            fid = uuid.UUID(str(raw)) if raw else None
        except ValueError:
            fid = None
        if fid is not None:
            uf = await db.get(UserFile, fid)
            # Only the discussion's own transcript, never an arbitrary file.
            if (
                uf is not None
                and uf.user_id == ws.user_id
                and uf.source_kind == GeneratedKind.DISCUSSION_TEXT.value
            ):
                out.add(fid)
    board_ids = [it.id for it in by_kind.get("board", [])]
    if board_ids:
        for (atts,) in await db.execute(
            select(WorkspaceTask.attachments).where(WorkspaceTask.board_item_id.in_(board_ids))
        ):
            for a in atts or []:
                if isinstance(a, dict) and a.get("file_id"):
                    try:
                        out.add(uuid.UUID(str(a["file_id"])))
                    except (ValueError, TypeError):
                        continue
    out.update(
        r
        for (r,) in await db.execute(
            select(WorkspaceFile.file_id).where(WorkspaceFile.workspace_id == ws.id)
        )
        if r is not None
    )
    if ws.automations_text_file_id is not None:
        out.add(ws.automations_text_file_id)
    out.update(
        r
        for (r,) in await db.execute(
            select(Conversation.context_file_id).where(
                Conversation.workspace_id == ws.id,
                Conversation.context_file_id.is_not(None),
            )
        )
        if r is not None
    )
    return out


async def member_ids(db: AsyncSession, workspace_id: uuid.UUID) -> list[uuid.UUID]:
    """Accepted collaborators (not the owner)."""
    return list(
        (
            await db.execute(
                select(WorkspaceShare.invitee_user_id).where(
                    WorkspaceShare.workspace_id == workspace_id,
                    WorkspaceShare.status == "accepted",
                )
            )
        )
        .scalars()
        .all()
    )


async def transfer_workspace(db: AsyncSession, ws: Workspace, new_owner: User) -> None:
    """Make ``new_owner`` the owner of ``ws`` and of everything it holds.

    Does not commit. The previous owner gets no share — this is used when
    they are leaving.
    """
    old_id = ws.user_id
    if old_id == new_owner.id:
        return

    # Folder tree: re-own every folder and file in it, and hang the
    # workspace's folder under the new owner's protected Workspaces root.
    folder_ids = await _folder_subtree(db, ws.root_folder_id)
    if folder_ids:
        await db.execute(
            update(FileFolder)
            .where(FileFolder.id.in_(folder_ids), FileFolder.user_id == old_id)
            .values(user_id=new_owner.id)
        )
        await db.execute(
            update(UserFile)
            .where(UserFile.folder_id.in_(folder_ids), UserFile.user_id == old_id)
            .values(user_id=new_owner.id)
        )
        root = await ensure_workspaces_root(db, new_owner)
        await db.execute(
            update(FileFolder)
            .where(FileFolder.id == ws.root_folder_id)
            .values(parent_id=root.id)
        )

    # Files the workspace uses that live elsewhere in the old owner's
    # drive (pins, hidden RAG mirrors, attachments) — re-own them and file
    # them in the workspace's folder, since the folder they sat in leaves
    # with the old owner. Document inline images follow their document.
    file_ids = await workspace_file_ids(db, ws)
    if file_ids:
        file_ids |= set(
            (
                await db.execute(
                    select(UserFile.id).where(
                        UserFile.source_kind == GeneratedKind.DOCUMENT_ASSET.value,
                        UserFile.source_file_id.in_(file_ids),
                    )
                )
            ).scalars()
        )
    # Only the departing owner's files move; a member's own pinned file
    # stays theirs and stays where they filed it.
    elsewhere = (
        list(
            (
                await db.execute(
                    select(UserFile).where(
                        UserFile.id.in_(file_ids), UserFile.user_id == old_id
                    )
                )
            ).scalars()
        )
        if file_ids
        else []
    )
    in_tree = set(folder_ids)
    for f in elsewhere:
        f.user_id = new_owner.id
        if (
            ws.root_folder_id is not None
            and f.folder_id is not None
            and f.folder_id not in in_tree
            and f.source_kind != GeneratedKind.DOCUMENT_ASSET.value
        ):
            f.folder_id = ws.root_folder_id

    # Grants the old owner made on what's now the new owner's.
    tree_files = (
        list(
            (
                await db.execute(
                    select(UserFile.id).where(UserFile.folder_id.in_(folder_ids))
                )
            ).scalars()
        )
        if folder_ids
        else []
    )
    moved_files = list({f.id for f in elsewhere} | set(tree_files))
    for rtype, ids in (("file", moved_files), ("folder", folder_ids)):
        if ids:
            await db.execute(
                update(ResourceGrant)
                .where(
                    ResourceGrant.resource_type == rtype,
                    ResourceGrant.resource_id.in_(ids),
                    ResourceGrant.granted_by_user_id == old_id,
                )
                .values(granted_by_user_id=new_owner.id)
            )
    # A grant to the new owner on their own file is meaningless now.
    for rtype, ids in (("file", moved_files), ("folder", folder_ids)):
        if ids:
            for g in (
                await db.execute(
                    select(ResourceGrant).where(
                        ResourceGrant.resource_type == rtype,
                        ResourceGrant.resource_id.in_(ids),
                        ResourceGrant.grantee_user_id == new_owner.id,
                    )
                )
            ).scalars():
                await db.delete(g)

    # The new owner is implicit, not a member.
    for share in (
        await db.execute(
            select(WorkspaceShare).where(
                WorkspaceShare.workspace_id == ws.id,
                WorkspaceShare.invitee_user_id == new_owner.id,
            )
        )
    ).scalars():
        await db.delete(share)
    ws.user_id = new_owner.id
    await db.flush()


__all__ = ["member_ids", "transfer_workspace", "workspace_file_ids"]
