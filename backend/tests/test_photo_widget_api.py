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


# ------------------------------------------------------------------ where the people and pets are


def test_focus_is_a_box_round_the_people_and_pets():
    from app.widgets.photos import FACE_ABOVE, FACE_BELOW, FACE_SIDE, focus_of

    assert focus_of([], []) is None
    # A pet's box is the whole animal: used as it is.
    assert focus_of([], [(0.6, 0.3, 0.35, 0.5)]) == {"x": 0.6, "y": 0.3, "w": 0.35, "h": 0.5}
    # A face's box is only the face: some of the person round it, more below than above.
    f = focus_of([(0.4, 0.4, 0.1, 0.1)], [])
    assert f == {"x": round(0.4 - 0.1 * FACE_SIDE, 4), "y": round(0.4 - 0.1 * FACE_ABOVE, 4),
                 "w": round(0.1 * (1 + 2 * FACE_SIDE), 4), "h": round(0.1 * (1 + FACE_ABOVE + FACE_BELOW), 4)}
    # Someone hugging a dog at the right-hand edge: one box round both, kept inside the picture.
    f = focus_of([(0.86, 0.2, 0.12, 0.2)], [(0.55, 0.35, 0.4, 0.6)])
    assert f["x"] == 0.55 and f["y"] == 0.1 and round(f["x"] + f["w"], 4) == 1.0 and round(f["y"] + f["h"], 4) == 0.95
    # A tiny face far off (someone in the background) doesn't pull the crop away.
    assert focus_of([(0.6, 0.3, 0.2, 0.25), (0.02, 0.5, 0.02, 0.03)], []) == focus_of([(0.6, 0.3, 0.2, 0.25)], [])
    # Two people of about the same size: both.
    two = focus_of([(0.1, 0.3, 0.15, 0.2), (0.7, 0.3, 0.15, 0.2)], [])
    assert two["x"] < 0.1 and two["x"] + two["w"] > 0.85
    # Nonsense boxes are nothing.
    assert focus_of([(0.5, 0.5, 0.0, 0.2)], [(2.0, 2.0, 0.1, 0.1)]) is None


def test_focus_follows_the_photos_edit():
    from app.photos.edits import normalise
    from app.widgets.photos import focus_of

    pet = [(0.6, 0.1, 0.3, 0.2)]  # top right
    box = lambda f: (f["x"], f["y"], round(f["x"] + f["w"], 4), round(f["y"] + f["h"], 4))  # noqa: E731
    assert box(focus_of([], pet, normalise({}))) == (0.6, 0.1, 0.9, 0.3)
    # Turned a quarter clockwise: the top right is now the bottom right.
    assert box(focus_of([], pet, normalise({"rotate": 90}))) == (0.7, 0.6, 0.9, 0.9)
    assert box(focus_of([], pet, normalise({"rotate": 180}))) == (0.1, 0.7, 0.4, 0.9)
    assert box(focus_of([], pet, normalise({"rotate": 270}))) == (0.1, 0.1, 0.3, 0.4)
    # Mirrored: top left.
    assert box(focus_of([], pet, normalise({"flip": True}))) == (0.1, 0.1, 0.4, 0.3)
    # Cropped to the right half: the same dog, further left and twice as wide in what's left.
    assert box(focus_of([], pet, normalise({"crop": {"x": 0.5, "y": 0, "w": 0.5, "h": 1}}))) == (0.2, 0.1, 0.8, 0.3)
    # Cropped out (or nearly): it isn't the subject any more.
    assert focus_of([], pet, normalise({"crop": {"x": 0, "y": 0, "w": 0.5, "h": 1}})) is None
    assert focus_of([], pet, normalise({"crop": {"x": 0, "y": 0, "w": 0.62, "h": 1}})) is None
    # Turned, then cropped (the crop is in the turned picture).
    f = focus_of([], pet, normalise({"rotate": 90, "crop": {"x": 0.5, "y": 0.5, "w": 0.5, "h": 0.5}}))
    assert box(f) == (0.4, 0.2, 0.8, 0.8)


async def _box(db, table, fid, user, box):
    from sqlalchemy import text

    fid = uuid.UUID(fid)
    zero = lambda n: "[1" + ",0" * (n - 1) + "]"  # noqa: E731
    if table == "photo_faces":
        await db.execute(
            text(
                "INSERT INTO photo_faces (file_id, user_id, box_x, box_y, box_w, box_h, score, size_px, model, embedding) "
                "VALUES (:f, :u, :x, :y, :w, :h, 0.9, 120, 'test', CAST(:v AS vector))"
            ),
            {"f": fid, "u": user.id, "x": box[0], "y": box[1], "w": box[2], "h": box[3], "v": zero(512)},
        )
    else:
        await db.execute(
            text(
                "INSERT INTO photo_animals (file_id, user_id, species, box_x, box_y, box_w, box_h, score, size_px, model, "
                "embedding, embedding_dino) VALUES (:f, :u, 'dog', :x, :y, :w, :h, 0.9, 300, 'test', CAST(:e AS vector), "
                "CAST(:d AS vector))"
            ),
            {"f": fid, "u": user.id, "x": box[0], "y": box[1], "w": box[2], "h": box[3], "e": zero(768), "d": zero(384)},
        )
    await db.commit()


async def test_photos_come_with_their_focus(client, db):  # noqa: F811
    from sqlalchemy import text

    from app.files.models import FileMedia

    ann = await mk_user(db, "ann")
    bob = await mk_user(db, "bob")
    phone = await _device(db, ann, ["widgets"])
    bobs_phone = await _device(db, bob, ["widgets"])
    plain, hug, edited = await _photo(db, ann), await _photo(db, ann), await _photo(db, ann)
    await _box(db, "photo_faces", hug, ann, (0.86, 0.2, 0.12, 0.2))
    await _box(db, "photo_animals", hug, ann, (0.55, 0.35, 0.4, 0.6))
    # Shown edited (turned a quarter, cropped to its lower half): the size and the focus are the edited picture's.
    await _box(db, "photo_animals", edited, ann, (0.6, 0.1, 0.3, 0.2))
    await db.execute(
        text("INSERT INTO photo_edits (file_id, ops) VALUES (:f, CAST(:o AS jsonb))"),
        {"f": uuid.UUID(edited), "o": '{"rotate": 90, "crop": {"x": 0, "y": 0.5, "w": 1, "h": 0.5}}'},
    )
    media = await db.get(FileMedia, uuid.UUID(edited))
    media.renditions = {**media.renditions, "preview.edit.webp": {"bytes": 90}, "thumb.edit.webp": {"bytes": 9}}
    await db.commit()
    album = await _album(client, ann, "Biscuit", [plain, hug, edited])

    out = (await client.get(f"/api/widgets/photos/albums/{album}", auth=phone, params={"n": 12})).json()
    got = {p["id"]: p for p in out["photos"]}
    assert got[plain]["focus"] is None  # nothing known: the phone crops as it always did
    f = got[hug]["focus"]
    assert (f["x"], f["y"]) == (0.55, 0.1) and round(f["x"] + f["w"], 4) == 1.0 and round(f["y"] + f["h"], 4) == 0.95
    assert out["held"] == []
    # The photo is 4000×3000 stored on its side → 3000×4000 upright → turned again → 4000×3000 → its lower half.
    assert (got[edited]["width"], got[edited]["height"]) == (4000, 1500)
    e = got[edited]["focus"]
    assert (e["x"], e["y"], round(e["x"] + e["w"], 4), round(e["y"] + e["h"], 4)) == (0.7, 0.2, 0.9, 0.8)

    # Ones the phone already holds: no picture again, but what's known about them now.
    out = (await client.get(f"/api/widgets/photos/albums/{album}", auth=phone, params={"n": 1, "have": [hug, plain, str(uuid.uuid4())]})).json()
    held = {h["id"]: h for h in out["held"]}
    assert set(held) == {hug, plain}
    assert held[hug]["focus"] == f and held[plain]["focus"] is None
    assert (held[hug]["width"], held[hug]["height"]) == (3000, 4000)
    assert "url" not in held[hug]
    assert [p["id"] for p in out["photos"]] == [edited]

    # Someone the album is shared with gets the same box (it's where to crop, nothing about who).
    assert (await client.post(f"/api/photos/albums/{album}/members", headers=H(ann), json={"user_id": str(bob.id)})).status_code == 201
    out = (await client.get(f"/api/widgets/photos/albums/{album}", auth=bobs_phone, params={"n": 12})).json()
    assert {p["id"]: p["focus"] for p in out["photos"]}[hug] == f
