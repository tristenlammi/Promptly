"""The photo library's API (WP-9.1, Part E PH-1).

    GET  /api/photos/buckets    how many photos each month has (the scrubber)
    GET  /api/photos/timeline   a page of the timeline, newest first
    POST /api/photos/archive    archive / unarchive photos (out of the timeline)
    GET  /api/photos/understanding  how far understanding your photos has got (PH-2)
    GET  /api/photos/search?q=  photos by what's in them (SigLIP 2, PH-2)
    GET|PUT /api/photos/settings  your Photos settings (face recognition on/off)

``view`` is ``all`` (the timeline, archived photos left out), ``favorites``
(starred) or ``archive``. Pages are keyset: ``before`` is the previous
page's ``next_cursor``; ``month=YYYY-MM`` starts at the end of that month
(a jump from the scrubber).
"""
from __future__ import annotations

import base64
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import FileMedia, UserFile
from app.photos.library import in_library, shared_with
from app.photos.models import PhotoAsset

router = APIRouter()

View = Literal["all", "favorites", "archive", "family"]
PAGE_MAX = 500


def _view_filter(view: View):  # noqa: ANN202
    if view == "archive":
        return PhotoAsset.archived_at.is_not(None)
    if view == "favorites":
        return UserFile.starred_at.is_not(None)
    return PhotoAsset.archived_at.is_(None)


def _scope(view: View, user: User) -> list[Any]:
    """Which photos a view is over: your library — or, for "family", what
    your family library holds (yours and theirs; PH-5)."""
    if view == "family":
        from sqlalchemy import text as sql

        family = select(sql("fi.file_id")).select_from(
            sql("photo_family_items fi JOIN photo_family_members fm ON fm.family_id = fi.family_id")
        ).where(sql("fm.user_id = :fam_reader").bindparams(fam_reader=user.id))
        return [PhotoAsset.file_id.in_(family), UserFile.trashed_at.is_(None), PhotoAsset.live_hidden.is_(False),
                PhotoAsset.archived_at.is_(None)]
    return [in_library(user.id), _view_filter(view)]


def _cursor(taken_local: datetime, file_id: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(f"{taken_local.isoformat()}|{file_id}".encode()).decode().rstrip("=")


def _uncursor(raw: str) -> tuple[datetime, uuid.UUID]:
    try:
        text = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode()
        when, _, fid = text.partition("|")
        return datetime.fromisoformat(when), uuid.UUID(fid)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bad cursor.") from None


def _month_end(month: str) -> datetime:
    try:
        year, mon = (int(x) for x in month.split("-", 1))
        return datetime(year + mon // 12, mon % 12 + 1, 1)
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="month is YYYY-MM.") from None


class PhotoSettings(BaseModel):
    faces: bool | None = None
    captions: bool | None = None
    setup_done: bool | None = None
    # Photos only from these folders (and their subfolders); [] = from
    # everywhere; left out = unchanged.
    only_folders: list[uuid.UUID] | None = Field(default=None, max_length=200)


async def _folder_choices(db: AsyncSession, user: User) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(the folders Photos is limited to, the top-level folders to pick from)."""
    from app.files.models import FileFolder
    from app.photos.library import EXCLUDED_SYSTEM_KINDS, FOLDERS_KEY

    chosen_ids = []
    for raw in (user.settings or {}).get(FOLDERS_KEY) or []:
        try:
            chosen_ids.append(uuid.UUID(str(raw)))
        except ValueError:
            continue
    chosen = []
    if chosen_ids:
        rows = (
            await db.execute(
                select(FileFolder).where(FileFolder.id.in_(chosen_ids), FileFolder.user_id == user.id, FileFolder.trashed_at.is_(None))
            )
        ).scalars().all()
        chosen = [{"id": str(f.id), "name": f.name} for f in sorted(rows, key=lambda f: f.name.lower())]
    top = (
        await db.execute(
            select(FileFolder)
            .where(
                FileFolder.user_id == user.id,
                FileFolder.parent_id.is_(None),
                FileFolder.trashed_at.is_(None),
                or_(FileFolder.system_kind.is_(None), FileFolder.system_kind.not_in(EXCLUDED_SYSTEM_KINDS)),
            )
            # Camera Uploads (and Generated Files) first: where photos land.
            .order_by(FileFolder.system_kind.is_(None), func.lower(FileFolder.name))
        )
    ).scalars().all()
    choices = [{"id": str(f.id), "name": f.name, "system_kind": f.system_kind} for f in top]
    return chosen, choices


async def _face_count(db: AsyncSession, user_id: uuid.UUID) -> int:
    from sqlalchemy import text as sql

    return int(await db.scalar(sql("SELECT count(*) FROM photo_faces WHERE user_id = :u"), {"u": user_id}) or 0)


async def _settings_out(db: AsyncSession, user: User) -> dict[str, Any]:
    from app.photos import captions

    vision = await captions.configured(db)
    s = user.settings or {}
    out = {
        "faces": bool(s.get("photos_faces")), "face_count": await _face_count(db, user.id),
        "captions": bool(s.get("photos_captions")),
        # Who would describe them: offered only once an admin chose a model.
        "captions_model": {"label": vision.label, "local": vision.local} if vision else None,
        # "Set up Photos" (PH-7): finished or put away.
        "setup_done": bool(s.get("photos_setup_done")),
    }
    out["only_folders"], out["folder_choices"] = await _folder_choices(db, user)
    return out


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    return await _settings_out(db, user)


@router.put("/settings")
async def put_settings(
    body: PhotoSettings, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """Face recognition is off until you turn it on; turning it off deletes
    every face found in your photos (and, later, the people named) at once."""
    from sqlalchemy import text as sql

    me = await db.get(User, user.id)
    changes: dict[str, Any] = {}
    if body.faces is not None:
        changes["photos_faces"] = body.faces
    if body.captions is not None:
        changes["photos_captions"] = body.captions
    if body.setup_done is not None:
        changes["photos_setup_done"] = body.setup_done
    if body.only_folders is not None:
        # Only your own folders; [] = Photos from everywhere again.
        from app.files.models import FileFolder
        from app.photos.library import FOLDERS_KEY

        wanted = list(dict.fromkeys(body.only_folders))
        if wanted:
            own = set(
                (
                    await db.execute(
                        select(FileFolder.id).where(
                            FileFolder.id.in_(wanted), FileFolder.user_id == user.id, FileFolder.trashed_at.is_(None)
                        )
                    )
                ).scalars()
            )
            if len(own) != len(wanted):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
        changes[FOLDERS_KEY] = [str(x) for x in wanted]
    me.settings = {**(me.settings or {}), **changes}
    forget = []
    if body.faces is False:
        await db.execute(sql("DELETE FROM photo_faces WHERE user_id = :u"), {"u": user.id})
        # …and the people found from them (PH-3), names and all.
        await db.execute(sql("DELETE FROM photo_people WHERE user_id = :u AND kind = 'person'"), {"u": user.id})
        forget.append("faces")
    if body.captions is False:
        # Off: the descriptions written go too.
        await db.execute(
            sql("DELETE FROM photo_captions c USING photo_assets p WHERE c.file_id = p.file_id AND p.user_id = :u"),
            {"u": user.id},
        )
        forget.append("captions")
    for stage in forget:
        await db.execute(
            sql(
                "DELETE FROM photo_understanding u USING photo_assets p WHERE u.file_id = p.file_id "
                "AND p.user_id = :u AND u.stage = :s"
            ),
            {"u": user.id, "s": stage},
        )
    await db.commit()
    await db.refresh(me)
    return await _settings_out(db, me)


@router.get("/understanding")
async def understanding(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.photos.understanding import progress

    stages = await progress(db, user.id)
    return {"stages": stages, "complete": all(s["done"] + s["failed"] >= s["total"] for s in stages)}


@router.get("/search")
async def search(
    q: str = Query(min_length=1, max_length=300),
    limit: int = Query(default=60, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Ask your photos (PH-4): "me and my wife at Noosa", "Max on the beach",
    "the menu in Bali", "videos from Christmas 2022" — people, pets, places,
    dates and words resolved and filtered, then ranked by what's in them."""
    from app.photos import engine, ml

    names = (
        await db.execute(
            text("SELECT name, kind FROM photo_people WHERE user_id = :u AND name IS NOT NULL"), {"u": user.id}
        )
    ).all()
    query = engine.parse(
        q, people_names=[n for n, k in names if k == "person"], pet_names=[n for n, k in names if k == "pet"]
    )
    query.limit = limit
    out = await engine.search(db, user, query)
    if not out["items"] and query.visual:
        reason = await ml.waiting()
        if reason:
            # Nothing found, and what it looks like couldn't be asked.
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=reason)
    return {**out, "query": q}


class ItemsRequest(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


@router.post("/items")
async def items(body: ItemsRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """These photos of yours (in this order), with fresh links — what a
    chat's photo card shows, however old the chat."""
    rows = {
        a.file_id: (a, r, m)
        for a, r, m in (
            await db.execute(
                select(PhotoAsset, UserFile, FileMedia)
                .join(UserFile, UserFile.id == PhotoAsset.file_id)
                .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
                .where(or_(in_library(user.id), PhotoAsset.file_id.in_(shared_with(user.id))), PhotoAsset.file_id.in_(body.ids))
            )
        ).all()
    }
    return {"items": [_item(*rows[i], user) for i in body.ids if i in rows]}


@router.get("/buckets")
async def buckets(
    view: View = "all",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    month = func.date_trunc("month", PhotoAsset.taken_local)
    rows = (
        await db.execute(
            select(month.label("m"), func.count())
            .select_from(PhotoAsset)
            .join(UserFile, UserFile.id == PhotoAsset.file_id)
            .where(*_scope(view, user))
            .group_by(month)
            .order_by(month.desc())
        )
    ).all()
    out = [{"month": m.strftime("%Y-%m"), "count": n} for m, n in rows]
    return {"buckets": out, "total": sum(b["count"] for b in out)}


def _item(asset: PhotoAsset, row: UserFile, media: FileMedia | None, user: User) -> dict[str, Any]:
    from app.files import media_urls

    width, height = (media.width, media.height) if media is not None else (None, None)
    if media is not None and media.orientation in (5, 6, 7, 8) and width and height:
        width, height = height, width  # shown turned
    # Edited (PH-7): its edited size, tile and blur.
    edit = (media.renditions or {}).get("edit") if media is not None else None
    if edit:
        width, height = edit.get("width") or width, edit.get("height") or height
    thumb = None
    if media is not None and media.derivative_state == "ready":
        thumb = media_urls.sign_shown(row.id, user.id, user.token_version, media.renditions, "thumb")
    return {
        "id": str(row.id),
        "filename": row.filename,
        "mime": row.mime_type,
        "kind": asset.kind,
        "taken_at": asset.taken_at.isoformat(),
        "taken_local": asset.taken_local.isoformat(),
        "width": width,
        "height": height,
        "duration_ms": media.duration_ms if media is not None else None,
        "thumbhash": (edit or {}).get("thumbhash") or (media.thumbhash if media is not None else None),
        "edited": bool(edit),
        # Theirs, in your family library or a shared album: look, don't touch.
        "mine": row.user_id == user.id,
        "live": bool(media is not None and asset.kind == "image" and media.live_pair_file_id),
        "favorite": row.starred_at is not None,
        "archived": asset.archived_at is not None,
        "thumb": thumb,
        "state": media.derivative_state if media is not None else None,
    }


@router.get("/timeline")
async def timeline(
    view: View = "all",
    before: str | None = None,
    month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
    limit: int = Query(default=150, ge=1, le=PAGE_MAX),
    # Just the photos taken at a place, or anywhere in a country (PH-5).
    place: int | None = None,
    country: str | None = Query(default=None, pattern=r"^[A-Z]{2}$"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    q = (
        select(PhotoAsset, UserFile, FileMedia)
        .join(UserFile, UserFile.id == PhotoAsset.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
        .where(*_scope(view, user))
    )
    if place is not None:
        q = q.where(PhotoAsset.place_id == place)
    if country:
        from app.photos.models import GeoPlace

        q = q.where(PhotoAsset.place_id.in_(select(GeoPlace.geonameid).where(GeoPlace.country == country)))
    if before:
        when, fid = _uncursor(before)
        q = q.where(
            or_(PhotoAsset.taken_local < when, and_(PhotoAsset.taken_local == when, PhotoAsset.file_id < fid))
        )
    elif month:
        q = q.where(PhotoAsset.taken_local < _month_end(month))
    rows = (
        await db.execute(q.order_by(PhotoAsset.taken_local.desc(), PhotoAsset.file_id.desc()).limit(limit + 1))
    ).all()
    more = len(rows) > limit
    rows = rows[:limit]
    items = [_item(a, r, m, user) for a, r, m in rows]
    nxt = _cursor(rows[-1][0].taken_local, rows[-1][0].file_id) if more and rows else None
    return {"items": items, "next_cursor": nxt}


@router.get("/places")
async def places_list(
    country: str | None = Query(default=None, pattern=r"^[A-Z]{2}$"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Where your photos were taken (PH-5): countries, most photos first —
    or, for one country, its towns — each with a count and a cover."""
    from app.photos.models import GeoAdmin1, GeoCountry, GeoPlace

    lib = (
        select(PhotoAsset.file_id, PhotoAsset.place_id, PhotoAsset.quality, PhotoAsset.taken_local, GeoPlace.country)
        .join(UserFile, UserFile.id == PhotoAsset.file_id)
        .join(GeoPlace, GeoPlace.geonameid == PhotoAsset.place_id)
        .where(in_library(user.id), _view_filter("all"))
    )
    if country:
        lib = lib.where(GeoPlace.country == country)
    lib = lib.subquery()
    group = lib.c.place_id if country else lib.c.country
    counts = (await db.execute(select(group, func.count()).group_by(group))).all()
    covers = dict(
        (
            await db.execute(
                select(group, lib.c.file_id)
                .distinct(group)
                .order_by(group, lib.c.quality.desc().nulls_last(), lib.c.taken_local.desc())
            )
        ).all()
    )
    rows = {
        a.file_id: (a, r, m)
        for a, r, m in (
            await db.execute(
                select(PhotoAsset, UserFile, FileMedia)
                .join(UserFile, UserFile.id == PhotoAsset.file_id)
                .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
                .where(PhotoAsset.file_id.in_(list(covers.values())))
            )
        ).all()
    } if covers else {}

    def cover(key: Any) -> dict[str, Any] | None:
        got = rows.get(covers.get(key))
        return _item(*got, user) if got else None

    if country:
        info = {
            p.geonameid: (p.name, a)
            for p, a in (
                await db.execute(
                    select(GeoPlace, GeoAdmin1.name)
                    .outerjoin(GeoAdmin1, GeoAdmin1.code == GeoPlace.country + "." + GeoPlace.admin1)
                    .where(GeoPlace.geonameid.in_([k for k, _ in counts]))
                )
            ).all()
        }
        name = await db.scalar(select(GeoCountry.name).where(GeoCountry.code == country))
        places = [
            {"id": k, "name": info.get(k, ("?", None))[0], "admin1": info.get(k, ("?", None))[1], "count": n, "cover": cover(k)}
            for k, n in counts
        ]
        places.sort(key=lambda p: (-p["count"], p["name"]))
        return {"country": {"code": country, "name": name or country}, "places": places}
    names = dict((await db.execute(select(GeoCountry.code, GeoCountry.name).where(GeoCountry.code.in_([k for k, _ in counts])))).all())
    countries = [{"code": k, "name": names.get(k, k), "count": n, "cover": cover(k)} for k, n in counts]
    countries.sort(key=lambda c: (-c["count"], c["name"]))
    return {"countries": countries}


@router.get("/cleanup")
async def cleanup_list(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """What you might not want (PH-7): duplicates (each group with the one
    to keep first), blurry shots, screenshots and large videos — with how
    much space moving them to the trash would free."""
    from app.photos import cleanup

    found = await cleanup.find(db, user)
    ids = {g["keep"].file_id for g in found["duplicate"]["groups"]}
    ids |= {r.file_id for g in found["duplicate"]["groups"] for r in g["others"]}
    for reason in ("blurry", "screenshot", "large_video"):
        ids |= {r.file_id for r in found[reason]["items"]}
    rows = {
        a.file_id: (a, r, m)
        for a, r, m in (
            await db.execute(
                select(PhotoAsset, UserFile, FileMedia)
                .join(UserFile, UserFile.id == PhotoAsset.file_id)
                .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
                .where(PhotoAsset.file_id.in_(list(ids)))
            )
        ).all()
    } if ids else {}

    def out(r: Any) -> dict[str, Any]:
        return {**_item(*rows[r.file_id], user), "size": r.size}

    return {
        "duplicate": {
            "count": found["duplicate"]["count"], "bytes": found["duplicate"]["bytes"],
            "groups": [{"keep": out(g["keep"]), "others": [out(r) for r in g["others"]]} for g in found["duplicate"]["groups"]],
        },
        **{
            reason: {"count": found[reason]["count"], "bytes": found[reason]["bytes"], "items": [out(r) for r in found[reason]["items"]]}
            for reason in ("blurry", "screenshot", "large_video")
        },
    }


class KeepRequest(BaseModel):
    file_ids: list[uuid.UUID] = Field(min_length=1, max_length=2000)
    reason: Literal["duplicate", "blurry", "screenshot", "large_video"]


@router.post("/cleanup/keep")
async def cleanup_keep(body: KeepRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """These are wanted: don't suggest them again for this reason."""
    from app.photos import cleanup

    n = await cleanup.keep(db, user.id, body.file_ids, body.reason)
    await db.commit()
    return {"kept": n}


class CropBox(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)


class EditOps(BaseModel):
    rotate: Literal[0, 90, 180, 270] = 0
    flip: bool = False
    crop: CropBox | None = None
    brightness: float = Field(default=0, ge=-1, le=1)
    contrast: float = Field(default=0, ge=-1, le=1)
    saturation: float = Field(default=0, ge=-1, le=1)


async def _editable(db: AsyncSession, user: User, file_id: uuid.UUID) -> tuple[UserFile, FileMedia]:
    """Your own photo (not a video) — edits are the owner's."""
    row = await db.get(UserFile, file_id)
    media = await db.get(FileMedia, file_id)
    if row is None or row.user_id != user.id or row.trashed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That photo isn't there.")
    if media is None or media.kind not in ("image", "raw"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only photos can be edited.")
    return row, media


async def _edit_out(db: AsyncSession, user: User, file_id: uuid.UUID) -> dict[str, Any]:
    ops = await db.scalar(text("SELECT ops FROM photo_edits WHERE file_id = :f"), {"f": file_id})
    got = (
        await db.execute(
            select(PhotoAsset, UserFile, FileMedia).join(UserFile, UserFile.id == PhotoAsset.file_id)
            .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id).where(PhotoAsset.file_id == file_id)
        )
    ).first()
    return {"ops": ops, "item": _item(*got, user) if got else None}


@router.get("/files/{file_id}/edit")
async def get_edit(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    await _editable(db, user, file_id)
    return await _edit_out(db, user, file_id)


@router.put("/files/{file_id}/edit")
async def put_edit(
    file_id: uuid.UUID, body: EditOps, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """Crop / rotate / adjust (PH-7): kept beside the original, which is
    never changed; the grid and viewer show it edited from now on."""
    from app.photos import edits

    await _editable(db, user, file_id)
    ops = edits.normalise(body.model_dump())
    if edits.is_identity(ops):
        await db.execute(text("DELETE FROM photo_edits WHERE file_id = :f"), {"f": file_id})
    else:
        await db.execute(
            text(
                "INSERT INTO photo_edits (file_id, ops, updated_by) VALUES (:f, CAST(:o AS jsonb), :u) "
                "ON CONFLICT (file_id) DO UPDATE SET ops = EXCLUDED.ops, updated_by = EXCLUDED.updated_by, updated_at = now()"
            ),
            {"f": file_id, "o": __import__("json").dumps(ops), "u": user.id},
        )
    try:
        await edits.apply_to_renditions(db, file_id)
    except Exception as exc:  # noqa: BLE001 — the picture couldn't be read
        __import__("logging").getLogger("promptly.photos.edits").warning("edit of %s failed", file_id, exc_info=True)
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That photo couldn't be edited.") from exc
    await db.commit()
    return await _edit_out(db, user, file_id)


@router.delete("/files/{file_id}/edit")
async def revert_edit(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Back to the original."""
    from app.photos import edits

    await _editable(db, user, file_id)
    await db.execute(text("DELETE FROM photo_edits WHERE file_id = :f"), {"f": file_id})
    await edits.apply_to_renditions(db, file_id)
    await db.commit()
    return await _edit_out(db, user, file_id)


@router.get("/files/{file_id}/edited")
async def download_edited(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):  # noqa: ANN201
    """The edited photo, full size, as a JPEG (made now; the original is
    its own download)."""
    import asyncio
    from pathlib import PurePath

    from fastapi.responses import Response

    from app.files.router import _content_disposition
    from app.files.storage import absolute_path
    from app.photos import edits

    row, media = await _editable(db, user, file_id)
    ops = await db.scalar(text("SELECT ops FROM photo_edits WHERE file_id = :f"), {"f": file_id})
    if not ops:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This photo hasn't been edited.")
    data = await asyncio.to_thread(edits.export_jpeg, absolute_path(row.storage_path), media.kind, ops)
    name = f"{PurePath(row.filename).stem} (edited).jpg"
    return Response(data, media_type="image/jpeg", headers={"Content-Disposition": _content_disposition(name)})


def _basemap_path():  # noqa: ANN202 — Path | None
    """An admin-provided offline basemap (a PMTiles extract), if any:
    ``MAP_PMTILES`` or ``uploads/.maps/basemap.pmtiles``."""
    import os
    from pathlib import Path

    from app.files import storage

    raw = (os.environ.get("MAP_PMTILES") or "").strip()
    path = Path(raw) if raw else storage.UPLOAD_ROOT / ".maps" / "basemap.pmtiles"
    return path if path.is_file() else None


@router.get("/map")
async def photo_map(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Where every located photo of yours was taken (the Photos map,
    PH-5): parallel arrays, compact for a big library; plus whether this
    server has a detailed offline basemap."""
    import asyncio

    lat = func.coalesce(FileMedia.lat_override, FileMedia.lat)
    lon = func.coalesce(FileMedia.lon_override, FileMedia.lon)
    rows = (
        await db.execute(
            select(PhotoAsset.file_id, lat, lon)
            .join(UserFile, UserFile.id == PhotoAsset.file_id)
            .join(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
            .where(in_library(user.id), _view_filter("all"), FileMedia.location_hidden.is_(False), lat.is_not(None), lon.is_not(None))
            .order_by(PhotoAsset.taken_local.desc())
        )
    ).all()
    basemap = await asyncio.to_thread(_basemap_path)
    return {
        "ids": [str(r[0]) for r in rows],
        "lat": [round(float(r[1]), 5) for r in rows],
        "lon": [round(float(r[2]), 5) for r in rows],
        "basemap": "/api/photos/basemap.pmtiles" if basemap else None,
    }


@router.get("/basemap.pmtiles")
async def basemap(user: User = Depends(get_current_user)):  # noqa: ANN201 — a FileResponse
    """The offline basemap, read in ranges by the map (signed-in only)."""
    import asyncio

    from fastapi.responses import FileResponse

    path = await asyncio.to_thread(_basemap_path)
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No offline map on this server.")
    return FileResponse(str(path), media_type="application/octet-stream", headers={"Cache-Control": "private, max-age=86400"})


class ArchiveRequest(BaseModel):
    file_ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)
    archived: bool


@router.post("/archive")
async def archive(
    payload: ArchiveRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, int]:
    result = await db.execute(
        update(PhotoAsset)
        .where(PhotoAsset.user_id == user.id, PhotoAsset.file_id.in_(payload.file_ids))
        .values(archived_at=datetime.now(timezone.utc) if payload.archived else None)
    )
    await db.commit()
    return {"updated": result.rowcount or 0}


__all__ = ["router"]
