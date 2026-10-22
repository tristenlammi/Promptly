"""Export my library (WP-10.4): everything you own as an ordinary folder
tree — original names and folders, documents as .docx, photos with JSON and
XMP sidecars — streamed in parts; and a Promptly export imported elsewhere
comes back with its dates, places, favourites and albums."""
from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from tests.test_takeout_run_wp102 import T2019, _auth, _import, _path, client, make_takeout, root  # noqa: F401


async def _library(client, db, user, tmp_path):
    """A Takeout's worth of photos (dates, places, a favourite, an archived
    one, an album), a Drive spreadsheet, a document, an empty folder and a
    file in the trash."""
    from app.files.documents_router import create_blank_document
    from app.files.media_meta import extract_and_store
    from app.files.models import FileFolder, UserFile
    from app.files.storage import absolute_path

    job = await _import(client, user, make_takeout(tmp_path))
    assert job["state"] == "done", job["error"]
    for f in (await db.execute(select(UserFile).where(UserFile.user_id == user.id))).scalars().all():
        if f.mime_type.startswith(("image/", "video/")):
            await extract_and_store(f.id)
    trips = FileFolder(user_id=user.id, name="Trips")
    db.add(trips)
    await db.flush()
    db.add(FileFolder(user_id=user.id, name="Empty for now", parent_id=trips.id))
    doc = await create_blank_document(db, owner_id=user.id, folder_id=trips.id, name="Packing list")
    await db.commit()
    absolute_path(doc.storage_path).write_text(
        "<h1>Packing list</h1><ul><li><p>Tent</p></li><li><p>Torch <strong>and batteries</strong></p></li></ul>", "utf-8"
    )
    gone = (await db.execute(select(UserFile).where(UserFile.user_id == user.id, UserFile.filename == "Budget.xlsx"))).scalar_one()
    old = UserFile(user_id=user.id, filename="old.txt", original_filename="old.txt", mime_type="text/plain",
                   size_bytes=1, storage_path=gone.storage_path, folder_id=trips.id, trashed_at=datetime.now(timezone.utc))
    db.add(old)
    await db.commit()


async def _download(client, url) -> zipfile.ZipFile:
    r = await client.get("/api" + url)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    return zipfile.ZipFile(io.BytesIO(r.content))


@pytest.mark.asyncio
async def test_the_whole_library_as_a_folder_tree(client, db, user, tmp_path):
    from docx import Document

    await _library(client, db, user, tmp_path)
    r = await client.post("/api/files/exports", json={"part_gb": 2}, headers=_auth(user))
    assert r.status_code == 201, r.text
    export = r.json()
    assert export["counts"]["photos"] == 4 and export["counts"]["documents"] == 1
    assert len(export["parts"]) == 1 and export["parts"][0]["name"].endswith("-001.zip")
    # It's still there for the page to show.
    assert (await client.get("/api/files/exports/current", headers=_auth(user))).json()["id"] == export["id"]

    z = await _download(client, export["parts"][0]["url"])
    names = set(z.namelist())
    F = "Promptly/My files/"
    assert {"Promptly/README.txt", "Promptly/albums.json"} <= names
    beach = F + "Photos/2019/06/IMG_0001.jpg"
    assert {beach, beach + ".json", beach + ".xmp", F + "Google Drive/Plans/Budget.xlsx",
            F + "Trips/Packing list.docx", F + "Trips/Empty for now/"} <= names
    assert not any(n.endswith("old.txt") for n in names)  # the trash isn't exported

    side = json.loads(z.read(beach + ".json"))
    assert side["photoTakenTime"]["timestamp"] == str(T2019)
    assert (side["geoData"]["latitude"], side["geoData"]["longitude"]) == (-26.39, 153.09)
    assert side["description"] == "Noosa main beach" and side["favorited"] is True
    assert side["promptly"]["albums"] == ["Holiday in Noosa"]
    xmp = z.read(beach + ".xmp").decode()
    assert 'exif:GPSLatitude="26,23.400000S"' in xmp and "Noosa main beach" in xmp
    archived = json.loads(z.read(F + "Photos/2020/08/IMG_0003.jpg.json"))
    assert archived["archived"] is True
    albums = json.loads(z.read("Promptly/albums.json"))
    assert albums == [{"title": "Holiday in Noosa", "description": None, "items": ["My files/Photos/2019/06/IMG_0001.jpg"]}]

    doc = Document(io.BytesIO(z.read(F + "Trips/Packing list.docx")))
    assert [(p.style.name, p.text) for p in doc.paragraphs] == [
        ("Heading 1", "Packing list"), ("List Bullet", "Tent"), ("List Bullet", "Torch and batteries"),
    ]
    # Each file keeps its date (the zip's extended timestamp, in UTC).
    info = z.getinfo(beach)
    assert info.compress_type == zipfile.ZIP_STORED and info.extra[:4] == b"UT\x05\x00"

    # Someone else's link to it is no link at all.
    other = await _other_user(db)
    from app.files import media_urls

    forged = media_urls.sign(uuid.UUID(export["id"]), other.id, other.token_version, "export", 1)
    assert (await client.get("/api" + forged)).status_code == 404


@pytest.mark.asyncio
async def test_a_big_library_is_split_into_parts(client, db, user, tmp_path, monkeypatch):
    from app.files import library_export

    await _library(client, db, user, tmp_path)
    monkeypatch.setattr(library_export, "_GB", 4096)  # "2 GB" parts of 8 KB
    export = (await client.post("/api/files/exports", json={"part_gb": 2}, headers=_auth(user))).json()
    assert len(export["parts"]) > 2
    seen: list[str] = []
    for part in export["parts"]:
        seen += (await _download(client, part["url"])).namelist()
    assert len(seen) == len(set(seen))  # each file in exactly one part
    assert "Promptly/My files/Trips/Packing list.docx" in seen
    # A new export replaces the last one.
    again = (await client.post("/api/files/exports", json={"part_gb": 10}, headers=_auth(user))).json()
    assert (await client.get("/api" + export["parts"][0]["url"])).status_code == 404
    assert (await client.get("/api/files/exports/current", headers=_auth(user))).json()["id"] == again["id"]


@pytest.mark.asyncio
async def test_an_export_imported_elsewhere_comes_back_whole(client, db, user, tmp_path):
    from app.files.media_meta import extract_and_store
    from app.files.models import FileMedia, UserFile
    from app.photos.album_models import Album, AlbumItem
    from app.photos.models import PhotoAsset
    from tests.test_folder_import_wp103 import _run

    await _library(client, db, user, tmp_path)
    export = (await client.post("/api/files/exports", json={"part_gb": 2}, headers=_auth(user))).json()
    r = await client.get("/api" + export["parts"][0]["url"])
    path = tmp_path / export["parts"][0]["name"]
    path.write_bytes(r.content)

    other = await _other_user(db)
    job = await _run(client, other, [path], "folder")
    assert job["state"] == "done", job["error"]
    assert job["report"]["albums"] == [{"title": "Holiday in Noosa", "count": 1}]
    files = {f.filename: f for f in (await db.execute(select(UserFile).where(UserFile.user_id == other.id))).scalars()}
    # Its sidecars and the export's own notes aren't files; the rest keep their folders.
    assert not any(n.endswith((".json", ".xmp")) or n == "README.txt" for n in files)
    root_name = "Imported – " + export["parts"][0]["name"][: -len(".zip")]
    assert await _path(db, files["Packing list.docx"].folder_id) == [root_name, "Trips"]
    assert await _path(db, files["Budget.xlsx"].folder_id) == [root_name, "Google Drive", "Plans"]

    beach = files["IMG_0001.jpg"]
    await extract_and_store(beach.id)
    await extract_and_store(files["IMG_0003.jpg"].id)
    m = await db.get(FileMedia, beach.id, populate_existing=True)
    assert m.taken_at.timestamp() == T2019 and (round(m.lat, 4), round(m.lon, 4)) == (-26.39, 153.09)
    assert beach.starred_at is not None
    assert (await db.get(PhotoAsset, files["IMG_0003.jpg"].id, populate_existing=True)).archived_at is not None
    album = (await db.execute(select(Album).where(Album.owner_id == other.id))).scalars().one()
    assert album.title == "Holiday in Noosa"
    assert [i.file_id for i in (await db.execute(select(AlbumItem).where(AlbumItem.album_id == album.id))).scalars()] == [beach.id]


async def _other_user(db):
    from app.auth.models import User

    row = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row
