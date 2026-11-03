"""One trash across apps — listing, restore, delete forever, retention.

Two kinds of deleted thing are shown together:

* **in place** — rows that already soft-delete with ``trashed_at``: Drive
  files and folders (Item Store files and photos are Drive files),
  workspaces and workspace items. Restore / purge go through each app's
  own endpoint code, so the rules (nearest live parent, workspace-owned
  files, blob tombstones, RAG chunk purge) stay in one place.
* **snapshots** (:class:`~app.trash.models.TrashEntry`) — things whose app
  hard-deletes: calendar events, albums, and tasks / contacts inside item
  files. The app deletes as before; a copy of what went is kept here.

Everything leaves the trash 30 days after it was deleted (the nightly
storage maintenance), matching Drive's and workspaces' existing rule.
"""
from __future__ import annotations

import copy
import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, Request, status
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from .models import TrashEntry

logger = logging.getLogger("promptly.trash")

RETENTION_DAYS = 30

# Snapshot kinds → the app they're grouped under.
ENTRY_APPS = {"calendar_event": "calendar", "album": "photos", "task": "tasks", "contact": "contacts"}

# Item kinds whose records are trashed one by one: item kind → (list key, trash kind).
ITEM_RECORDS = {"tasks": ("tasks", "task"), "contacts": ("contacts", "contact")}
# A runaway save (a whole list replaced) shouldn't write thousands of rows.
MAX_RECORDS_PER_SAVE = 2000


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _gone(detail: str = "That's no longer in the trash.") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


# ------------------------------------------------------------------ snapshots


def _plain(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    return v


def row_dict(obj: Any) -> dict[str, Any]:
    """Every column of an ORM row, JSON-safe."""
    return {c.key: _plain(getattr(obj, c.key)) for c in obj.__table__.columns}


def _revive(model: Any, data: dict[str, Any]) -> dict[str, Any]:
    """Column values for ``model`` from :func:`row_dict` output."""
    from sqlalchemy import DateTime

    out: dict[str, Any] = {}
    for c in model.__table__.columns:
        if c.key not in data:
            continue
        v = data[c.key]
        if v is not None:
            if isinstance(c.type, DateTime):
                v = datetime.fromisoformat(v)
            elif type(c.type).__name__ in ("UUID", "Uuid"):
                v = uuid.UUID(str(v))
        out[c.key] = v
    return out


async def _exists(db: AsyncSession, model: Any, pk: Any) -> bool:
    return pk is not None and await db.get(model, pk) is not None


def record(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    deleted_by: uuid.UUID | None,
    kind: str,
    title: str,
    source_id: str,
    container_id: uuid.UUID | None,
    location: str,
    payload: dict[str, Any],
) -> TrashEntry:
    entry = TrashEntry(
        user_id=user_id,
        deleted_by=deleted_by,
        kind=kind,
        title=(title or "Untitled")[:300],
        source_id=str(source_id)[:64],
        container_id=container_id,
        location=(location or "")[:300],
        payload=_plain(payload),
        deleted_at=_now(),
    )
    db.add(entry)
    return entry


# ------------------------------------------------------------------ calendar


async def trash_event(db: AsyncSession, ev: Any, user: User) -> TrashEntry:
    """Keep a copy of ``ev`` (and its guests) before it's deleted. It shows
    in the calendar owner's trash (the deleter's, for a shared calendar)."""
    from app.calendars.models import CalAttendee, CalCalendar

    cal = await db.get(CalCalendar, ev.calendar_id)
    atts = list((await db.execute(select(CalAttendee).where(CalAttendee.event_id == ev.id))).scalars())
    owner = cal.owner_id if cal is not None and cal.personal and cal.owner_id else user.id
    return record(
        db,
        user_id=owner,
        deleted_by=user.id,
        kind="calendar_event",
        title=ev.title,
        source_id=str(ev.id),
        container_id=ev.calendar_id,
        location=cal.name if cal is not None else "Calendar",
        payload={"event": row_dict(ev), "attendees": [row_dict(a) for a in atts]},
    )


async def _restore_event(db: AsyncSession, user: User, entry: TrashEntry) -> str:
    from app.calendars import core
    from app.calendars.models import CalAttendee, CalCalendar, CalEvent
    from app.photos.album_models import Album

    snap = dict(entry.payload.get("event") or {})
    ev_id = uuid.UUID(snap["id"])
    if await db.get(CalEvent, ev_id) is not None:
        raise _conflict("That event is already back on the calendar.")
    cal = await db.get(CalCalendar, entry.container_id) if entry.container_id else None
    m = await core.membership(db, cal.id, user.id) if cal is not None else None
    if cal is None or not core.can_write_calendar(m):
        # Its calendar is gone (or no longer yours to add to): your own.
        cal = await core.ensure_personal(db, user)
    kw = _revive(CalEvent, snap)
    kw["calendar_id"] = cal.id
    if not await _exists(db, User, kw.get("created_by")):
        kw["created_by"] = user.id
    if not await _exists(db, Album, kw.get("album_id")):
        kw["album_id"] = None
    db.add(CalEvent(**kw))
    await db.flush()
    for a in entry.payload.get("attendees") or []:
        akw = _revive(CalAttendee, a)
        if not await _exists(db, User, akw.get("user_id")):
            continue
        if not await _exists(db, User, akw.get("invited_by")):
            akw["invited_by"] = None
        akw["event_id"] = ev_id
        db.add(CalAttendee(**akw))
    await db.flush()
    return cal.name


# ------------------------------------------------------------------ albums


async def trash_album(db: AsyncSession, album: Any, user: User) -> TrashEntry:
    from app.photos.album_models import AlbumExclusion, AlbumItem, AlbumMember

    items = list((await db.execute(select(AlbumItem).where(AlbumItem.album_id == album.id))).scalars())
    members = list((await db.execute(select(AlbumMember).where(AlbumMember.album_id == album.id))).scalars())
    excl = list((await db.execute(select(AlbumExclusion).where(AlbumExclusion.album_id == album.id))).scalars())
    return record(
        db,
        user_id=album.owner_id,
        deleted_by=user.id,
        kind="album",
        title=album.title,
        source_id=str(album.id),
        container_id=None,
        location="Photos · Albums",
        payload={
            "album": row_dict(album),
            "items": [row_dict(x) for x in items],
            "members": [row_dict(x) for x in members],
            "exclusions": [row_dict(x) for x in excl],
        },
    )


async def _restore_album(db: AsyncSession, user: User, entry: TrashEntry) -> str:
    from app.files.models import UserFile
    from app.photos.album_models import Album, AlbumExclusion, AlbumItem, AlbumMember

    snap = dict(entry.payload.get("album") or {})
    album_id = uuid.UUID(snap["id"])
    if await db.get(Album, album_id) is not None:
        raise _conflict("That album is already back.")
    kw = _revive(Album, snap)
    if kw.get("owner_id") != user.id:
        raise _gone("Only the album's owner can restore it.")
    if not await _exists(db, UserFile, kw.get("cover_file_id")):
        kw["cover_file_id"] = None
    db.add(Album(**kw))
    await db.flush()
    for x in entry.payload.get("items") or []:
        ikw = _revive(AlbumItem, x)
        if not await _exists(db, UserFile, ikw.get("file_id")):
            continue  # that photo was deleted for good since
        if not await _exists(db, User, ikw.get("added_by")):
            ikw["added_by"] = None
        db.add(AlbumItem(**ikw))
    for x in entry.payload.get("members") or []:
        mkw = _revive(AlbumMember, x)
        if await _exists(db, User, mkw.get("user_id")):
            db.add(AlbumMember(**mkw))
    for x in entry.payload.get("exclusions") or []:
        ekw = _revive(AlbumExclusion, x)
        if await _exists(db, UserFile, ekw.get("file_id")):
            db.add(AlbumExclusion(**ekw))
    await db.flush()
    return "Photos · Albums"


# ------------------------------------------------------------------ item records


def _record_title(kind: str, rec: dict) -> str:
    if kind == "contact":
        from app.items.kinds.contacts.logic import display_name

        try:
            return display_name(rec) or "Contact"
        except Exception:  # noqa: BLE001
            return "Contact"
    return str(rec.get("title") or "Task")


async def capture_item_removals(
    db: AsyncSession,
    row: Any,
    item_kind: str,
    old: dict | None,
    new: dict | None,
    deleted_by: uuid.UUID | None,
) -> int:
    """A save of an item file dropped some tasks / contacts: keep each in the
    trash. One that comes back (the app's own Undo) leaves the trash."""
    spec = ITEM_RECORDS.get(item_kind)
    if spec is None:
        return 0
    key, kind = spec
    old_recs = [r for r in (old or {}).get(key) or [] if isinstance(r, dict) and r.get("id")]
    new_ids = {r.get("id") for r in (new or {}).get(key) or [] if isinstance(r, dict)}
    old_ids = {r["id"] for r in old_recs}
    back = [str(i) for i in new_ids - old_ids if i]
    if back:
        await db.execute(
            delete(TrashEntry).where(
                TrashEntry.container_id == row.id, TrashEntry.kind == kind, TrashEntry.source_id.in_(back)
            )
        )
    removed = [r for r in old_recs if r["id"] not in new_ids][:MAX_RECORDS_PER_SAVE]
    if not removed:
        return 0
    from app.items.service import title_of

    file_title = title_of(row)
    lists = {x.get("id"): x.get("name") for x in (old or {}).get("lists") or [] if isinstance(x, dict)}
    for r in removed:
        where = file_title
        if kind == "task" and lists.get(r.get("list_id")):
            where = f"{file_title} · {lists[r.get('list_id')]}"
        record(
            db,
            user_id=row.user_id,
            deleted_by=deleted_by,
            kind=kind,
            title=_record_title(kind, r),
            source_id=str(r["id"]),
            container_id=row.id,
            location=where,
            payload={"record": copy.deepcopy(r), "item_kind": item_kind},
        )
    return len(removed)


async def _restore_item_record(db: AsyncSession, user: User, entry: TrashEntry) -> str:
    from app.files.models import UserFile
    from app.items import service as items

    item_kind = entry.payload.get("item_kind") or ("tasks" if entry.kind == "task" else "contacts")
    key, _kind = ITEM_RECORDS[item_kind]
    rec = copy.deepcopy(entry.payload.get("record") or {})
    row = doc = None
    if entry.container_id is not None:
        f = await db.get(UserFile, entry.container_id)
        if f is not None and f.trashed_at is None:
            try:
                row, doc, _access = await items.load(db, user, f.id, need="edit", lock=True)
            except items.ItemNotFound:
                row = doc = None
    if row is None:
        # Its file is gone (or you can't edit it any more): your own one.
        try:
            own, _made = await items.open_app(db, user, item_kind)
        except items.ItemError as e:
            raise _conflict(str(e)) from e
        row, doc, _access = await items.load(db, user, own.id, need="edit", lock=True)
    data = copy.deepcopy(doc.data or {})
    recs = list(data.get(key) or [])
    if any(isinstance(r, dict) and r.get("id") == rec.get("id") for r in recs):
        await db.delete(entry)
        return items.title_of(row)
    if entry.kind == "task":
        if rec.get("list_id") not in {x.get("id") for x in data.get("lists") or []}:
            rec["list_id"] = "inbox"
    else:
        live = {r.get("id") for r in recs if isinstance(r, dict)}
        for rel in rec.get("relationships") or []:
            if rel.get("contact_id") and rel["contact_id"] not in live:
                rel["contact_id"] = None
    recs.append(rec)
    data[key] = recs
    try:
        await items.save_data(db, user, row, doc, data, base_revision=None, source="edit")
    except items.ItemError as e:
        raise _conflict(str(e)) from e
    await db.execute(delete(TrashEntry).where(TrashEntry.id == entry.id))
    return items.title_of(row)


# ------------------------------------------------------------------ entries


def _entry_visible(user: User):
    return or_(TrashEntry.user_id == user.id, TrashEntry.deleted_by == user.id)


async def _find_entry(db: AsyncSession, user: User, type_: str, id_: str) -> TrashEntry:
    """By trash id (``type='entry'``), or — for an app's Undo, which only
    knows what it deleted — by kind + the thing's own id (newest first)."""
    q = select(TrashEntry).where(_entry_visible(user))
    if type_ == "entry":
        try:
            q = q.where(TrashEntry.id == uuid.UUID(str(id_)))
        except ValueError:
            raise _gone() from None
    elif type_ in ENTRY_APPS:
        q = q.where(TrashEntry.kind == type_, TrashEntry.source_id == str(id_)).order_by(TrashEntry.deleted_at.desc())
    else:
        raise _gone()
    entry = (await db.execute(q.limit(1))).scalar_one_or_none()
    if entry is None:
        raise _gone()
    return entry


async def _restore_entry(db: AsyncSession, user: User, entry: TrashEntry) -> str:
    if entry.kind == "calendar_event":
        where = await _restore_event(db, user, entry)
    elif entry.kind == "album":
        where = await _restore_album(db, user, entry)
    else:
        return await _restore_item_record(db, user, entry)
    await db.execute(delete(TrashEntry).where(TrashEntry.id == entry.id))
    return where


# ------------------------------------------------------------------ listing


def _item(
    type_: str, id_: Any, app: str, kind: str, title: str, deleted_at: datetime | None,
    location: str | None = None, **extra: Any,
) -> dict[str, Any]:
    when = deleted_at or _now()
    return {
        "type": type_,
        "id": str(id_),
        "app": app,
        "kind": kind,
        "title": title,
        "deleted_at": when,
        "expires_at": when + timedelta(days=RETENTION_DAYS),
        "location": location or "",
        **extra,
    }


async def _writable_workspaces(db: AsyncSession, user: User) -> dict[uuid.UUID, tuple[Any, str]]:
    """Live workspaces the caller can delete content in → (workspace, role)."""
    from app.chat.models import Workspace, WorkspaceShare
    from app.workspaces.shares import normalize_share_role

    out: dict[uuid.UUID, tuple[Any, str]] = {}
    for ws in (await db.execute(select(Workspace).where(Workspace.user_id == user.id, Workspace.trashed_at.is_(None)))).scalars():
        out[ws.id] = (ws, "owner")
    shared = (
        await db.execute(
            select(Workspace, WorkspaceShare.role)
            .join(WorkspaceShare, WorkspaceShare.workspace_id == Workspace.id)
            .where(
                WorkspaceShare.invitee_user_id == user.id,
                WorkspaceShare.status == "accepted",
                Workspace.trashed_at.is_(None),
            )
        )
    ).all()
    for ws, role in shared:
        r = normalize_share_role(role)
        if r != "viewer" and ws.id not in out:
            out[ws.id] = (ws, r)
    return out


async def list_all(db: AsyncSession, user: User) -> list[dict[str, Any]]:
    """Everything in the caller's trash, newest first."""
    from app.chat.models import Workspace, WorkspaceItem
    from app.files.router import list_trash

    out: list[dict[str, Any]] = []

    # Drive (incl. Item Store files and photos) — Drive's own listing, so
    # the "top-level only" and workspace-owned rules match its Trash page.
    drive = await list_trash(scope="mine", limit=None, cursor=None, db=db, user=user)
    photo_ids: set[uuid.UUID] = set()
    if drive.files:
        from sqlalchemy import text

        photo_ids = set(
            (
                await db.execute(
                    text("SELECT file_id FROM photo_assets WHERE file_id = ANY(:ids)"),
                    {"ids": [f.id for f in drive.files]},
                )
            ).scalars()
        )
    for f in drive.folders:
        out.append(_item("folder", f.id, "drive", "folder", f.name, f.trashed_at, f.location))
    for f in drive.files:
        app = "photos" if f.id in photo_ids else ("apps" if f.source_kind == "item" else "drive")
        kind = "photo" if app == "photos" else ("item" if app == "apps" else "file")
        out.append(
            _item("file", f.id, app, kind, f.filename, f.trashed_at, f.location, mime_type=f.mime_type, size_bytes=f.size_bytes)
        )

    # Workspaces the caller owns.
    for ws in (
        await db.execute(select(Workspace).where(Workspace.user_id == user.id, Workspace.trashed_at.is_not(None)))
    ).scalars():
        out.append(_item("workspace", ws.id, "workspaces", "workspace", ws.title, ws.trashed_at, "Workspaces"))

    # Workspace items, in workspaces the caller can edit — the top of each
    # trashed subtree, and never someone else's private draft.
    spaces = await _writable_workspaces(db, user)
    if spaces:
        trashed = list(
            (
                await db.execute(
                    select(WorkspaceItem).where(
                        WorkspaceItem.workspace_id.in_(list(spaces)),
                        WorkspaceItem.trashed_at.is_not(None),
                    )
                )
            ).scalars()
        )
        ids = {it.id for it in trashed}
        children: dict[uuid.UUID, int] = {}
        for it in trashed:
            if it.parent_id in ids:
                children[it.parent_id] = children.get(it.parent_id, 0) + 1
        for it in trashed:
            if it.parent_id in ids:
                continue
            if it.visibility == "private" and it.created_by != user.id:
                continue
            ws = spaces[it.workspace_id][0]
            out.append(
                _item(
                    "workspace_item", it.id, "workspaces", it.kind, it.title, it.trashed_at, ws.title,
                    workspace_id=str(ws.id), count=children.get(it.id, 0),
                )
            )

    # Snapshots: calendar events, albums, tasks, contacts.
    for e in (
        await db.execute(select(TrashEntry).where(_entry_visible(user)).order_by(TrashEntry.deleted_at.desc()))
    ).scalars():
        out.append(_item("entry", e.id, ENTRY_APPS.get(e.kind, "other"), e.kind, e.title, e.deleted_at, e.location))

    out.sort(key=lambda x: x["deleted_at"], reverse=True)
    return out


# ------------------------------------------------------------------ restore / purge


async def restore(
    db: AsyncSession, user: User, request: Request | None, type_: str, id_: str, workspace_id: str | None = None
) -> str:
    """Put one thing back where it was (or at the top level when that's
    gone). Returns where it went. Commits."""
    from app.files import router as files
    from app.workspaces import items_router, router as workspaces

    if type_ == "file":
        r = await files.restore_file(file_id=uuid.UUID(id_), db=db, user=user)
        return r.location or "My files"
    if type_ == "folder":
        r = await files.restore_folder(folder_id=uuid.UUID(id_), db=db, user=user)
        return r.location or "My files"
    if type_ == "workspace":
        await workspaces.restore_workspace(workspace_id=uuid.UUID(id_), request=request, db=db, user=user)
        return "Workspaces"
    if type_ == "workspace_item":
        if not workspace_id:
            raise _gone()
        await items_router.restore_trashed_item(
            workspace_id=uuid.UUID(workspace_id), item_id=uuid.UUID(id_), db=db, user=user
        )
        from app.chat.models import Workspace

        ws = await db.get(Workspace, uuid.UUID(workspace_id))
        return ws.title if ws is not None else "Workspace"
    entry = await _find_entry(db, user, type_, id_)
    where = await _restore_entry(db, user, entry)
    await db.commit()
    return where


async def purge(
    db: AsyncSession, user: User, request: Request | None, type_: str, id_: str, workspace_id: str | None = None
) -> int:
    """Delete one trashed thing for good. Returns how many went. Commits."""
    from app.files import router as files
    from app.workspaces import items_router, router as workspaces

    if type_ in ("file", "folder"):
        ids = files._BulkIds(
            file_ids=[uuid.UUID(id_)] if type_ == "file" else [],
            folder_ids=[uuid.UUID(id_)] if type_ == "folder" else [],
        )
        r = await files.bulk_purge(payload=ids, db=db, user=user)
        if not (r.files + r.folders):
            raise _gone()
        return r.files + r.folders
    if type_ == "workspace":
        await workspaces.delete_workspace(
            workspace_id=uuid.UUID(id_), request=request, permanent=True, db=db, user=user
        )
        return 1
    if type_ == "workspace_item":
        if not workspace_id:
            raise _gone()
        await items_router.purge_trashed_item(
            workspace_id=uuid.UUID(workspace_id), item_id=uuid.UUID(id_), request=request, db=db, user=user
        )
        return 1
    entry = await _find_entry(db, user, type_, id_)
    await db.delete(entry)
    await db.commit()
    return 1


async def empty(db: AsyncSession, user: User, request: Request | None) -> int:
    """Delete everything in the caller's trash for good.

    In a shared workspace only an owner / admin empties the team's trashed
    items; an editor's Empty leaves them (they can still delete one by one).
    """
    from app.files import router as files

    items = await list_all(db, user)
    # Drive's own Empty trash: also takes hidden rows (a document's images)
    # and anything the listing folds into a trashed folder.
    n = sum(1 for it in items if it["type"] in ("file", "folder"))
    if n:
        await files.empty_trash(scope="mine", db=db, user=user)
    spaces = await _writable_workspaces(db, user)
    for it in items:
        if it["type"] in ("file", "folder"):
            continue
        if it["type"] == "workspace_item":
            ws_role = spaces.get(uuid.UUID(it["workspace_id"]))
            if ws_role is None or ws_role[1] not in ("owner", "admin"):
                continue
        try:
            n += await purge(db, user, request, it["type"], it["id"], it.get("workspace_id"))
        except HTTPException:
            await db.rollback()
    return n


# ------------------------------------------------------------------ retention


async def purge_expired_entries(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Snapshots older than the retention window go (nightly maintenance)."""
    cutoff = (now or _now()) - timedelta(days=RETENTION_DAYS)
    res = await db.execute(delete(TrashEntry).where(TrashEntry.deleted_at < cutoff))
    return res.rowcount or 0


async def purge_expired_workspace_items(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Workspace items 30+ days in the trash. The workspace trash used to
    purge these only when someone opened its Trash panel, so an unvisited
    workspace kept deleted items (and their files) for ever."""
    from app.chat.models import Workspace, WorkspaceItem
    from app.workspaces.items_router import _purge_item

    cutoff = (now or _now()) - timedelta(days=RETENTION_DAYS)
    rows = list(
        (
            await db.execute(
                select(WorkspaceItem).where(
                    WorkspaceItem.trashed_at.is_not(None),
                    WorkspaceItem.trashed_at < cutoff,
                )
            )
        ).scalars()
    )
    ids = {r.id for r in rows}
    roots = [r for r in rows if r.parent_id not in ids]
    n = 0
    for it in roots:
        ws = await db.get(Workspace, it.workspace_id)
        if ws is None or ws.trashed_at is not None:
            continue  # a trashed workspace keeps its items until it goes itself
        owner = await db.get(User, ws.user_id)
        if owner is None:
            continue
        # The tree may have changed under us (a parent purged earlier in
        # this loop takes its children with it).
        still = await db.scalar(select(WorkspaceItem.id).where(WorkspaceItem.id == it.id))
        if still is None:
            continue
        await _purge_item(db, request=None, ws=ws, user=owner, item=it)  # type: ignore[arg-type]
        await db.flush()
        n += 1
    return n


__all__ = [
    "RETENTION_DAYS",
    "capture_item_removals",
    "empty",
    "list_all",
    "purge",
    "purge_expired_entries",
    "purge_expired_workspace_items",
    "restore",
    "trash_album",
    "trash_event",
]
