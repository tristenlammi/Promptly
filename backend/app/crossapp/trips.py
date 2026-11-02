"""A trip, seen from Photos and Budget.

* **Trip album** — "Make a trip album" makes a smart album of *your own*
  photos taken between the trip's first and last day (Photos keeps it up to
  date as photos arrive; photos you take out of it stay out). Each traveller
  gets their own: the trip keeps ``photo_albums[<user id>] = <album id>``.
  Pressing it again after the dates change moves the album's dates too.
* **Spent so far** — transactions in *your* Budget can carry a trip
  (``trip_ref = "<trip file id>:<trip id>"``); the trip adds them up in its
  own currency when it has a rate for the budget's (or they're the same),
  otherwise in the budget's currency. Transfers never count; refunds tagged
  to the trip take off what was spent.
"""
from __future__ import annotations

import copy
import uuid
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.items import service as items

ALBUM_STRIP = 12


def _not_found(what: str = "Trip") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


def trip_ref(file_id: uuid.UUID | str, trip_id: str) -> str:
    return f"{file_id}:{trip_id}"


async def _load(db: AsyncSession, user: User, file_id: uuid.UUID, trip_id: str, *, need: str = "read", lock: bool = False):  # noqa: ANN202
    try:
        row, doc, access = await items.load(db, user, file_id, need=need, lock=lock)
    except items.ItemNotFound:
        raise _not_found()
    if doc.kind != "trip":
        raise _not_found()
    trip = next((t for t in (doc.data or {}).get("trips", []) if t.get("id") == trip_id), None)
    if trip is None:
        raise _not_found()
    return row, doc, trip


# ------------------------------------------------------------------ album


async def _strip(db: AsyncSession, user: User, album_id: uuid.UUID) -> tuple[int, list[dict]]:
    from sqlalchemy import func

    from app.files.models import FileMedia, UserFile
    from app.photos.album_models import AlbumItem
    from app.photos.models import PhotoAsset
    from app.photos.router import _item

    base = (
        select(PhotoAsset, UserFile, FileMedia)
        .select_from(AlbumItem)
        .join(UserFile, UserFile.id == AlbumItem.file_id)
        .join(PhotoAsset, PhotoAsset.file_id == AlbumItem.file_id)
        .outerjoin(FileMedia, FileMedia.file_id == AlbumItem.file_id)
        .where(AlbumItem.album_id == album_id, UserFile.trashed_at.is_(None))
    )
    count = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0
    rows = (await db.execute(base.order_by(PhotoAsset.taken_local).limit(ALBUM_STRIP))).all()
    return count, [_item(a, f, m, user) for a, f, m in rows]


async def album_out(db: AsyncSession, user: User, file_id: uuid.UUID, trip_id: str) -> dict:
    """Your album for this trip (None until made, or after you deleted it)
    with its first photos."""
    from app.photos.album_models import Album

    _row, _doc, trip = await _load(db, user, file_id, trip_id)
    aid = (trip.get("photo_albums") or {}).get(str(user.id))
    album = await db.get(Album, uuid.UUID(aid)) if aid else None
    if album is None or album.owner_id != user.id:
        return {"album": None, "photos": [], "can_make": bool(trip.get("start"))}
    count, photos = await _strip(db, user, album.id)
    return {
        "album": {"id": str(album.id), "title": album.title, "count": count, "href": f"/files/photos/albums/{album.id}"},
        "photos": photos,
        "can_make": True,
    }


async def make_album(db: AsyncSession, user: User, file_id: uuid.UUID, trip_id: str) -> dict:
    """Make (or bring up to date) your trip album. Commits."""
    from app.photos import engine, smart
    from app.photos.album_models import Album

    row, doc, trip = await _load(db, user, file_id, trip_id, need="edit", lock=True)
    start = trip.get("start")
    if not start:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Give the trip its dates first.")
    end = trip.get("end") or start
    rules = engine.args_of(engine.query_from({"date_from": start, "date_to": end, "sort": "oldest"}))
    aid = (trip.get("photo_albums") or {}).get(str(user.id))
    album = await db.get(Album, uuid.UUID(aid)) if aid else None
    if album is None or album.owner_id != user.id:
        title = f"{trip.get('emoji') or ''} {trip.get('title') or 'Trip'}".strip()[:200]
        album = Album(owner_id=user.id, title=title, rules=rules, sort="oldest")
        db.add(album)
        await db.flush()
        data = copy.deepcopy(doc.data)
        t = next(x for x in data["trips"] if x.get("id") == trip_id)
        t["photo_albums"] = {**(t.get("photo_albums") or {}), str(user.id): str(album.id)}
        try:
            await items.save_data(db, user, row, doc, data, base_revision=None)
        except items.ItemError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    else:
        album.rules = rules
        await db.flush()
    await smart.refresh(db, album.id)
    await db.commit()
    out = await album_out(db, user, file_id, trip_id)
    out["revision"] = doc.revision
    return out


# ------------------------------------------------------------------ budget


def _spending(t: dict) -> bool:
    return not t.get("transfer") and t.get("amount_cents", 0) < 0


async def _budget(db: AsyncSession, user: User, *, lock: bool = False):  # noqa: ANN202
    found = await items.primary_file(db, user, "budget")
    if found is None:
        return None
    if not lock:
        return found
    row, _doc, _ = await items.load(db, user, found[0].id, need="edit", lock=True)
    return row, _doc


def _in_dates(t: dict, trip: dict) -> bool:
    start = trip.get("start")
    if not start:
        return False
    return start <= t.get("date", "") <= (trip.get("end") or start)


async def spending_out(db: AsyncSession, user: User, file_id: uuid.UUID, trip_id: str) -> dict:
    """What your Budget says you spent on this trip."""
    from app.items.kinds.trip.timeutil import exponent, half_up

    _row, _doc, trip = await _load(db, user, file_id, trip_id)
    home = trip.get("home_currency") or "AUD"
    found = await _budget(db, user)
    if found is None:
        return {"has_budget": False, "count": 0, "untagged": 0, "spent_minor": 0, "currency": home, "converted": False}
    brow, bdoc = found
    bdata = bdoc.data or {}
    cur = ((bdata.get("settings") or {}).get("currency") or "AUD").upper()
    ref = trip_ref(file_id, trip_id)
    txns = bdata.get("transactions", [])
    tagged = [t for t in txns if t.get("trip_ref") == ref and not t.get("transfer")]
    cents = -sum(int(t.get("amount_cents") or 0) for t in tagged)
    untagged = sum(1 for t in txns if _spending(t) and not t.get("trip_ref") and _in_dates(t, trip))
    spent, currency, converted = cents, cur, False
    if cur != home:
        rate = next((float(r["per_home"]) for r in trip.get("currencies", []) if r.get("code") == cur), None)
        if rate:
            # Budget amounts are cents; the trip keeps its own minor units.
            spent = half_up(cents / 100 / rate * 10 ** exponent(home))
            currency, converted = home, True
    return {
        "has_budget": True,
        "budget_file_id": str(brow.id),
        "count": len(tagged),
        "untagged": untagged,
        "spent_minor": spent,
        "currency": currency,
        "converted": converted,
        "budget_cents": cents,
        "budget_currency": cur,
    }


async def tag_in_dates(db: AsyncSession, user: User, file_id: uuid.UUID, trip_id: str) -> dict:
    """Tag every untagged purchase in your Budget dated within the trip.
    Commits."""
    _row, _doc, trip = await _load(db, user, file_id, trip_id)
    if not trip.get("start"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Give the trip its dates first.")
    found = await _budget(db, user, lock=True)
    if found is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Add Budget from the Item Store first.")
    brow, bdoc = found
    data = copy.deepcopy(bdoc.data)
    ref = trip_ref(file_id, trip_id)
    n = 0
    for t in data.get("transactions", []):
        if _spending(t) and not t.get("trip_ref") and _in_dates(t, trip):
            t["trip_ref"] = ref
            n += 1
    if n:
        try:
            await items.save_data(db, user, brow, bdoc, data, base_revision=None)
        except items.ItemError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        await db.commit()
    out = await spending_out(db, user, file_id, trip_id)
    out["tagged_now"] = n
    return out


async def my_trips(db: AsyncSession, user: User) -> list[dict[str, Any]]:
    """The trips Budget can tag a transaction with: yours, newest first."""
    found = await items.primary_file(db, user, "trip")
    if found is None:
        return []
    row, doc = found
    out = []
    for t in (doc.data or {}).get("trips", []):
        out.append(
            {
                "ref": trip_ref(row.id, t["id"]),
                "file_id": str(row.id),
                "trip_id": t["id"],
                "title": t.get("title") or "Trip",
                "emoji": t.get("emoji") or "✈️",
                "start": t.get("start"),
                "end": t.get("end") or t.get("start"),
            }
        )
    out.sort(key=lambda t: t["start"] or "", reverse=True)
    return out
