"""Comments on every office file (WP-4.5 for documents, WP-6.1 for sheets
and whiteboards; R-227).

A comment thread belongs to the *file* — a Drive document or a note's
backing document, a Sheet, a Whiteboard (Drive or workspace) — and is
anchored where it points:

* a document: two Yjs relative positions the editor resolves and highlights;
* a sheet: a cell (tab id + row / column, the A1 reference for display);
* a whiteboard: the ids of the shapes it's about.

The routes live under ``/api/documents/{file_id}/comments`` for all three
(the documents URL predates the others).

Who may do what — one answer, from :func:`get_office_access`:

* read the threads: anyone who can open the document;
* comment, reply, resolve: anyone who can edit it (a workspace editor or
  above for notes, an edit grant for Drive documents);
* edit a comment: its author; delete: its author, the document's owner,
  or the note's workspace owner / admin.

@-mentions notify people who can open the document; a reply notifies the
thread's earlier participants. Live updates ride on the collab room (the
editor sends a stateless "comments changed" ping after each change).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.generated_kinds import GeneratedKind
from app.files.models import DocumentComment, UserFile

logger = logging.getLogger("promptly.files.doc_comments")

router = APIRouter()

_MAX_ANCHOR = 2048


class CommentAuthor(BaseModel):
    user_id: uuid.UUID
    username: str
    avatar_url: str | None = None
    avatar_color: str | None = None


class DocComment(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    author: CommentAuthor | None
    body: str
    quote: str | None
    anchor: dict | None
    resolved_at: datetime | None
    resolved_by: str | None = None
    edited_at: datetime | None
    created_at: datetime
    can_edit: bool
    can_delete: bool


class DocCommentList(BaseModel):
    comments: list[DocComment]
    can_comment: bool


class DocCommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=10_000)
    quote: str | None = Field(default=None, max_length=2000)
    # {"from": base64 relpos, "to": base64 relpos}
    anchor: dict | None = None
    parent_id: uuid.UUID | None = None


class DocCommentEdit(BaseModel):
    body: str = Field(min_length=1, max_length=10_000)


class DocCommentResolve(BaseModel):
    resolved: bool


class Person(BaseModel):
    user_id: uuid.UUID
    username: str
    avatar_url: str | None = None
    avatar_color: str | None = None


# ------------------------------------------------------------------ access


_KINDS = (GeneratedKind.DOCUMENT.value, GeneratedKind.SHEET.value, GeneratedKind.WHITEBOARD.value)


async def _document(db: AsyncSession, document_id: uuid.UUID, user: User) -> tuple[UserFile, str]:
    """The office file (document, sheet or whiteboard) and the caller's
    access ("read" / "edit"); 404 if none."""
    from app.files.office import get_office_access

    row = await db.get(UserFile, document_id)
    if row is None or row.source_kind not in _KINDS or row.trashed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    access = await get_office_access(db, row, user)
    if access == "none":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    return row, access


async def _note_item(db: AsyncSession, row: UserFile):
    """The workspace item this file is — a note backed by this document,
    or the sheet / canvas whose content this shell holds."""
    from app.chat.models import WorkspaceItem

    if row.source_kind == GeneratedKind.DOCUMENT.value:
        return (
            await db.execute(
                select(WorkspaceItem).where(WorkspaceItem.ref_id == row.id, WorkspaceItem.kind == "note").limit(1)
            )
        ).scalars().first()
    from app.files.office import _workspace_item_for, content_for_shell

    entity = await content_for_shell(db, row)
    if entity is None or getattr(entity, "workspace_id", None) is None:
        return None
    return await _workspace_item_for(db, entity, row.source_kind)


async def _moderator(db: AsyncSession, row: UserFile, user: User) -> bool:
    """Owner of the document, or owner / admin of the note's workspace."""
    if row.user_id == user.id:
        return True
    item = await _note_item(db, row)
    if item is None:
        return False
    from app.workspaces.shares import get_accessible_workspace

    try:
        _ws, role = await get_accessible_workspace(item.workspace_id, user, db)
    except HTTPException:
        return False
    return role in ("owner", "admin")


def _clean_anchor(anchor: dict | None, kind: str | None = GeneratedKind.DOCUMENT.value) -> dict | None:
    """Keep only a well-formed anchor for this kind of file; anything else
    is dropped (the comment then sits on the file as a whole)."""
    if not isinstance(anchor, dict):
        return None
    if kind == GeneratedKind.SHEET.value:
        sheet, r, c = anchor.get("sheet"), anchor.get("r"), anchor.get("c")
        if not isinstance(sheet, str) or not sheet or len(sheet) > 64:
            return None
        if not all(isinstance(x, int) and not isinstance(x, bool) for x in (r, c)):
            return None
        if not (0 <= r < 1_000_000 and 0 <= c < 16_384):
            return None
        out: dict = {"kind": "cell", "sheet": sheet, "r": r, "c": c}
        # The tab's name too, for a tab whose id changed (an imported
        # workbook gets fresh ids until it's first saved).
        tab = anchor.get("tab")
        if isinstance(tab, str) and 0 < len(tab) <= 100:
            out["tab"] = tab
        return out
    if kind == GeneratedKind.WHITEBOARD.value:
        ids = anchor.get("ids")
        if not isinstance(ids, list):
            return None
        ids = [i for i in ids if isinstance(i, str) and 0 < len(i) <= 64][:20]
        return {"kind": "element", "ids": ids} if ids else None
    out = {}
    for key in ("from", "to"):
        val = anchor.get(key)
        if not isinstance(val, str) or not val or len(val) > _MAX_ANCHOR:
            return None
        out[key] = val
    return out


async def _people(db: AsyncSession, row: UserFile) -> list[User]:
    """Everyone who can open the document: its owner, people it (or a
    folder above it) is shared with, and — for a note — the workspace."""
    from app.files.models import ResourceGrant
    from app.files.sharing import ancestor_folder_ids

    ids: set[uuid.UUID] = set()
    if row.user_id:
        ids.add(row.user_id)
    folders = await ancestor_folder_ids(db, row.folder_id) if row.folder_id else []
    cond = (ResourceGrant.resource_type == "file") & (ResourceGrant.resource_id == row.id)
    if folders:
        cond = cond | ((ResourceGrant.resource_type == "folder") & ResourceGrant.resource_id.in_(folders))
    grants = (await db.execute(select(ResourceGrant.grantee_user_id).where(cond))).scalars().all()
    ids.update(g for g in grants if g)
    item = await _note_item(db, row)
    if item is not None:
        from app.chat.models import Workspace
        from app.workspaces.shares import load_workspace_participants

        ws = await db.get(Workspace, item.workspace_id)
        if ws is not None:
            parts = await load_workspace_participants(ws, db)
            ids.update(p.user_id for p in [parts.owner, *parts.collaborators])
    if not ids:
        return []
    users = (await db.execute(select(User).where(User.id.in_(ids)))).scalars().all()
    return sorted(users, key=lambda u: (u.username or "").lower())


_EDITOR_SEG = {
    GeneratedKind.DOCUMENT.value: "doc",
    GeneratedKind.SHEET.value: "sheet",
    GeneratedKind.WHITEBOARD.value: "whiteboard",
}


async def _link(db: AsyncSession, row: UserFile, comment_id: uuid.UUID) -> str:
    item = await _note_item(db, row)
    if item is not None:
        return f"/workspaces/{item.workspace_id}?item={item.id}&comment={comment_id}"
    return f"/files/{_EDITOR_SEG.get(row.source_kind or '', 'doc')}/{row.id}?comment={comment_id}"


def _title(row: UserFile) -> str:
    name = (row.filename or "a document").rsplit(".", 1)[0]
    return name or "a document"


async def _notify(db: AsyncSession, row: UserFile, comment: DocumentComment, author: User) -> None:
    """@-mentions (people who can open the document) and, for a reply, the
    thread's earlier participants. Best-effort."""
    try:
        from app.notifications import notify_user
        from app.workspaces.mentions import extract_mention_handles

        people = await _people(db, row)
        by_handle = {(u.username or "").lower(): u for u in people}
        url = await _link(db, row, comment.parent_id or comment.id)
        snippet = comment.body.strip()
        if len(snippet) > 140:
            snippet = snippet[:139] + "…"
        title = _title(row)
        told: set[uuid.UUID] = {author.id}
        for handle in extract_mention_handles(comment.body):
            target = by_handle.get(handle)
            if target is None or target.id in told:
                continue
            told.add(target.id)
            await notify_user(
                user_id=target.id,
                category="mention",
                title=f"{author.username} mentioned you in a comment on “{title}”",
                body=snippet,
                url=url,
                tag=f"promptly-doc-comment-{row.id}",
                actor_user_id=author.id,
            )
        if comment.parent_id is not None:
            thread = (
                await db.execute(
                    select(DocumentComment.author_user_id).where(
                        (DocumentComment.id == comment.parent_id) | (DocumentComment.parent_id == comment.parent_id)
                    )
                )
            ).scalars().all()
            allowed = {u.id for u in people}
            for uid in dict.fromkeys(thread):
                if uid is None or uid in told or uid not in allowed:
                    continue
                told.add(uid)
                await notify_user(
                    user_id=uid,
                    category="mention",
                    title=f"{author.username} replied to a comment on “{title}”",
                    body=snippet,
                    url=url,
                    tag=f"promptly-doc-comment-{row.id}",
                    actor_user_id=author.id,
                )
    except Exception:  # pragma: no cover — never fail the comment for a notification
        logger.warning("comment notification failed", exc_info=True)


async def _to_out(
    db: AsyncSession, rows: list[DocumentComment], user: User, *, moderator: bool
) -> list[DocComment]:
    ids = {r.author_user_id for r in rows if r.author_user_id} | {r.resolved_by for r in rows if r.resolved_by}
    users = {u.id: u for u in (await db.execute(select(User).where(User.id.in_(ids)))).scalars().all()} if ids else {}
    out = []
    for r in rows:
        a = users.get(r.author_user_id) if r.author_user_id else None
        out.append(
            DocComment(
                id=r.id,
                parent_id=r.parent_id,
                author=CommentAuthor(user_id=a.id, username=a.username, avatar_url=a.avatar_url, avatar_color=a.avatar_color)
                if a
                else None,
                body=r.body,
                quote=r.quote,
                anchor=r.anchor,
                resolved_at=r.resolved_at,
                resolved_by=users[r.resolved_by].username if r.resolved_by in users else None,
                edited_at=r.edited_at,
                created_at=r.created_at,
                can_edit=r.author_user_id == user.id,
                can_delete=r.author_user_id == user.id or moderator,
            )
        )
    return out


# ------------------------------------------------------------------ routes


@router.get("/{document_id}/comments", response_model=DocCommentList)
async def list_comments(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DocCommentList:
    row, access = await _document(db, document_id, user)
    rows = (
        await db.execute(
            select(DocumentComment).where(DocumentComment.file_id == row.id).order_by(DocumentComment.created_at)
        )
    ).scalars().all()
    moderator = await _moderator(db, row, user)
    return DocCommentList(comments=await _to_out(db, list(rows), user, moderator=moderator), can_comment=access in ("comment", "edit"))


@router.get("/{document_id}/comments/people", response_model=list[Person])
async def comment_people(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Person]:
    """Who an @-mention can reach (people who can open the document)."""
    row, _access = await _document(db, document_id, user)
    return [
        Person(user_id=u.id, username=u.username, avatar_url=u.avatar_url, avatar_color=u.avatar_color)
        for u in await _people(db, row)
        if not u.disabled
    ]


@router.post("/{document_id}/comments", response_model=DocComment, status_code=status.HTTP_201_CREATED)
async def create_comment(
    document_id: uuid.UUID,
    payload: DocCommentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DocComment:
    row, access = await _document(db, document_id, user)
    if access not in ("comment", "edit"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can view this file but not comment on it.")
    parent_id = None
    if payload.parent_id is not None:
        parent = await db.get(DocumentComment, payload.parent_id)
        if parent is None or parent.file_id != row.id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That comment no longer exists.")
        parent_id = parent.parent_id or parent.id  # replies hang off the thread's root
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Write something first.")
    comment = DocumentComment(
        file_id=row.id,
        parent_id=parent_id,
        author_user_id=user.id,
        body=body,
        quote=None if parent_id else ((payload.quote or "").strip() or None),
        anchor=None if parent_id else _clean_anchor(payload.anchor, row.source_kind),
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    await _notify(db, row, comment, user)
    moderator = await _moderator(db, row, user)
    return (await _to_out(db, [comment], user, moderator=moderator))[0]


@router.patch("/{document_id}/comments/{comment_id}", response_model=DocComment)
async def edit_comment(
    document_id: uuid.UUID,
    comment_id: uuid.UUID,
    payload: DocCommentEdit,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DocComment:
    row, _access = await _document(db, document_id, user)
    comment = await db.get(DocumentComment, comment_id)
    if comment is None or comment.file_id != row.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That comment no longer exists.")
    if comment.author_user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only its author can edit a comment.")
    comment.body = payload.body.strip()
    comment.edited_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(comment)
    moderator = await _moderator(db, row, user)
    return (await _to_out(db, [comment], user, moderator=moderator))[0]


@router.post("/{document_id}/comments/{comment_id}/resolve", response_model=DocComment)
async def resolve_comment(
    document_id: uuid.UUID,
    comment_id: uuid.UUID,
    payload: DocCommentResolve,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DocComment:
    row, access = await _document(db, document_id, user)
    if access not in ("comment", "edit"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can view this file but not resolve comments.")
    comment = await db.get(DocumentComment, comment_id)
    if comment is None or comment.file_id != row.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That comment no longer exists.")
    root = comment if comment.parent_id is None else await db.get(DocumentComment, comment.parent_id)
    if root is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That comment no longer exists.")
    root.resolved_at = datetime.now(timezone.utc) if payload.resolved else None
    root.resolved_by = user.id if payload.resolved else None
    await db.commit()
    await db.refresh(root)
    moderator = await _moderator(db, row, user)
    return (await _to_out(db, [root], user, moderator=moderator))[0]


@router.delete("/{document_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(
    document_id: uuid.UUID,
    comment_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    row, _access = await _document(db, document_id, user)
    comment = await db.get(DocumentComment, comment_id)
    if comment is None or comment.file_id != row.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That comment no longer exists.")
    if comment.author_user_id != user.id and not await _moderator(db, row, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only its author or the file's owner can delete a comment.",
        )
    await db.delete(comment)  # a thread's replies go with it (FK cascade)
    await db.commit()


# ------------------------------------------------------------------ mentions

class MentionNotify(BaseModel):
    user_id: uuid.UUID


# (document, person) → when they were last told, so retyping a mention
# doesn't spam them. In-process is fine — the backend is a single worker.
_RECENT_MENTIONS: dict[tuple[uuid.UUID, uuid.UUID], float] = {}
_MENTION_QUIET_SECONDS = 600


@router.post("/{document_id}/mentions", status_code=status.HTTP_204_NO_CONTENT)
async def notify_mention(
    document_id: uuid.UUID,
    payload: MentionNotify,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """Someone @-mentioned a person in a document or note (WP-4.6, R-232):
    tell them — if they can open it, at most once every ten minutes per
    document, and never yourself."""
    import time

    row, access = await _document(db, document_id, user)
    if access != "edit" or payload.user_id == user.id:
        return None
    people = {u.id: u for u in await _people(db, row)}
    target = people.get(payload.user_id)
    if target is None or getattr(target, "disabled", False):
        return None
    key = (row.id, target.id)
    now = time.monotonic()
    if now - _RECENT_MENTIONS.get(key, -1e9) < _MENTION_QUIET_SECONDS:
        return None
    _RECENT_MENTIONS[key] = now
    try:
        from app.notifications import notify_user

        item = await _note_item(db, row)
        url = (
            f"/workspaces/{item.workspace_id}?item={item.id}"
            if item
            else f"/files/{_EDITOR_SEG.get(row.source_kind or '', 'doc')}/{row.id}"
        )
        await notify_user(
            user_id=target.id,
            category="mention",
            title=f"{user.username} mentioned you in “{_title(row)}”",
            body="Open it to see where.",
            url=url,
            tag=f"promptly-doc-mention-{row.id}",
            actor_user_id=user.id,
            workspace_id=item.workspace_id if item else None,
        )
    except Exception:  # pragma: no cover — a notification never fails the editor
        logger.warning("mention notification failed", exc_info=True)
    return None
