"""The Photo widget's two reads (``/api/widgets/photos/…``).

A phone's home-screen widget shows photos from one album, a different one
every so often. It asks for:

* the albums you could pick — yours and the ones shared with you (the same
  rule as ``/api/photos/albums``: owner or member, nobody else);
* a handful of photos from one album, picked at random here so the phone
  never needs the whole list. Videos are left out, and so is anything in the
  trash or still waiting for its preview.

Each photo comes with short-lived signed links (``/m/…``) to its preview and
its small tile; the phone downloads one, shrinks it and keeps its own copy.
Nothing is written.

Each also comes with a ``focus``: where the people and pets in it are, so
the widget crops round them and not just round the middle (:func:`focus_of`).
It's made from what Photos already knows — the faces and animals found
earlier, if any — and is null when nothing is known. Nothing new is looked
for here.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files import media_urls
from app.files.models import FileMedia, UserFile
from app.photos.album_models import Album, AlbumItem, AlbumMember
from app.photos.models import PhotoAsset

MAX_HAVE = 60

# A face's box is only the face: this much more of the person round it, as
# shares of the face's width (each side) and height (above, below).
FACE_SIDE, FACE_ABOVE, FACE_BELOW = 0.4, 0.5, 0.8
# Faces (or animals) much smaller than the biggest one are the background.
SMALL = 0.12
# A box mostly cut away by the person's own crop isn't in the picture any more.
KEPT = 0.3

Box = tuple[float, float, float, float]  # x, y, w, h — 0–1 of the picture


def _edited(box: Box, ops: dict[str, Any]) -> Box | None:
    """A box on the upright original → the same place on the edited picture
    (turned, flipped, cropped: the order ``photos.edits.apply`` uses); None
    when the crop leaves too little of it."""
    x, y, w, h = box
    turn = ops["rotate"]
    if turn == 90:  # clockwise: the left edge becomes the top
        x, y, w, h = 1 - (y + h), x, h, w
    elif turn == 180:
        x, y = 1 - (x + w), 1 - (y + h)
    elif turn == 270:
        x, y, w, h = y, 1 - (x + w), h, w
    if ops["flip"]:
        x = 1 - (x + w)
    c = ops["crop"]
    if c:
        left, top = max(x, c["x"]), max(y, c["y"])
        right, bottom = min(x + w, c["x"] + c["w"]), min(y + h, c["y"] + c["h"])
        if right <= left or bottom <= top or (right - left) * (bottom - top) < KEPT * w * h:
            return None
        x, y, w, h = (left - c["x"]) / c["w"], (top - c["y"]) / c["h"], (right - left) / c["w"], (bottom - top) / c["h"]
    return x, y, w, h


def _main(boxes: list[Box]) -> list[Box]:
    """Without the ones far smaller than the biggest (people in the background)."""
    if not boxes:
        return []
    biggest = max(w * h for _, _, w, h in boxes)
    return [b for b in boxes if b[2] * b[3] >= SMALL * biggest]


def focus_of(faces: list[Box], animals: list[Box], ops: dict[str, Any] | None = None) -> dict[str, float] | None:
    """The part of the shown picture the people and pets are in — one box
    round all of them, ``{"x", "y", "w", "h"}`` as 0–1 of the picture — or
    None when there are none. ``ops``: the photo's edit, when it's shown edited."""
    if ops:
        faces = [b for b in (_edited(f, ops) for f in faces) if b]
        animals = [b for b in (_edited(a, ops) for a in animals) if b]
    boxes = [
        (x - FACE_SIDE * w, y - FACE_ABOVE * h, w * (1 + 2 * FACE_SIDE), h * (1 + FACE_ABOVE + FACE_BELOW))
        for x, y, w, h in _main([f for f in faces if f[2] > 0 and f[3] > 0])
    ] + _main([a for a in animals if a[2] > 0 and a[3] > 0])
    if not boxes:
        return None
    left = min(max(min(b[0] for b in boxes), 0.0), 1.0)
    top = min(max(min(b[1] for b in boxes), 0.0), 1.0)
    right = min(max(max(b[0] + b[2] for b in boxes), 0.0), 1.0)
    bottom = min(max(max(b[1] + b[3] for b in boxes), 0.0), 1.0)
    if right - left < 0.01 or bottom - top < 0.01:
        return None
    return {"x": round(left, 4), "y": round(top, 4), "w": round(right - left, 4), "h": round(bottom - top, 4)}


async def _found(db: AsyncSession, table: str, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[Box]]:
    out: dict[uuid.UUID, list[Box]] = {}
    rows = (await db.execute(text(f"SELECT file_id, box_x, box_y, box_w, box_h FROM {table} WHERE file_id = ANY(:ids)"), {"ids": ids})).all()
    for r in rows:
        out.setdefault(r.file_id, []).append((r.box_x, r.box_y, r.box_w, r.box_h))
    return out


async def _shown(db: AsyncSession, media: dict[uuid.UUID, FileMedia]) -> dict[uuid.UUID, dict[str, Any]]:
    """For each photo, as it's shown (edited, if it has been): its size and its focus."""
    from app.photos import edits

    ids = list(media)
    if not ids:
        return {}
    faces = await _found(db, "photo_faces", ids)
    animals = await _found(db, "photo_animals", ids)
    edited = [fid for fid, m in media.items() if (m.renditions or {}).get(media_urls.RENDITION_FILE["preview_edit"])]
    ops: dict[uuid.UUID, dict[str, Any]] = {}
    if edited:
        rows = (await db.execute(text("SELECT file_id, ops FROM photo_edits WHERE file_id = ANY(:ids)"), {"ids": edited})).all()
        ops = {r.file_id: edits.normalise(r.ops) for r in rows}
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for fid, m in media.items():
        width, height = m.width, m.height
        if m.orientation in (5, 6, 7, 8) and width and height:
            width, height = height, width
        op = ops.get(fid)
        if op and width and height:
            width, height = edits.edited_size(width, height, op)
        out[fid] = {"width": width, "height": height, "focus": focus_of(faces.get(fid, []), animals.get(fid, []), op)}
    return out


def _images(album_ids):  # noqa: ANN001, ANN202 — AlbumItem ⨝ UserFile ⨝ PhotoAsset, photos only
    return (
        select(AlbumItem.album_id, AlbumItem.file_id)
        .join(UserFile, UserFile.id == AlbumItem.file_id)
        .join(PhotoAsset, PhotoAsset.file_id == AlbumItem.file_id)
        .where(AlbumItem.album_id.in_(album_ids), UserFile.trashed_at.is_(None), PhotoAsset.kind == "image")
    )


async def albums(db: AsyncSession, user: User) -> list[dict[str, Any]]:
    """Your albums and the ones shared with you, most recently changed first."""
    from app.photos.albums_router import _cover

    member_of = select(AlbumMember.album_id).where(AlbumMember.user_id == user.id)
    rows = (
        await db.execute(
            select(Album).where(or_(Album.owner_id == user.id, Album.id.in_(member_of))).order_by(Album.updated_at.desc())
        )
    ).scalars().all()
    ids = [a.id for a in rows]
    counts: dict[uuid.UUID, int] = {}
    if ids:
        sub = _images(ids).subquery()
        counts = dict((await db.execute(select(sub.c.album_id, func.count()).group_by(sub.c.album_id))).all())
    out = []
    for a in rows:
        cover = await _cover(db, a, user)
        out.append({
            "id": str(a.id),
            "title": a.title,
            "count": counts.get(a.id, 0),
            "shared": a.owner_id != user.id,
            "cover": (cover or {}).get("thumb"),
        })
    return out


async def pick(db: AsyncSession, user: User, album_id: uuid.UUID, n: int, have: list[uuid.UUID]) -> dict[str, Any] | None:
    """Up to ``n`` photos from the album at random, ones the phone doesn't
    hold (``have``) first; None when the album isn't there for this person."""
    album = await db.get(Album, album_id)
    if album is None:
        return None
    if album.owner_id != user.id and await db.get(AlbumMember, (album.id, user.id)) is None:
        return None
    sub = _images([album.id]).subquery()
    count = (await db.execute(select(func.count()).select_from(sub))).scalar_one()
    q = (
        select(UserFile.id, FileMedia)
        .select_from(AlbumItem)
        .join(UserFile, UserFile.id == AlbumItem.file_id)
        .join(PhotoAsset, PhotoAsset.file_id == AlbumItem.file_id)
        .join(FileMedia, FileMedia.file_id == AlbumItem.file_id)
        .where(
            AlbumItem.album_id == album.id, UserFile.trashed_at.is_(None), PhotoAsset.kind == "image",
            FileMedia.derivative_state == "ready",
        )
    )
    order = [func.random()]
    if have:
        # New ones first; if the album has nothing new, ones it has again.
        order.insert(0, AlbumItem.file_id.in_(have[:MAX_HAVE]))
    rows = (await db.execute(q.order_by(*order).limit(n))).all()
    held = have[:MAX_HAVE]
    # Ones the phone holds: no picture again, only what's known about them
    # now (a focus found since, or moved by an edit).
    kept = {
        m.file_id: m
        for m in (
            await db.execute(select(FileMedia).where(FileMedia.file_id.in_(select(sub.c.file_id).where(sub.c.file_id.in_(held)))))
        ).scalars().all()
    } if held else {}
    about = await _shown(db, {**kept, **{fid: media for fid, media in rows}})
    photos = []
    for fid, media in rows:
        thumb = media_urls.sign_shown(fid, user.id, user.token_version, media.renditions, "thumb")
        url = media_urls.sign_shown(fid, user.id, user.token_version, media.renditions, "preview") or thumb
        if url is None:
            continue
        photos.append({"id": str(fid), "url": url, "thumb": thumb, **about[fid]})
    # Ones the phone holds that have left the album (or gone to the trash): it drops them.
    gone: list[str] = []
    if have:
        still = set((await db.execute(select(sub.c.file_id).where(sub.c.file_id.in_(held)))).scalars().all())
        gone = [str(h) for h in held if h not in still]
    return {
        "album": {"id": str(album.id), "title": album.title, "count": count},
        "photos": photos,
        "held": [{"id": str(fid), **about[fid]} for fid in kept],
        "gone": gone,
    }
