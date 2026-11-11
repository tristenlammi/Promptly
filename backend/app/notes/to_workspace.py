"""Copy to a workspace (N2.6): a note's words and pictures as a Page.

A copy, not a live pin: a pin would let every member of the workspace (and
their chats, through workspace RAG) read a private note and every later edit
without it being shared with them. The copy is honest about who will see it
(the dialog names the workspace), and the note stays exactly as it was.

* Only the note's **owner** copies it out (the words are theirs to publish).
* Only workspaces where they can add pages (owner, admin or editor;
  ``workspaces/shares.get_accessible_workspace`` + ``require_workspace_write``),
  at the root or in one of its notebooks.
* The page is a normal workspace Page (``content_seed.create_note_with_item``,
  owned by the workspace's owner), with "Copied from a note on 9 Nov" at the
  top, the note as Markdown (``convert.note_markdown``) and its pictures
  copied in as the page's own images, so they work for everyone in the
  workspace and survive the note. Recordings aren't copied (a Page has no
  player for them); their words are, when there are any.
"""
from __future__ import annotations

import os
import shutil
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from .models import Note, NoteAttachment

MAX_PICTURES = 30


async def targets(db: AsyncSession, user: User) -> list[dict[str, Any]]:
    """Workspaces you can add a page to, with their notebooks."""
    from app.chat.models import Workspace, WorkspaceItem
    from app.chat.models import WorkspaceShare
    from app.workspaces.shares import normalize_share_role

    own = list((await db.execute(select(Workspace).where(Workspace.user_id == user.id, Workspace.trashed_at.is_(None)))).scalars())
    shared = (
        await db.execute(
            select(Workspace, WorkspaceShare.role)
            .join(WorkspaceShare, WorkspaceShare.workspace_id == Workspace.id)
            .where(WorkspaceShare.invitee_user_id == user.id, WorkspaceShare.status == "accepted", Workspace.trashed_at.is_(None))
        )
    ).all()
    rows = [(w, "owner") for w in own] + [(w, normalize_share_role(r)) for w, r in shared if normalize_share_role(r) != "viewer"]
    if not rows:
        return []
    ids = [w.id for w, _ in rows]
    books: dict[uuid.UUID, list[dict[str, str]]] = {}
    for it in (
        await db.execute(
            select(WorkspaceItem)
            .where(WorkspaceItem.workspace_id.in_(ids), WorkspaceItem.kind == "container")
            .order_by(WorkspaceItem.position, WorkspaceItem.title)
        )
    ).scalars():
        books.setdefault(it.workspace_id, []).append({"id": str(it.id), "title": it.title})
    seen: set[uuid.UUID] = set()
    out = []
    for w, role in sorted(rows, key=lambda r: (r[0].title or "").casefold()):
        if w.id in seen:
            continue
        seen.add(w.id)
        out.append({"id": str(w.id), "title": w.title or "Workspace", "role": role, "notebooks": books.get(w.id, [])})
    return out


def _when(at: datetime) -> str:
    return f"{at.day} {at:%b}"


async def _pictures(db: AsyncSession, note: Note) -> list[Any]:
    from app.files.models import UserFile

    from .attachments import live_join

    return list(
        (
            await db.execute(
                select(UserFile)
                .join(NoteAttachment, live_join())
                .where(NoteAttachment.note_id == note.id, NoteAttachment.kind == "image")
                .order_by(NoteAttachment.position)
                .limit(MAX_PICTURES)
            )
        ).scalars()
    )


def _copy_as_asset(src: Any, doc: Any) -> Any | None:
    """One picture → an image of the page (its own copy). None if the bytes
    are gone."""
    from app.files.generated_kinds import GeneratedKind
    from app.files.models import UserFile
    from app.files.storage import absolute_path, storage_path_for

    src_path = absolute_path(src.storage_path)
    if not src_path.exists() or not str(src.mime_type or "").startswith("image/"):
        return None
    new_id = uuid.uuid4()
    storage = storage_path_for(doc.user_id, new_id, os.path.splitext(src.filename or "")[1].lower() or ".jpg")
    dest = absolute_path(storage)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src_path, dest)
    return UserFile(
        id=new_id, user_id=doc.user_id, folder_id=None, filename=src.filename, original_filename=src.filename,
        mime_type=src.mime_type, size_bytes=src.size_bytes, storage_path=storage,
        source_kind=GeneratedKind.DOCUMENT_ASSET.value, source_file_id=doc.id, content_sha256=src.content_sha256,
        sha1=src.sha1, md5=src.md5, verified_at=src.verified_at,
    )


async def copy(db: AsyncSession, user: User, note: Note, workspace_id: uuid.UUID, parent_id: uuid.UUID | None) -> dict[str, Any]:
    """The copy (flushed, not committed). Returns where it went."""
    import asyncio

    from app.chat.models import WorkspaceItem
    from app.files.doc_assets import stable_path
    from app.files.document_render import extract_text_from_html
    from app.files.models import DocumentState
    from app.files.storage import absolute_path
    from app.workspaces.content_seed import create_note_with_item, render_note_markdown
    from app.workspaces.shares import get_accessible_workspace, require_workspace_write

    from . import service
    from .ai import transcripts
    from .convert import note_markdown

    if note.owner_id != user.id:
        raise service.forbidden("Only the note's owner can copy it to a workspace.")
    ws, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(role)
    if parent_id is not None:
        book = await db.get(WorkspaceItem, parent_id)
        if book is None or book.workspace_id != ws.id or book.kind not in ("container", "folder"):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That notebook isn't in this workspace.")
    owner = await db.get(User, ws.user_id)
    if owner is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")

    items = await service.items_of(db, note.id)
    head = f"*Copied from a note on {_when(datetime.now(timezone.utc))}*\n\n"
    body = note_markdown(note, items)
    said = await transcripts(db, note)
    if said:
        body += "\n" + "\n\n".join(f"> {line}" for line in said) + "\n"
    title = service.display_title(note)[:200]
    item = await create_note_with_item(db, ws=ws, owner=owner, creator_id=user.id, title=title, markdown=head + body, parent_id=parent_id)

    pictures = await _pictures(db, note)
    if pictures:
        from app.files.models import UserFile

        doc = await db.get(UserFile, item.ref_id)
        lines = []
        for src in pictures:
            asset = await asyncio.to_thread(_copy_as_asset, src, doc)
            if asset is None:
                continue
            db.add(asset)
            await db.flush()
            lines.append(f"![{(src.filename or 'Picture').replace(']', '')}]({stable_path(doc.id, asset.id)})")
        if lines:
            md = head + "\n\n".join(lines) + "\n\n" + body
            update, html, text_ = await asyncio.to_thread(render_note_markdown, md)
            ds = await db.get(DocumentState, doc.id)
            if ds is not None:
                ds.yjs_update = update
                ds.version = (ds.version or 0) + 1
            doc.content_text = text_ or extract_text_from_html(html) or None
            with open(absolute_path(doc.storage_path), "w", encoding="utf-8") as f:
                f.write(html)
            doc.size_bytes = len(html.encode("utf-8"))
    await db.flush()
    return {
        "workspace_id": str(ws.id),
        "workspace": ws.title or "Workspace",
        "item_id": str(item.id),
        "title": title,
        "href": f"/workspaces/{ws.id}?item={item.id}&kind=note&ref={item.ref_id}",
    }


__all__ = ["copy", "targets"]
