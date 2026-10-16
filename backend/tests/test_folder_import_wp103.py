"""Importing a folder of photos or an Apple export (WP-10.3): the same run as
a Takeout, read differently — the photo's own date first, then an XMP
sidecar or Apple's photo details, then the file's date in the archive."""
from __future__ import annotations

import io
import uuid
import zipfile
from datetime import datetime, timezone

import pytest
from sqlalchemy import select


def test_xmp_and_dates_are_read_strictly():
    from app.imports.folders import parse_date, parse_xmp

    xmp = b"""<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        exif:GPSLatitude="26,23.4000S" exif:GPSLongitude="153,5.4000E" photoshop:DateCreated="2019-06-01T09:00:00+10:00">
        <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Sunrise at Noosa</rdf:li></rdf:Alt></dc:description>
      </rdf:Description></rdf:RDF></x:xmpmeta>"""
    got = parse_xmp(xmp)
    assert got["when"] == int(datetime(2019, 5, 31, 23, tzinfo=timezone.utc).timestamp())
    assert (got["lat"], got["lon"]) == (-26.39, 153.09) and got["description"] == "Sunrise at Noosa"
    # A date with no zone stays a wall-clock time; one we can't read is dropped, never guessed.
    assert parse_date("2019:06:01 09:00:00") == datetime(2019, 6, 1, 9)
    assert parse_date("Tuesday January 14,2020 3:22 PM GMT") == int(datetime(2020, 1, 14, 15, 22, tzinfo=timezone.utc).timestamp())
    assert parse_date("sometime last spring") is None


def _jpeg(colour, tag=b"") -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (16, 12), colour).save(buf, "JPEG")
    return buf.getvalue() + tag


def _docx() -> bytes:
    import docx

    d = docx.Document()
    d.add_paragraph("Recipe")
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def _zip(path, members: dict[str, tuple[bytes, tuple]]):
    with zipfile.ZipFile(path, "w") as zf:
        for name, (data, when) in members.items():
            info = zipfile.ZipInfo(name, date_time=when)
            zf.writestr(info, data)
    return path


@pytest.fixture
def client_and_user(client, user):
    return client, user


@pytest.mark.asyncio
async def test_a_folder_zip_is_filed_by_date_and_its_files_keep_their_folders(client, db, user, tmp_path):
    from app.auth.models import User
    from app.files.models import UserFile
    from tests.test_takeout_run_wp102 import _auth, _path

    me = await db.get(User, user.id)
    me.settings = {**(me.settings or {}), "timezone": "Australia/Brisbane"}
    await db.commit()
    path = _zip(tmp_path / "Old laptop.zip", {
        "Pictures/2014/beach.jpg": (_jpeg((1, 1, 1)), (2014, 2, 1, 7, 30, 0)),  # no EXIF: its date in the zip
        "Pictures/2014/._beach.jpg": (b"junk", (2014, 2, 1, 7, 30, 0)),
        "__MACOSX/Pictures/x": (b"junk", (2014, 2, 1, 7, 30, 0)),
        "Documents/Recipes/Pancakes.docx": (_docx(), (2015, 3, 3, 3, 3, 3)),
    })
    job = await _run(client, user, [path], "folder")
    assert job["state"] == "done", job["error"]
    assert job["report"]["photos"] == 1 and job["report"]["drive_files"] == 1
    files = {f.filename: f for f in (await db.execute(select(UserFile).where(UserFile.user_id == user.id))).scalars()}
    assert set(files) == {"beach.jpg", "Pancakes.docx"}
    # 1 Feb 2014 07:30 on that laptop's clock, in the owner's zone.
    assert await _path(db, files["beach.jpg"].folder_id) == ["Camera Uploads", "2014", "02"]
    assert files["beach.jpg"].client_mtime == datetime(2014, 1, 31, 21, 30, tzinfo=timezone.utc)
    assert await _path(db, files["Pancakes.docx"].folder_id) == ["Imported – Old laptop", "Documents", "Recipes"]


@pytest.mark.asyncio
async def test_an_apple_export_brings_its_xmp_and_photo_details(client, db, user, tmp_path):
    from app.files.models import UserFile
    from app.imports.models import FileImportMeta
    from tests.test_takeout_run_wp102 import _auth

    xmp = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
           b'<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" '
           b'exif:DateTimeOriginal="2018-12-25T08:00:00Z" exif:GPSLatitude="51,30.0000N" exif:GPSLongitude="0,7.2000W">'
           b'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Christmas morning</rdf:li></rdf:Alt></dc:title>'
           b"</rdf:Description></rdf:RDF></x:xmpmeta>")
    details = (b"imgName,fileChecksum,favorite,hidden,deleted,originalCreationDate,viewCount,importDate\n"
               b'IMG_0101.JPG,abc,yes,no,no,"Tuesday January 14,2020 3:22 PM GMT",0,x\n'
               b'IMG_0102.JPG,def,no,no,yes,"Tuesday January 14,2020 3:30 PM GMT",0,x\n')
    path = _zip(tmp_path / "iCloud Photos Part 1 of 1.zip", {
        "Photos/IMG_0100.JPG": (_jpeg((5, 5, 5), b"a"), (2026, 1, 1, 0, 0, 0)),
        "Photos/IMG_0100.xmp": (xmp, (2026, 1, 1, 0, 0, 0)),
        "Photos/IMG_0101.JPG": (_jpeg((6, 6, 6), b"b"), (2026, 1, 1, 0, 0, 0)),
        "Photos/IMG_0102.JPG": (_jpeg((7, 7, 7), b"c"), (2026, 1, 1, 0, 0, 0)),
        "Photo Details.csv": (details, (2026, 1, 1, 0, 0, 0)),
    })
    job = await _run(client, user, [path], "apple")
    assert job["state"] == "done", job["error"]
    assert job["report"]["skipped"]["trash"] == 1  # deleted in iCloud
    files = {f.filename: f for f in (await db.execute(select(UserFile).where(UserFile.user_id == user.id))).scalars()}
    assert "IMG_0102.JPG" not in files
    xm = await db.get(FileImportMeta, files["IMG_0100.JPG"].id)
    assert xm.taken_at == datetime(2018, 12, 25, 8, tzinfo=timezone.utc) and xm.description == "Christmas morning"
    assert (xm.lat, xm.lon) == (51.5, -0.12) and xm.source == "apple"
    csv = await db.get(FileImportMeta, files["IMG_0101.JPG"].id)
    assert csv.taken_at == datetime(2020, 1, 14, 15, 22, tzinfo=timezone.utc)
    assert files["IMG_0101.JPG"].starred_at is not None  # a favourite in iCloud


async def _run(client, user, paths, source):
    from tests.test_takeout_index_wp101 import _upload_part
    from tests.test_takeout_run_wp102 import _auth

    job = (await client.post("/api/imports", json={"source": source}, headers=_auth(user))).json()
    for p in paths:
        await _upload_part(client, user, job["id"], p)
    await client.post(f"/api/imports/{job['id']}/check", headers=_auth(user))
    got = (await client.get(f"/api/imports/{job['id']}", headers=_auth(user))).json()
    assert got["state"] == "ready", got["error"]
    await client.post(f"/api/imports/{job['id']}/start", headers=_auth(user))
    return (await client.get(f"/api/imports/{job['id']}", headers=_auth(user))).json()


# The run tests' fixtures (an inline queue, a scratch upload root).
from tests.test_takeout_run_wp102 import client, root  # noqa: E402,F401
