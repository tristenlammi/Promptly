"""Pick up where you left off: what each person opened lately, across apps.

One row per (person, kind, thing) in ``recent_opens`` — upserted when they
open it, at most :data:`CAP` per person (the oldest fall off). Kinds:

* ``document`` / ``sheet`` / ``whiteboard`` (whiteboards hold slides too) —
  recorded server-side when the office editor's page loads
  (``files/office_router.py``);
* ``file`` (an uploaded file's preview) and ``item`` (an Item Store file) —
  the client posts ``file``; it's filed under the file's real kind here;
* ``chat``, ``room``, ``workspace_item`` — the client posts on open.

Every read re-checks that the viewer can still open each one (shares
revoked, things trashed or deleted drop out — and their rows go) and
refreshes the title. A burst of opens of the same thing writes once
(:data:`DEBOUNCE`). Nothing here ever shows another person's opens.

    GET    /api/today/recents              newest first, ?limit=
    POST   /api/today/recents              {kind, id} — "I opened this"
    DELETE /api/today/recents              clear all of mine
    DELETE /api/today/recents/{kind}/{id}  forget one
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import and_, delete, literal_column, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from .models import RecentOpen

logger = logging.getLogger("promptly.today.recents")

UTC = timezone.utc
CAP = 50
DEBOUNCE = timedelta(seconds=30)
OFFICE = ("document", "sheet", "whiteboard")
FILE_KINDS = (*OFFICE, "file", "item")
KINDS = (*FILE_KINDS, "chat", "room", "workspace_item")
PostKind = Literal["document", "sheet", "whiteboard", "file", "item", "chat", "room", "workspace_item"]

router = APIRouter()


# ------------------------------------------------------------------ resolving


def _stem(name: str, suffixes: tuple[str, ...]) -> str:
    low = (name or "").lower()
    for s in suffixes:
        if low.endswith(s):
            return name[: -len(s)] or "Untitled"
    return name or "Untitled"


def office_title(filename: str | None) -> str:
    """A doc / sheet / whiteboard's title from its shell's file name."""
    return _stem(filename or "", (".sheet", ".whiteboard", ".html", ".md", ".docx"))


def _file_icon(mime: str | None) -> str:
    m = (mime or "").lower()
    if m.startswith("image/"):
        return "image"
    if m.startswith("video/"):
        return "video"
    if m.startswith("audio/"):
        return "audio"
    if m == "application/pdf":
        return "pdf"
    return "file"


async def _resolve_file(db: AsyncSession, user: User, file_id: uuid.UUID) -> dict | None:
    from app.files.models import UserFile
    from app.files.office import get_office_access

    row = await db.get(UserFile, file_id)
    if row is None or row.trashed_at is not None:
        return None
    sk = row.source_kind
    if sk in OFFICE:
        if await get_office_access(db, row, user) == "none":
            return None
        seg = "doc" if sk == "document" else sk
        title = office_title(row.filename)
        label = {"document": "Doc", "sheet": "Sheet", "whiteboard": "Whiteboard"}[sk]
        return {"kind": sk, "title": title, "detail": label, "url": f"/files/{seg}/{row.id}", "icon": sk}
    if sk == "item":
        from app.items import service as items
        from app.items.registry import get_spec

        try:
            _row, doc, _access = await items.load(db, user, row.id)
        except items.ItemNotFound:
            return None
        spec = get_spec(doc.kind)
        return {
            "kind": "item", "title": items.title_of(row), "detail": spec.name if spec else "App",
            "url": f"/apps/{doc.kind}/{row.id}", "icon": doc.kind,
        }
    from app.files.generated_kinds import HIDDEN_KINDS
    from app.files.router import _can_still_open

    if sk in HIDDEN_KINDS:
        return None
    if row.user_id != user.id and not await _can_still_open(db, row, user):
        return None
    return {"kind": "file", "title": row.filename or "Untitled", "detail": "File", "url": f"/files/f/{row.id}", "icon": _file_icon(row.mime_type)}


async def _resolve_chat(db: AsyncSession, user: User, conv_id: uuid.UUID) -> dict | None:
    from app.chat.shares import get_accessible_conversation

    try:
        conv, _role = await get_accessible_conversation(conv_id, user, db)
    except HTTPException:
        return None
    if getattr(conv, "trashed_at", None) is not None or getattr(conv, "deleted_at", None) is not None:
        return None
    if conv.expires_at is not None:  # a temporary chat — gone soon, never "recent"
        return None
    return {"kind": "chat", "title": conv.title or "New chat", "detail": "Chat", "url": f"/chat/{conv.id}", "icon": "chat"}


async def _resolve_room(db: AsyncSession, user: User, room_id: uuid.UUID) -> dict | None:
    from app.rooms.core import load_room
    from app.rooms.models import RoomMember, RoomSpace

    try:
        room, _sm = await load_room(db, room_id, user)
    except HTTPException:
        return None
    if getattr(room, "trashed_at", None) is not None or getattr(room, "archived_at", None) is not None:
        return None
    if room.space_id is not None:
        space = await db.get(RoomSpace, room.space_id)
        return {
            "kind": "room", "title": f"#{room.name or 'room'}", "detail": space.name if space else "Rooms",
            "url": f"/rooms/r/{room.id}", "icon": "room",
        }
    if room.name:
        name = room.name
    else:
        people = sorted(
            (
                await db.execute(
                    select(User.username)
                    .join(RoomMember, RoomMember.user_id == User.id)
                    .where(RoomMember.room_id == room.id, RoomMember.user_id != user.id)
                )
            ).scalars()
        )
        name = ", ".join(people[:3]) + (f" +{len(people) - 3}" if len(people) > 3 else "") or "Direct message"
    return {
        "kind": "room", "title": name, "detail": "Direct message" if room.kind == "dm" else "Group",
        "url": f"/rooms/r/{room.id}", "icon": "dm",
    }


async def _resolve_workspace_item(db: AsyncSession, user: User, item_id: uuid.UUID) -> dict | None:
    from app.chat.models import WorkspaceItem
    from app.workspaces.shares import get_accessible_workspace

    item = await db.get(WorkspaceItem, item_id)
    if item is None or item.trashed_at is not None or item.kind == "folder":
        return None
    if item.visibility == "private" and item.created_by != user.id:
        return None
    try:
        ws, _role = await get_accessible_workspace(item.workspace_id, user, db)
    except HTTPException:
        return None
    return {
        "kind": "workspace_item", "title": item.title or "Untitled", "detail": ws.title or "Workspace",
        "url": f"/workspaces/{ws.id}?item={item.id}", "icon": item.kind,
    }


async def resolve(db: AsyncSession, user: User, kind: str, entity_id: uuid.UUID) -> dict | None:
    """What ``user`` would see for this thing now — title, where it lives,
    a link — or None when they can't open it (or it's gone). For file kinds
    the answer's ``kind`` is the file's real one."""
    try:
        if kind in FILE_KINDS:
            return await _resolve_file(db, user, entity_id)
        if kind == "chat":
            return await _resolve_chat(db, user, entity_id)
        if kind == "room":
            return await _resolve_room(db, user, entity_id)
        if kind == "workspace_item":
            return await _resolve_workspace_item(db, user, entity_id)
    except Exception:  # noqa: BLE001 — one odd entry mustn't break the strip
        logger.warning("resolving recent %s %s failed", kind, entity_id, exc_info=True)
    return None


# ------------------------------------------------------------------ writing


async def _prune(db: AsyncSession, user_id: uuid.UUID, cap: int = CAP) -> None:
    keep = (
        select(RecentOpen.kind, RecentOpen.entity_id)
        .where(RecentOpen.user_id == user_id)
        .order_by(RecentOpen.opened_at.desc())
        .limit(cap)
    )
    await db.execute(
        delete(RecentOpen).where(
            RecentOpen.user_id == user_id,
            tuple_(RecentOpen.kind, RecentOpen.entity_id).not_in(keep),
        )
    )


async def touch(db: AsyncSession, user_id: uuid.UUID, kind: str, entity_id: uuid.UUID, title: str, *, now: datetime | None = None) -> None:
    """Upsert one open (no access check — callers already did). Within
    :data:`DEBOUNCE` of the last open it's a no-op; a new row trims the
    person's list to :data:`CAP`. Doesn't commit; never raises."""
    now = now or datetime.now(UTC)
    stmt = (
        insert(RecentOpen)
        .values(user_id=user_id, kind=kind, entity_id=entity_id, title=(title or "")[:300], opened_at=now)
        .on_conflict_do_update(
            index_elements=["user_id", "kind", "entity_id"],
            set_={"opened_at": now, "title": (title or "")[:300]},
            where=RecentOpen.opened_at < now - DEBOUNCE,
        )
        .returning(literal_column("xmax = 0"))
    )
    try:
        async with db.begin_nested():
            inserted = (await db.execute(stmt)).scalar()
            if inserted:
                await _prune(db, user_id)
    except Exception:  # noqa: BLE001
        logger.warning("recent open not recorded", exc_info=True)


async def record(db: AsyncSession, user: User, kind: str, entity_id: uuid.UUID) -> dict | None:
    """Check ``user`` can open it, then :func:`touch`. Returns what was
    recorded (None when it can't be opened). Doesn't commit."""
    got = await resolve(db, user, kind, entity_id)
    if got is None:
        return None
    await touch(db, user.id, got["kind"], entity_id, got["title"])
    return got


async def recent(db: AsyncSession, user: User, limit: int = 12) -> list[dict[str, Any]]:
    """The newest ``limit`` things ``user`` can still open. Entries they
    can't (or that are gone) are deleted; stale titles are refreshed.
    Commits only when something changed."""
    rows = list(
        (
            await db.execute(
                select(RecentOpen).where(RecentOpen.user_id == user.id).order_by(RecentOpen.opened_at.desc()).limit(CAP)
            )
        ).scalars()
    )
    out: list[dict[str, Any]] = []
    dead: list[tuple[str, uuid.UUID]] = []
    changed = False
    for r in rows:
        if len(out) >= limit:
            break
        got = await resolve(db, user, r.kind, r.entity_id)
        if got is None or got["kind"] != r.kind:
            dead.append((r.kind, r.entity_id))
            continue
        if got["title"][:300] != r.title:
            r.title = got["title"][:300]
            changed = True
        out.append({**got, "id": str(r.entity_id), "opened_at": r.opened_at.isoformat()})
    if dead:
        await db.execute(
            delete(RecentOpen).where(
                RecentOpen.user_id == user.id,
                tuple_(RecentOpen.kind, RecentOpen.entity_id).in_(dead),
            )
        )
        changed = True
    if changed:
        await db.commit()
    return out


async def clear(db: AsyncSession, user_id: uuid.UUID, kind: str | None = None, entity_id: uuid.UUID | None = None) -> int:
    conds = [RecentOpen.user_id == user_id]
    if kind is not None and entity_id is not None:
        conds += [RecentOpen.kind == kind, RecentOpen.entity_id == entity_id]
    res = await db.execute(delete(RecentOpen).where(and_(*conds)))
    await db.commit()
    return int(res.rowcount or 0)


# ------------------------------------------------------------------ routes


class OpenIn(BaseModel):
    kind: PostKind
    id: uuid.UUID


@router.get("")
async def list_recent(
    limit: int = Query(12, ge=1, le=CAP),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return {"items": await recent(db, user, limit)}


@router.post("", status_code=status.HTTP_204_NO_CONTENT)
async def opened(body: OpenIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    """"I opened this." Quietly ignored when it can't be opened."""
    if await record(db, user, body.kind, body.id) is not None:
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def clear_all(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    await clear(db, user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{kind}/{entity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def forget(kind: str, entity_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    await clear(db, user.id, kind, entity_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["CAP", "KINDS", "clear", "office_title", "recent", "record", "resolve", "router", "touch"]
