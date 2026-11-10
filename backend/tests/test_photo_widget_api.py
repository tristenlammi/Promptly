"""The Photo widget's reads (``/api/widgets/photos/…``): the albums a phone
can pick from, and a few random photos of one.

* the ``widgets`` scope, as the other widgets;
* only your albums and ones shared with you — a stranger's album is 404 and
  never listed;
* photos only (no videos), nothing from the trash, nothing whose preview
  isn't made yet; ones the phone already holds come last.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from tests.test_calendar import H, client, mk_user  # noqa: F401 — fixtures
from tests.test_notes_widgets_api import _device
from tests.test_understanding_ph21 import _photos_folder


async def _photo(db, user, *, kind="image", ready=True):
    from app.files.models import FileMedia, UserFile
    from app.photos.library import sync

    fid = uuid.uuid4()
    folder = await _photos_folder(db, user)
    mime = "image/jpeg" if kind == "image" else "video/mp4"
    db.add(UserFile(id=fid, user_id=user.id, folder_id=folder.id, filename=f"{fid}.jpg", original_filename="x.jpg",
                    mime_type=mime, size_bytes=1, storage_path=f"u/{fid}"))
    await db.flush()
    now = datetime.now(timezone.utc)
    db.add(FileMedia(
        file_id=fid, kind=kind, taken_at=now, extracted_at=now, width=4000, height=3000, orientation=6,
        derivative_state="ready" if ready else "pending",
        renditions={"thumb.webp": {"bytes": 10}, "preview.webp": {"bytes": 100}} if ready else None,
    ))
    await db.flush()
    await sync(db, fid)
    await db.commit()
    return str(fid)


async def _album(client, u, title, ids):  # noqa: F811
    r = await client.post("/api/photos/albums", headers=H(u), json={"title": title, "file_ids": ids})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_scope_and_whose_albums(client, db):  # noqa: F811
    ann = await mk_user(db, "ann")
    bob = await mk_user(db, "bob")
    cat = await mk_user(db, "cat")
    phone = await _device(db, ann, ["upload", "widgets"])
    no_widgets = await _device(db, ann, ["upload"])
    bobs_phone = await _device(db, bob, ["widgets"])
    cats_phone = await _device(db, cat, ["widgets"])

    a1, a2 = await _photo(db, ann), await _photo(db, ann)
    video = await _photo(db, ann, kind="video")
    dog = await _album(client, ann, "Biscuit", [a1, a2, video])
    await _album(client, ann, "Empty one", [])
    assert (await client.post(f"/api/photos/albums/{dog}/members", headers=H(ann), json={"user_id": str(bob.id)})).status_code == 201

    assert (await client.get("/api/widgets/photos/albums")).status_code == 401
    assert (await client.get("/api/widgets/photos/albums", auth=no_widgets)).status_code == 403
    assert (await client.get(f"/api/widgets/photos/albums/{dog}", auth=no_widgets)).status_code == 403

    mine = (await client.get("/api/widgets/photos/albums", auth=phone)).json()["albums"]
    assert {(x["title"], x["count"], x["shared"]) for x in mine} == {("Biscuit", 2, False), ("Empty one", 0, False)}
    assert next(x for x in mine if x["title"] == "Biscuit")["cover"].startswith("/m/")
    assert next(x for x in mine if x["title"] == "Empty one")["cover"] is None

    # Shared with Bob: listed as shared, and he can have its photos.
    bobs = (await client.get("/api/widgets/photos/albums", auth=bobs_phone)).json()["albums"]
    assert [(x["title"], x["count"], x["shared"]) for x in bobs] == [("Biscuit", 2, True)]
    assert (await client.get(f"/api/widgets/photos/albums/{dog}", auth=bobs_phone)).status_code == 200

    # Cat has nothing to do with it: not listed, and 404 by id.
    assert (await client.get("/api/widgets/photos/albums", auth=cats_phone)).json() == {"albums": []}
    r = await client.get(f"/api/widgets/photos/albums/{dog}", auth=cats_phone)
    assert r.status_code == 404 and r.json()["detail"] == "That album isn't there any more."
    assert (await client.get(f"/api/widgets/photos/albums/{uuid.uuid4()}", auth=phone)).status_code == 404

    # Taken out of the album: gone for Bob from the next ask.
    assert (await client.delete(f"/api/photos/albums/{dog}/members/{bob.id}", headers=H(ann))).status_code == 204
    assert (await client.get(f"/api/widgets/photos/albums/{dog}", auth=bobs_phone)).status_code == 404


async def test_random_photos_no_videos_no_trash(client, db):  # noqa: F811
    from app.files.models import UserFile

    ann = await mk_user(db, "ann")
    phone = await _device(db, ann, ["widgets"])
    photos = [await _photo(db, ann) for _ in range(5)]
    video = await _photo(db, ann, kind="video")
    waiting = await _photo(db, ann, ready=False)
    binned = await _photo(db, ann)
    album = await _album(client, ann, "Biscuit", [*photos, video, waiting, binned])
    row = await db.get(UserFile, uuid.UUID(binned))
    row.trashed_at = datetime.now(timezone.utc)
    await db.commit()

    r = await client.get(f"/api/widgets/photos/albums/{album}", auth=phone, params={"n": 12})
    assert r.status_code == 200, r.text
    out = r.json()
    # Photos in the album (the one still waiting for its preview counts; it just isn't sent yet).
    assert out["album"] == {"id": album, "title": "Biscuit", "count": 6}
    assert {p["id"] for p in out["photos"]} == set(photos)
    one = out["photos"][0]
    assert one["url"].startswith("/m/") and one["thumb"].startswith("/m/") and one["url"] != one["thumb"]
    assert (one["width"], one["height"]) == (3000, 4000)  # shown turned

    # Ones the phone holds come last: asking for two with three held gives the other two.
    r = await client.get(f"/api/widgets/photos/albums/{album}", auth=phone, params={"n": 2, "have": photos[:3]})
    assert {p["id"] for p in r.json()["photos"]} == set(photos[3:])
    # Holding them all still gives photos (a small album goes round again).
    r = await client.get(f"/api/widgets/photos/albums/{album}", auth=phone, params={"n": 3, "have": photos})
    assert len(r.json()["photos"]) == 3
    assert r.json()["gone"] == []
    assert (await client.get(f"/api/widgets/photos/albums/{album}", auth=phone, params={"n": 13})).status_code == 422

    # Held ones that are in the trash or aren't photos of this album: the phone drops them.
    r = await client.get(f"/api/widgets/photos/albums/{album}", auth=phone, params={"n": 1, "have": [photos[1], binned, video]})
    assert set(r.json()["gone"]) == {binned, video}

    # An album with no photos: there, and empty.
    empty = await _album(client, ann, "Empty", [video])
    out = (await client.get(f"/api/widgets/photos/albums/{empty}", auth=phone)).json()
    assert out["album"]["count"] == 0 and out["photos"] == []
