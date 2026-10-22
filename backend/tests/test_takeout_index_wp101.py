"""Reading a Google Takeout (WP-10.1): every part indexed, each photo matched
with the JSON Google wrote beside it — whichever of Takeout's naming quirks
it uses — and a dry-run report before anything is imported."""
from __future__ import annotations

import io
import json
import tarfile
import uuid
import zipfile
from datetime import datetime, timezone

import httpx
import pytest


def test_sidecar_names_every_way_google_writes_them():
    from app.imports.takeout import sidecar_key, split_counter, strip_extra

    assert sidecar_key("IMG_0001.jpg.json") == ("IMG_0001.jpg", None)
    assert sidecar_key("IMG_0001.jpg.supplemental-metadata.json") == ("IMG_0001.jpg", None)
    assert sidecar_key("IMG_0001.jpg.supplemental-metadata(1).json") == ("IMG_0001.jpg", 1)
    assert sidecar_key("IMG_0001.jpg(1).supplemental-metadata.json") == ("IMG_0001.jpg", 1)
    assert sidecar_key("IMG_0001.jpg(2).json") == ("IMG_0001.jpg", 2)
    # Cut short at 51 characters: what's left of the suffix goes.
    assert sidecar_key("PXL_20240817_202602411.mp4.supplemental-metada.json") == ("PXL_20240817_202602411.mp4", None)
    assert sidecar_key("PXL_20240817_202602411123456789.jpg.supp.json") == ("PXL_20240817_202602411123456789.jpg", None)
    assert sidecar_key("IMG_2367.HEIC.suppl(1).json") == ("IMG_2367.HEIC", 1)
    assert sidecar_key("IMG_0001.jpg..json") == ("IMG_0001.jpg", None)
    assert split_counter("IMG_0001(1).jpg") == ("IMG_0001.jpg", 1)
    assert split_counter("IMG_0001.jpg") == ("IMG_0001.jpg", None)
    assert strip_extra("IMG_0003-edited.jpg") == "IMG_0003.jpg"
    assert strip_extra("IMG_0003-bearbeitet.jpg") == "IMG_0003.jpg"
    assert strip_extra("IMG_0003.jpg") is None


def _jpeg(colour) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), colour).save(buf, "JPEG")
    return buf.getvalue()


def _sidecar(title, ts, lat=0.0, lon=0.0, **extra):
    return json.dumps({
        "title": title, "description": extra.pop("description", ""),
        "photoTakenTime": {"timestamp": str(ts), "formatted": "x"},
        "creationTime": {"timestamp": str(ts + 100)},
        "geoData": {"latitude": lat, "longitude": lon, "altitude": 0.0},
        **extra,
    }).encode()


LONG = "PXL_20200817_202602411123456789_LONGNAME.jpg"  # its sidecar name is cut at 51 characters


def make_takeout(tmp_path):
    """A three-part Takeout, photos and their JSON split between parts."""
    ts2019, ts2020 = int(datetime(2019, 6, 1, 9, tzinfo=timezone.utc).timestamp()), int(datetime(2020, 8, 17, tzinfo=timezone.utc).timestamp())
    p = "Takeout/Google Photos/"
    one = {
        p + "Photos from 2019/IMG_0001.jpg": _jpeg((1, 2, 3)),
        p + "Photos from 2019/IMG_0001(1).jpg": _jpeg((4, 5, 6)),
        p + "Photos from 2019/IMG_0002.HEIC": b"\x00\x00\x00\x18ftypheic" + b"\x00" * 40,
        p + "Photos from 2019/IMG_0002.MOV": b"\x00\x00\x00\x14ftypqt  " + b"\x00" * 40,
        p + "Holiday in Noosa/IMG_0001.jpg": _jpeg((1, 2, 3)),
        p + "Holiday in Noosa/metadata.json": json.dumps({"title": "Holiday in Noosa", "description": ""}).encode(),
        p + f"Photos from 2020/{LONG}": _jpeg((7, 8, 9)),
        p + "Photos from 2020/IMG_0003.jpg": _jpeg((10, 11, 12)),
        p + "Photos from 2020/IMG_0003-edited.jpg": _jpeg((13, 14, 15)),
        p + "Photos from 2019/binned.jpg": _jpeg((16, 17, 18)),
        "Takeout/YouTube and YouTube Music/history/watch-history.json": b"[]",
        "Takeout/Drive/Plans/Budget.xlsx": b"PK\x03\x04 not really",
        "Takeout/archive_browser.html": b"<html></html>",
    }
    long_sidecar = (LONG + ".supplemental-metadata.json")
    long_sidecar = long_sidecar[: 51 - len(".json")] + ".json"
    two = {
        p + "Photos from 2019/IMG_0001.jpg.supplemental-metadata.json": _sidecar("IMG_0001.jpg", ts2019, -26.39, 153.09, description="Noosa main beach", favorited=True),
        p + "Photos from 2019/IMG_0001.jpg.supplemental-metadata(1).json": _sidecar("IMG_0001.jpg", ts2019 + 60),
        p + "Photos from 2019/IMG_0002.HEIC.json": _sidecar("IMG_0002.HEIC", ts2019 + 120),
        p + "Holiday in Noosa/IMG_0001.jpg.supplemental-metadata.json": _sidecar("IMG_0001.jpg", ts2019, -26.39, 153.09),
        p + f"Photos from 2020/{long_sidecar}": _sidecar(LONG, ts2020, 51.5, -0.12),
        p + "Photos from 2020/IMG_0003.jpg.supplemental-metadata.json": _sidecar("IMG_0003.jpg", ts2020 + 5, archived=True),
        p + "Photos from 2019/binned.jpg.supplemental-metadata.json": _sidecar("binned.jpg", ts2019, trashed=True),
    }
    three = {
        p + "Photos from 2021/IMG_0100.jpg": _jpeg((20, 21, 22)),  # no JSON at all
        p + "Photos from 2021/renamed by google.jpg": _jpeg((23, 24, 25)),
        p + "Photos from 2021/something else.json": _sidecar("renamed by google.jpg", int(datetime(2021, 3, 3, tzinfo=timezone.utc).timestamp())),
    }
    paths = []
    for i, members in enumerate((one, two)):
        path = tmp_path / f"takeout-2026-001-00{i + 1}.zip"
        with zipfile.ZipFile(path, "w") as zf:
            for name, data in members.items():
                zf.writestr(name, data)
        paths.append(path)
    tgz = tmp_path / "takeout-2026-001-003.tgz"
    with tarfile.open(tgz, "w:gz") as tf:
        for name, data in three.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    paths.append(tgz)
    return paths


def test_a_three_part_takeout_is_read_and_matched(tmp_path):
    from app.imports.takeout import build_plan, scan_part

    scans = [scan_part(path, i) for i, path in enumerate(make_takeout(tmp_path))]
    plan, report = build_plan(scans)
    by_name = {}
    for p in plan["photos"]:
        by_name.setdefault(p["name"], []).append(p)

    first = next(p for p in by_name["IMG_0001.jpg"] if p["description"])
    assert first["taken"] == int(datetime(2019, 6, 1, 9, tzinfo=timezone.utc).timestamp())
    assert (first["lat"], first["lon"]) == (-26.39, 153.09) and first["favorite"] is True
    assert by_name["IMG_0001(1).jpg"][0]["taken"] == first["taken"] + 60
    # The Live Photo's video shares the still's JSON.
    assert by_name["IMG_0002.MOV"][0]["taken"] == by_name["IMG_0002.HEIC"][0]["taken"]
    assert by_name[LONG][0]["lat"] == 51.5  # its JSON's name was cut short
    assert by_name["IMG_0003-edited.jpg"][0]["taken"] == by_name["IMG_0003.jpg"][0]["taken"]
    assert by_name["IMG_0003.jpg"][0]["archived"] is True
    assert by_name["renamed by google.jpg"][0]["taken"] is not None  # matched by its title
    assert by_name["IMG_0100.jpg"][0]["taken"] is None and by_name["IMG_0100.jpg"][0]["folder_year"] == 2021
    assert "binned.jpg" not in by_name  # it was in Google's trash

    # The album's copy of IMG_0001 is the year folder's photo, once.
    assert len(by_name["IMG_0001.jpg"]) == 1
    assert report["albums"] == [{"title": "Holiday in Noosa", "count": 1}]
    assert plan["albums"]["Holiday in Noosa"] == [plan["photos"].index(first)]

    # 8 stills and the Live Photo's video; the trashed one and the album's copy aren't extra.
    assert report["photos"] == 8 and report["videos"] == 1
    assert report["with_details"] == 8 and report["matched_by"]["none"] == 1
    assert report["drive_files"] == 1 and plan["drive"][0]["path"] == "Plans/Budget.xlsx"
    assert report["skipped"]["trash"] == 1 and report["skipped"]["other_products"] == 1
    assert report["other_products"] == ["YouTube and YouTube Music"]
    assert report["years"] == [2019, 2021] and report["favorites"] == 1
    assert report["archived"] == 2  # the edited copy of an archived photo shares its JSON


# ------------------------------------------------------------------ the API


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    up = tmp_path / "uploads"
    up.mkdir()
    monkeypatch.setattr(storage, "UPLOAD_ROOT", up.resolve())
    return up


@pytest.fixture
async def client(db, root, monkeypatch):
    from app import rate_limit
    from app.config import get_settings
    from app.imports import jobs
    from app.main import app

    monkeypatch.setattr(get_settings(), "TUS_HOOK_SECRET", None)

    async def inline(job_id):
        await jobs.index(job_id)

    monkeypatch.setattr(jobs, "enqueue_index", inline)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def _hook(kind, user, *, size, meta, upload_id="", offset=0):
    return {"Type": kind, "Event": {
        "Upload": {"ID": upload_id, "Size": size, "SizeIsDeferred": False, "Offset": offset, "IsPartial": False,
                   "IsFinal": False, "MetaData": meta, "PartialUploads": None, "Storage": None},
        "HTTPRequest": {"Method": "POST", "URI": "/api/files/tus/", "RemoteAddr": "x",
                        "Header": {"Authorization": [_auth(user)["Authorization"]]}},
    }}


async def _upload_part(client, user, job_id, path):
    from app.files.tus_hooks import tus_dir

    meta = {"filename": path.name, "import_job": job_id}
    size = path.stat().st_size
    r = (await client.post("/api/internal/tus-hook", json=_hook("pre-create", user, size=size, meta=meta))).json()
    assert "ChangeFileInfo" in r, r
    uid = r["ChangeFileInfo"]["ID"]
    tus_dir().mkdir(parents=True, exist_ok=True)
    (tus_dir() / uid).write_bytes(path.read_bytes())
    r = (await client.post("/api/internal/tus-hook", json=_hook("pre-finish", user, size=size, meta=meta, upload_id=uid, offset=size))).json()
    assert r["HTTPResponse"]["Header"]["Upload-File-Id"].startswith("import-part-"), r


@pytest.mark.asyncio
async def test_parts_upload_beside_drive_and_the_check_reports(client, db, user, tmp_path, root):
    from app.files.models import UserFile
    from sqlalchemy import func, select

    job = (await client.post("/api/imports", json={"source": "takeout"}, headers=_auth(user))).json()
    assert job["state"] == "collecting"
    for path in make_takeout(tmp_path):
        await _upload_part(client, user, job["id"], path)
    # A part has to be an archive; and none of this is a Drive file.
    bad = (await client.post("/api/internal/tus-hook", json=_hook("pre-create", user, size=5, meta={"filename": "notes.txt", "import_job": job["id"]}))).json()
    assert bad["RejectUpload"] is True and bad["HTTPResponse"]["StatusCode"] == 400
    assert await db.scalar(select(func.count(UserFile.id)).where(UserFile.user_id == user.id)) == 0

    got = (await client.get(f"/api/imports/{job['id']}", headers=_auth(user))).json()
    assert [p["n"] for p in got["parts"]] == [1, 2, 3]
    r = await client.post(f"/api/imports/{job['id']}/check", headers=_auth(user))
    assert r.status_code == 200
    done = (await client.get(f"/api/imports/{job['id']}", headers=_auth(user))).json()
    assert done["state"] == "ready", done["error"]
    assert done["report"]["photos"] == 8 and done["report"]["albums"][0]["title"] == "Holiday in Noosa"

    # Another person can't see it or add to it.
    from app.auth.models import User

    other = User(email=f"o{uuid.uuid4().hex[:6]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    assert (await client.get(f"/api/imports/{job['id']}", headers=_auth(other))).status_code == 404

    # Cancelling deletes the parts.
    assert (await client.delete(f"/api/imports/{job['id']}", headers=_auth(user))).status_code == 204
    assert not (root / ".imports" / job["id"]).exists()


@pytest.mark.asyncio
async def test_a_broken_part_is_said_plainly(client, db, user, tmp_path):
    job = (await client.post("/api/imports", json={"source": "takeout"}, headers=_auth(user))).json()
    bad = tmp_path / "takeout-001.zip"
    bad.write_bytes(b"PK\x03\x04" + b"\x00" * 50)  # a zip cut off mid-download
    await _upload_part(client, user, job["id"], bad)
    await client.post(f"/api/imports/{job['id']}/check", headers=_auth(user))
    got = (await client.get(f"/api/imports/{job['id']}", headers=_auth(user))).json()
    assert got["state"] == "failed" and "isn't a complete archive" in got["error"]


@pytest.mark.asyncio
async def test_a_part_finishing_after_its_import_was_cancelled_is_thrown_away(client, db, user, tmp_path, root):
    """An upload begun for an import that's since been cancelled (a resumed
    upload still tagged with it) used to land in the cancelled import —
    10 GB nobody could see, never deleted. Now it's refused and removed."""
    from app.files.tus_hooks import tus_dir
    from app.imports import jobs

    old = (await client.post("/api/imports", json={"source": "takeout"}, headers=_auth(user))).json()
    path = make_takeout(tmp_path)[0]
    meta = {"filename": path.name, "import_job": old["id"]}
    size = path.stat().st_size
    uid = (await client.post("/api/internal/tus-hook", json=_hook("pre-create", user, size=size, meta=meta))).json()["ChangeFileInfo"]["ID"]
    tus_dir().mkdir(parents=True, exist_ok=True)
    (tus_dir() / uid).write_bytes(path.read_bytes())

    assert (await client.delete(f"/api/imports/{old['id']}", headers=_auth(user))).status_code == 204
    r = (await client.post("/api/internal/tus-hook", json=_hook("pre-finish", user, size=size, meta=meta, upload_id=uid, offset=size))).json()
    assert r["HTTPResponse"]["StatusCode"] == 409 and "cancelled" in r["HTTPResponse"]["Body"]
    assert not (tus_dir() / uid).exists()
    got = (await client.get(f"/api/imports/{old['id']}", headers=_auth(user))).json()
    assert got["parts"] == [] and not (root / ".imports" / old["id"]).exists()

    # And the sweep clears anything a cancelled import was left with.
    stray = jobs.job_dir(old["id"])
    stray.mkdir(parents=True, exist_ok=True)
    (stray / "part-001.zip").write_bytes(b"x")
    await jobs.sweep()
    assert not stray.exists()
