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

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.config import get_settings as get_app_config
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
    # The Photos folder — the library itself — made if it isn't there yet.
    from app.files.system_folders import ensure_camera_uploads

    folder = await ensure_camera_uploads(db, user)
    await db.commit()
    out["folder"] = {"id": str(folder.id), "name": folder.name}
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


@router.post("/files/{file_id}/move-to-photos")
async def move_to_photos(
    file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """File a picture or video from elsewhere in My files into the Photos
    folder (by the month it was taken), which puts it in Photos."""
    from app.files.models import FileFolder
    from app.files.router import _free_file_name
    from app.files.system_folders import camera_month_folder
    from app.photos.library import photos_folders

    row = await db.get(UserFile, file_id)
    if row is None or row.user_id != user.id or row.trashed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    media = await db.get(FileMedia, file_id)
    if media is None or media.kind not in ("image", "raw", "video"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only photos and videos go in Photos.")
    tree = photos_folders(user.id)
    if row.folder_id is not None and await db.scalar(select(tree.c.id).where(tree.c.id == row.folder_id)):
        return {"id": str(row.id), "folder_id": str(row.folder_id), "moved": False}
    # The month it shows under in Photos (its local time), as uploads are.
    asset = await db.get(PhotoAsset, file_id)
    when = (asset.taken_local if asset is not None else None) or media.taken_at_override or media.taken_at or row.created_at
    month = await camera_month_folder(db, user, when)
    row.filename = await _free_file_name(db, user.id, await db.get(FileFolder, month.id), row.filename)
    row.folder_id = month.id
    await db.commit()
    return {"id": str(row.id), "folder_id": str(month.id), "moved": True}


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
    """What you might not want (PH-7): duplicates and similar shots (each
    group with the one to keep first), blurry shots, screenshots and large
    videos — with how much space moving them to the trash would free."""
    from app.photos import cleanup

    found = await cleanup.find(db, user)
    ids: set[uuid.UUID] = set()
    for grouped in ("duplicate", "similar"):
        ids |= {g["keep"].file_id for g in found[grouped]["groups"]}
        ids |= {r.file_id for g in found[grouped]["groups"] for r in g["others"]}
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
        **{
            grouped: {
                "count": found[grouped]["count"], "bytes": found[grouped]["bytes"],
                "groups": [{"keep": out(g["keep"]), "others": [out(r) for r in g["others"]]} for g in found[grouped]["groups"]],
            }
            for grouped in ("duplicate", "similar")
        },
        **{
            reason: {"count": found[reason]["count"], "bytes": found[reason]["bytes"], "items": [out(r) for r in found[reason]["items"]]}
            for reason in ("blurry", "screenshot", "large_video")
        },
    }


class KeepRequest(BaseModel):
    file_ids: list[uuid.UUID] = Field(min_length=1, max_length=2000)
    reason: Literal["duplicate", "similar", "blurry", "screenshot", "large_video"]


@router.post("/cleanup/keep")
async def cleanup_keep(body: KeepRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """These are wanted: don't suggest them again for this reason."""
    from app.photos import cleanup

    n = await cleanup.keep(db, user.id, body.file_ids, body.reason)
    await db.commit()
    return {"kept": n}


@router.get("/copies")
async def hidden_copies(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Photos hidden as copies of ones you already have (a phone synced
    after a Takeout): each with its original, newest first."""
    from sqlalchemy.orm import aliased

    Orig = aliased(PhotoAsset)
    OrigFile = aliased(UserFile)
    OrigMedia = aliased(FileMedia)
    base = (
        select(PhotoAsset, UserFile, FileMedia, Orig, OrigFile, OrigMedia)
        .join(UserFile, UserFile.id == PhotoAsset.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
        .join(Orig, Orig.file_id == PhotoAsset.duplicate_of)
        .join(OrigFile, OrigFile.id == Orig.file_id)
        .outerjoin(OrigMedia, OrigMedia.file_id == Orig.file_id)
        .where(PhotoAsset.user_id == user.id, PhotoAsset.duplicate_of.is_not(None), UserFile.trashed_at.is_(None))
    )
    count = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = (await db.execute(base.order_by(UserFile.created_at.desc()).limit(200))).all()
    return {
        "count": int(count or 0),
        "items": [{"copy": _item(a, f, m, user), "original": _item(o, of, om, user)} for a, f, m, o, of, om in rows],
    }


class NotCopies(BaseModel):
    file_ids: list[uuid.UUID] = Field(min_length=1, max_length=2000)


@router.post("/copies/not")
async def not_copies(body: NotCopies, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """"These aren't copies": back in Photos, and never hidden as one again."""
    from app.photos.duplicates import KEPT_REASON

    rows = (
        await db.execute(
            select(PhotoAsset).where(PhotoAsset.user_id == user.id, PhotoAsset.file_id.in_(body.file_ids),
                                     PhotoAsset.duplicate_of.is_not(None))
        )
    ).scalars().all()
    for a in rows:
        a.duplicate_of = None
        await db.execute(
            text("INSERT INTO photo_cleanup_kept (user_id, file_id, reason) VALUES (:u, :f, :r) ON CONFLICT DO NOTHING"),
            {"u": user.id, "f": a.file_id, "r": KEPT_REASON},
        )
    await db.commit()
    return {"restored": len(rows)}


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
    # Drawn on top (pen, shapes, text, blur, emoji, stickers): cleaned and
    # clamped by app.photos.edits.normalise_markup.
    markup: list[dict[str, Any]] = Field(default_factory=list, max_length=500)


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


RENDER_MAX = 2560  # long side of a Copy (PNG)


def _render_bytes(path, kind: str, ops: dict[str, Any], fmt: str) -> bytes:  # noqa: ANN001 — Path
    """The edited picture now (sync, CPU): a PNG at most ``RENDER_MAX`` on
    its long side (Copy), or the full-size JPEG (Download / Share)."""
    import io

    from PIL import Image

    from app.photos import edits

    src = edits._open_full(path, kind)
    if fmt == "png":
        ew, eh = edits.edited_size(src.width, src.height, ops)
        f = RENDER_MAX / max(ew, eh)
        if f < 1:
            # Everything in the ops is relative, so scale the source first.
            src = src.resize((max(1, round(src.width * f)), max(1, round(src.height * f))), Image.Resampling.LANCZOS)
    im = edits.apply(src, ops)
    buf = io.BytesIO()
    if fmt == "png":
        if max(im.size) > RENDER_MAX:
            im.thumbnail((RENDER_MAX, RENDER_MAX), Image.Resampling.LANCZOS)
        im.convert("RGBA" if im.mode in ("RGBA", "LA", "PA") else "RGB").save(buf, "PNG", compress_level=3)
    else:
        im.convert("RGB").save(buf, "JPEG", quality=92, optimize=True)
    return buf.getvalue()


@router.post("/files/{file_id}/render")
async def render_edit(
    file_id: uuid.UUID, body: EditOps, format: Literal["png", "jpeg"] = "png",  # noqa: A002
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
):  # noqa: ANN201
    """The picture with these (unsaved) edits, made now, for Copy (PNG) and
    Download / Share (JPEG). Nothing is kept. Anyone who can see the photo
    may (a shared one too: mark it up and copy it)."""
    import asyncio
    from pathlib import PurePath

    from fastapi.responses import Response

    from app.files.router import _content_disposition, _load_readable_file
    from app.files.storage import absolute_path
    from app.photos import edits

    row = await _load_readable_file(db, file_id, user)
    media = await db.get(FileMedia, file_id)
    if media is None or media.kind not in ("image", "raw") or not row.storage_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only photos can be edited.")
    ops = edits.normalise(body.model_dump())
    try:
        data = await asyncio.to_thread(_render_bytes, absolute_path(row.storage_path), media.kind, ops, format)
    except Exception as exc:  # noqa: BLE001 — the picture couldn't be read
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That photo couldn't be made.") from exc
    name = f"{PurePath(row.filename).stem} (edited).{'png' if format == 'png' else 'jpg'}"
    return Response(data, media_type=f"image/{format}", headers={
        "Content-Disposition": _content_disposition(name), "Cache-Control": "no-store",
    })


def _exif_for(when_local: datetime, offset: int | None, lat: float | None, lon: float | None) -> bytes:
    """EXIF for a "Save as new" copy: when (and where) the original was
    taken, so it sorts beside it, and nothing else of the original's (its
    Live Photo id would pair the copy with the original's video)."""
    from PIL import Image

    exif = Image.Exif()
    exif[0x0112] = 1  # upright: the pixels are already turned
    ifd = exif.get_ifd(0x8769)
    ifd[0x9003] = when_local.strftime("%Y:%m:%d %H:%M:%S")  # DateTimeOriginal
    if offset is not None:
        sign = "+" if offset >= 0 else "-"
        ifd[0x9011] = f"{sign}{abs(offset) // 60:02d}:{abs(offset) % 60:02d}"  # OffsetTimeOriginal
    if lat is not None and lon is not None:
        def dms(v: float) -> tuple[float, float, float]:
            v = abs(v)
            d = int(v)
            m = int((v - d) * 60)
            return (float(d), float(m), round((v - d - m / 60) * 3600, 4))

        gps = exif.get_ifd(0x8825)
        gps[1], gps[2] = ("N" if lat >= 0 else "S"), dms(lat)
        gps[3], gps[4] = ("E" if lon >= 0 else "W"), dms(lon)
    return exif.tobytes()


@router.post("/files/{file_id}/save-as-new")
async def save_as_new(
    file_id: uuid.UUID, body: EditOps, request: Request,
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """These edits as a new photo beside the original ("IMG_1234 (edited).jpg",
    same folder, same date taken and place). The original and its own edit
    are left as they are. The new photo goes through the usual upload path
    (its tile and details are made by the media worker)."""
    import asyncio
    import io
    from datetime import timedelta
    from pathlib import PurePath

    from app.files import blobstore
    from app.files.router import ingest_staged
    from app.files.storage import absolute_path
    from app.imports.models import FileImportMeta
    from app.photos import edits

    row, media = await _editable(db, user, file_id)
    ops = edits.normalise(body.model_dump())
    asset = await db.get(PhotoAsset, file_id)
    instant = media.taken_at_override or media.taken_at or row.client_mtime or row.created_at
    offset = None if media.taken_at_override else media.tz_offset
    if offset is not None:
        local = instant.astimezone(timezone.utc).replace(tzinfo=None) + timedelta(minutes=offset)
    elif asset is not None:
        local = asset.taken_local
    else:
        local = instant.astimezone(timezone.utc).replace(tzinfo=None)
    exif = _exif_for(local, offset, media.lat, media.lon)
    path, kind = absolute_path(row.storage_path), media.kind

    def make() -> bytes:
        im = edits.apply(edits._open_full(path, kind), ops).convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=92, optimize=True, exif=exif)
        return buf.getvalue()

    try:
        data = await asyncio.to_thread(make)
    except Exception as exc:  # noqa: BLE001 — the picture couldn't be read
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That photo couldn't be made.") from exc
    staged = await asyncio.to_thread(blobstore.blobstore.stage_bytes, data)
    try:
        out = await ingest_staged(
            db, request=request, user=user, staged=staged, filename=f"{PurePath(row.filename).stem} (edited).jpg",
            declared_mime="image/jpeg", scope="mine", folder_id=row.folder_id, route=None, on_conflict="keep_both",
            workspace_id=None, last_modified=int(instant.timestamp() * 1000), exact_folder=True,
        )
    finally:
        blobstore.blobstore.discard(staged)
    new_id = uuid.UUID(str(out.id))
    # The original's details carry over (a date or place set by hand, a description).
    imported = await db.get(FileImportMeta, file_id)
    db.add(FileImportMeta(
        file_id=new_id, source="edit", taken_at=instant, lat=media.lat, lon=media.lon,
        description=imported.description if imported is not None else None,
    ))
    await db.commit()
    return {"file_id": str(new_id), "filename": out.filename}


@router.get("/map")
async def photo_map(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Where every located photo of yours was taken (the Photos map,
    PH-5): parallel arrays, compact for a big library; plus whether this
    server has its own detailed map."""
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
    from app.maps.links import basemap_link

    return {
        "ids": [str(r[0]) for r in rows],
        "lat": [round(float(r[1]), 5) for r in rows],
        "lon": [round(float(r[2]), 5) for r in rows],
        "basemap": await basemap_link(user),
    }


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
