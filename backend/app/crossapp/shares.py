"""Send anything to a room or a person (a DM): a card in Rooms.

The message carries only *what* was shared — ``meta.share = {kind, id,
file_id?, label}`` — never its title or picture. Each person who sees the
message asks for the card (:func:`card`), and it's drawn from the live thing
**as they can see it**: someone who can't open it gets "Shared item — you
don't have access", and learns nothing but the kind. Posting a card never
grants access by itself; the sender can choose "Also give everyone in the
room access" (:func:`grant_room`) where the thing can be shared — a Drive
file or folder (a view-only share), a photo (its file) or an album (added
as viewers). Tasks, recipes and trips live inside an app file that holds
all of them, so they're seen by whoever the app file is already shared with.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

KINDS = ("file", "folder", "photo", "album", "task", "recipe", "trip")
LABELS = {
    "file": "a file", "folder": "a folder", "photo": "a photo", "album": "an album",
    "task": "a task", "recipe": "a recipe", "trip": "a trip",
}
# Notes (app/notes): a note card. Only people the note is shared with can
# open it; the room's other people see "This note isn't shared with you".
KINDS = (*KINDS, "note")
LABELS["note"] = "a note"
# Kinds whose own sharing can let the room in.
GRANTABLE = ("file", "folder", "photo", "album")
# Kinds that live inside an app file (``file_id``) under their own ``id``.
IN_ITEM = {"task": "tasks", "recipe": "mealplan", "trip": "trip"}


def _uuid(v: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(v))
    except (TypeError, ValueError):
        return None


def _day_text(d: str | None) -> str:
    try:
        x = date.fromisoformat(str(d)[:10])
    except (TypeError, ValueError):
        return ""
    return f"{x.day} {x.strftime('%b')}" + ("" if x.year == date.today().year else f" {x.year}")


def _size(n: int | None) -> str:
    n = int(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024  # type: ignore[assignment]
    return ""


def _file_label(row: Any) -> str:
    sk = row.source_kind or ""
    if sk == "document":
        return "Document"
    if sk == "sheet":
        return "Spreadsheet"
    if sk == "whiteboard":
        return "Whiteboard"
    if sk == "item":
        return "App file"
    mime = (row.mime_type or "").lower()
    if mime.startswith("image/"):
        return "Image"
    if mime.startswith("video/"):
        return "Video"
    if mime.startswith("audio/"):
        return "Audio"
    if mime == "application/pdf":
        return "PDF"
    ext = (row.filename or "").rsplit(".", 1)[-1].upper() if "." in (row.filename or "") else ""
    return f"{ext} file" if ext and len(ext) <= 5 else "File"


# ------------------------------------------------------------------ reading


async def _readable_file(db: AsyncSession, user: User, fid: uuid.UUID | None):  # noqa: ANN202
    from app.files.access import can_read
    from app.files.models import UserFile
    from app.files.sharing import file_is_accessible_via_workspace

    if fid is None:
        return None
    row = await db.get(UserFile, fid)
    if row is None or row.trashed_at is not None:
        return None
    if await can_read(db, row.id, user.id) or await file_is_accessible_via_workspace(db, row.id, user):
        return row
    return None


async def _thumb(db: AsyncSession, row: Any, user: User) -> str | None:
    from app.files import media_urls
    from app.files.models import FileMedia

    media = await db.get(FileMedia, row.id)
    if media is None or media.derivative_state != "ready":
        return None
    return media_urls.sign_shown(row.id, user.id, user.token_version, media.renditions, "thumb")


async def _file_card(db: AsyncSession, user: User, share: dict, *, photo: bool) -> dict | None:
    from app.files.office_router import editor_path
    from app.files.office_templates import office_title
    from app.files.router import _file_to_response

    row = await _readable_file(db, user, _uuid(share.get("id")))
    if row is None:
        return None
    href = editor_path(row)
    if row.source_kind == "item":
        from app.items.service import kind_from_row

        kind = kind_from_row(row)
        href = f"/apps/{kind}/{row.id}" if kind else None
    subtitle = _file_label(row)
    if photo:
        from app.photos.models import PhotoAsset

        asset = await db.get(PhotoAsset, row.id)
        subtitle = ("Video" if asset is not None and asset.kind == "video" else "Photo") + (
            f" · {_day_text(asset.taken_local.date().isoformat())}" if asset is not None else ""
        )
    elif row.size_bytes and row.source_kind not in ("document", "sheet", "whiteboard", "item"):
        subtitle += f" · {_size(row.size_bytes)}"
    return {
        "title": office_title(row),
        "subtitle": subtitle,
        "thumb": await _thumb(db, row, user),
        "href": href,
        "file": _file_to_response(row, caller=user).model_dump(mode="json"),
    }


async def _folder_card(db: AsyncSession, user: User, share: dict) -> dict | None:
    from app.files.models import FileFolder
    from app.files.sharing import caller_grants_for_folder

    fid = _uuid(share.get("id"))
    folder = await db.get(FileFolder, fid) if fid else None
    if folder is None or folder.trashed_at is not None:
        return None
    own = folder.user_id == user.id
    if not own and not await caller_grants_for_folder(db, folder, user):
        return None
    return {
        "title": folder.name,
        "subtitle": "Folder",
        "thumb": None,
        "href": f"/files/folder/{folder.id}" + ("" if own else "?scope=shared"),
    }


async def _album_card(db: AsyncSession, user: User, share: dict) -> dict | None:
    from app.files.models import UserFile
    from app.photos.album_models import Album, AlbumItem, AlbumMember
    from app.photos.albums_router import _cover

    aid = _uuid(share.get("id"))
    album = await db.get(Album, aid) if aid else None
    if album is None:
        return None
    if album.owner_id != user.id and await db.get(AlbumMember, (album.id, user.id)) is None:
        return None
    count = (
        await db.execute(
            select(func.count()).select_from(AlbumItem).join(UserFile, UserFile.id == AlbumItem.file_id)
            .where(AlbumItem.album_id == album.id, UserFile.trashed_at.is_(None))
        )
    ).scalar() or 0
    cover = await _cover(db, album, user)
    return {
        "title": album.title,
        "subtitle": f"Album · {count} photo{'' if count == 1 else 's'}",
        "thumb": (cover or {}).get("thumb"),
        "href": f"/files/photos/albums/{album.id}",
    }


async def _item_card(db: AsyncSession, user: User, share: dict, kind: str) -> dict | None:
    from app.items import service as items

    fid = _uuid(share.get("file_id"))
    if fid is None:
        return None
    try:
        _row, doc, _access = await items.load(db, user, fid)
    except items.ItemNotFound:
        return None
    if doc.kind != IN_ITEM[kind]:
        return None
    data = doc.data or {}
    sid = str(share.get("id") or "")
    if kind == "task":
        t = next((x for x in data.get("tasks", []) if x.get("id") == sid), None)
        if t is None:
            return None
        lst = next((x for x in data.get("lists", []) if x.get("id") == t.get("list_id")), None)
        bits = ["Done" if t.get("done") else "Task"]
        if t.get("due"):
            bits.append("due " + _day_text(t["due"]) + (f", {t['time']}" if t.get("time") else ""))
        bits.append(lst["name"] if lst else "Inbox")
        return {"title": t.get("title") or "Task", "subtitle": " · ".join(bits), "thumb": None, "href": f"/apps/tasks/{fid}"}
    if kind == "recipe":
        r = next((x for x in data.get("recipes", []) if x.get("id") == sid), None)
        if r is None:
            return None
        bits = ["Recipe"]
        mins = r.get("total_min") or ((r.get("prep_min") or 0) + (r.get("cook_min") or 0)) or None
        if mins:
            bits.append(f"{mins} min")
        if r.get("servings"):
            s = r["servings"]
            bits.append(f"serves {int(s) if float(s).is_integer() else s}")
        return {
            "title": r.get("title") or "Recipe",
            "subtitle": " · ".join(bits),
            "thumb": None,
            "image_url": r.get("image_url") or None,
            "href": f"/apps/mealplan/{fid}?tab=recipes",
        }
    t = next((x for x in data.get("trips", []) if x.get("id") == sid), None)
    if t is None:
        return None
    bits = []
    if t.get("start"):
        bits.append(_day_text(t["start"]) + (f" – {_day_text(t['end'])}" if t.get("end") and t["end"] != t["start"] else ""))
    places = [d.get("name") for d in t.get("destinations", []) if d.get("name")]
    if places:
        bits.append(", ".join(places[:3]) + (" …" if len(places) > 3 else ""))
    return {
        "title": t.get("title") or "Trip",
        "subtitle": " · ".join(bits) or "Trip",
        "thumb": None,
        "emoji": t.get("emoji") or "✈️",
        "href": f"/apps/trip/{fid}",
    }


async def _note_card(db: AsyncSession, user: User, share: dict) -> dict | None:
    """A note from Notes, as ``user`` sees it: only if they can open it."""
    from app.notes import access as note_access
    from app.notes.models import Note, NoteItem
    from app.notes.service import display_title

    nid = _uuid(share.get("id"))
    note = await db.get(Note, nid) if nid else None
    if note is None or not await note_access.can_open(db, user, note):
        return None
    if note.kind == "list":
        left = (
            await db.execute(select(func.count()).select_from(NoteItem).where(NoteItem.note_id == note.id, NoteItem.checked.is_(False)))
        ).scalar() or 0
        subtitle = f"List · {left} left"
    else:
        first = next((ln.strip() for ln in (note.body_text or "").splitlines() if ln.strip()), "")
        subtitle = "Note" + (f" · {first[:60]}" if first and note.title.strip() else "")
    return {"title": display_title(note), "subtitle": subtitle, "thumb": None, "href": f"/notes/n/{note.id}"}


async def card(db: AsyncSession, user: User, share: dict) -> dict | None:
    """The card as ``user`` sees it — None when they can't open the thing
    (or it's gone): the client then draws "you don't have access"."""
    kind = share.get("kind")
    if kind in ("file", "photo"):
        out = await _file_card(db, user, share, photo=kind == "photo")
    elif kind == "folder":
        out = await _folder_card(db, user, share)
    elif kind == "album":
        out = await _album_card(db, user, share)
    elif kind in IN_ITEM:
        out = await _item_card(db, user, share, kind)
    elif kind == "note":
        out = await _note_card(db, user, share)
    else:
        out = None
    if out is None:
        return None
    return {"kind": kind, "emoji": None, "image_url": None, "file": None, **out}


# ------------------------------------------------------------------ granting


async def can_grant(db: AsyncSession, user: User, share: dict) -> bool:
    """Whether ``user`` may let a room in (they own a shareable thing)."""
    kind = share.get("kind")
    if kind not in GRANTABLE:
        return False
    oid = _uuid(share.get("id"))
    if oid is None:
        return False
    if kind in ("file", "photo"):
        from app.files.models import UserFile

        row = await db.get(UserFile, oid)
        return row is not None and row.user_id == user.id and row.trashed_at is None
    if kind == "folder":
        from app.files.models import FileFolder

        folder = await db.get(FileFolder, oid)
        return folder is not None and folder.user_id == user.id and folder.trashed_at is None and folder.system_kind is None
    from app.photos.album_models import Album

    album = await db.get(Album, oid)
    return album is not None and album.owner_id == user.id


async def grant_room(db: AsyncSession, user: User, share: dict, member_ids: list[uuid.UUID]) -> dict:
    """Let everyone in the room open the shared thing through its own
    sharing (view only). Returns {granted, already, skipped} — ``skipped``
    counts people left out by Drive's per-file share limit. Flushed."""
    if not await can_grant(db, user, share):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can give other people access to this.")
    others = [m for m in dict.fromkeys(member_ids) if m != user.id]
    kind = share["kind"]
    oid = uuid.UUID(str(share["id"]))
    out = {"granted": 0, "already": 0, "skipped": 0}
    if kind == "album":
        from app.photos.album_models import AlbumMember

        for uid in others:
            if await db.get(AlbumMember, (oid, uid)) is not None:
                out["already"] += 1
                continue
            db.add(AlbumMember(album_id=oid, user_id=uid, role="viewer"))
            out["granted"] += 1
        await db.flush()
        return out
    from app.files.access import can_read
    from app.files.models import ResourceGrant
    from app.files.schemas import MAX_GRANTS_PER_RESOURCE
    from app.files.sharing import grants_for_resource

    rtype = "folder" if kind == "folder" else "file"
    existing = await grants_for_resource(db, resource_type=rtype, resource_id=oid)
    # Every row, live or not: (resource, grantee) is unique.
    granted_to = set(
        (
            await db.execute(
                select(ResourceGrant.grantee_user_id).where(
                    ResourceGrant.resource_type == rtype, ResourceGrant.resource_id == oid
                )
            )
        ).scalars()
    )
    used = len([g for g in existing if g.via_link_id is None])
    for uid in others:
        if uid in granted_to or (rtype == "file" and await can_read(db, oid, uid)):
            out["already"] += 1
            continue
        if used >= MAX_GRANTS_PER_RESOURCE:
            out["skipped"] += 1
            continue
        db.add(ResourceGrant(resource_type=rtype, resource_id=oid, grantee_user_id=uid, granted_by_user_id=user.id))
        used += 1
        out["granted"] += 1
    await db.flush()
    return out
