"""PromptlySync pairing: a one-time QR code → an app password for the phone
(upload + read, never delete), and the phone's "already have these?"."""
from __future__ import annotations

import base64
import hashlib
import uuid

import httpx
import pytest

ORIGIN = "https://cloud.example.org"


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def _basic(username, password):
    return {"Authorization": "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()}


async def _start(client, user):
    r = await client.post("/api/devices/pair", headers=_auth(user), json={"origin": ORIGIN})
    assert r.status_code == 200, r.text
    return r.json()


async def test_pair_start_gives_a_link_and_qr(client, user):
    p = await _start(client, user)
    assert p["url"] == f"{ORIGIN}/sync?code={p['code']}"
    assert p["qr"].startswith("data:image/")
    assert p["apk_url"] == f"{ORIGIN}/downloads/PromptlySync.apk"
    r = await client.get(f"/api/devices/pair/{p['code']}", headers=_auth(user))
    assert r.json() == {"state": "waiting"}


async def test_pair_start_rejects_odd_origins(client, user):
    for bad in ("javascript:alert(1)", "https://x.org/evil/path", "ftp://x.org"):
        r = await client.post("/api/devices/pair", headers=_auth(user), json={"origin": bad})
        assert r.status_code in (400, 422), bad
    r = await client.post(
        "/api/devices/pair", headers={**_auth(user), "Origin": "https://other.org"}, json={"origin": ORIGIN}
    )
    assert r.status_code == 400


async def test_claim_makes_an_upload_password_once(client, db, user):
    from app.auth.app_passwords import AppPassword

    p = await _start(client, user)
    r = await client.post("/api/devices/pair/claim", json={"code": p["code"], "device_name": "  Pixel   9 "})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["username"] == user.username and got["device_name"] == "Pixel 9"
    row = await db.get(AppPassword, uuid.UUID(got["device_id"]))
    assert set(row.scopes) == {"upload", "dav:read"}
    assert "dav:delete" not in row.scopes

    # The page sees it paired; the code doesn't work twice.
    r = await client.get(f"/api/devices/pair/{p['code']}", headers=_auth(user))
    assert r.json() == {"state": "paired", "device": "Pixel 9"}
    r = await client.post("/api/devices/pair/claim", json={"code": p["code"], "device_name": "Other"})
    assert r.status_code == 404

    # And the new password signs the phone in.
    r = await client.post("/api/devices/have", headers=_basic(got["username"], got["password"]), json={"sha256": ["0" * 64]})
    assert r.status_code == 200 and r.json() == {"have": [], "skip": []}


async def test_status_is_private_to_the_owner(client, db, user):
    from app.auth.models import User

    p = await _start(client, user)
    other = User(username="someone_else", email="else@example.org", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    r = await client.get(f"/api/devices/pair/{p['code']}", headers=_auth(other))
    assert r.json() == {"state": "expired"}


async def test_unknown_code(client):
    r = await client.post("/api/devices/pair/claim", json={"code": "nope-nope-nope", "device_name": "Phone"})
    assert r.status_code == 404


async def test_have_finds_only_photos_files(client, db, user):
    from app.files.models import UserFile
    from app.files.system_folders import ensure_camera_uploads

    p = await _start(client, user)
    got = (await client.post("/api/devices/pair/claim", json={"code": p["code"], "device_name": "Phone"})).json()
    photos = await ensure_camera_uploads(db, user)
    in_photos = hashlib.sha256(b"in photos").hexdigest()
    elsewhere = hashlib.sha256(b"elsewhere").hexdigest()
    for sha, folder in ((in_photos, photos.id), (elsewhere, None)):
        db.add(UserFile(
            user_id=user.id, folder_id=folder, filename=f"{sha[:6]}.jpg", original_filename=f"{sha[:6]}.jpg",
            mime_type="image/jpeg", size_bytes=1, storage_path=f"x/{sha}", content_sha256=sha,
        ))
    await db.commit()
    r = await client.post(
        "/api/devices/have", headers=_basic(got["username"], got["password"]),
        json={"sha256": [in_photos.upper(), elsewhere, "short"]},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"have": [in_photos], "skip": []}


async def test_have_needs_an_app_password(client, user):
    r = await client.post("/api/devices/have", json={"sha256": ["0" * 64]})
    assert r.status_code == 401


async def test_a_photo_you_deleted_is_never_sent_back(client, db, user):
    """In the trash, or deleted for good: the phone is told to skip it — even
    a phone re-linked from scratch. Only what's really in Photos is "have"
    (the proof the phone may free up space)."""
    import hashlib

    from sqlalchemy import text

    from app.files.models import UserFile
    from app.files.purge import purge_file_rows
    from tests.test_photo_library_wp91 import _photo, _utc

    p = await _start(client, user)
    got = (await client.post("/api/devices/pair/claim", json={"code": p["code"], "device_name": "Phone"})).json()
    auth = _basic(got["username"], got["password"])
    kept, binned, purged = (hashlib.sha256(n.encode()).hexdigest() for n in ("kept", "binned", "purged"))
    ids = {}
    for name, sha in (("kept", kept), ("binned", binned), ("purged", purged)):
        fid = await _photo(db, user, f"{name}.jpg", _utc(2026, 5, 1))
        await db.execute(text("UPDATE files SET content_sha256 = :h WHERE id = :f"), {"h": sha, "f": fid})
        ids[name] = fid
    await db.execute(text("UPDATE files SET trashed_at = now() WHERE id = ANY(:f)"), {"f": [ids["binned"], ids["purged"]]})
    await db.commit()

    r = await client.post("/api/devices/have", headers=auth, json={"sha256": [kept, binned, purged]})
    assert r.json() == {"have": [kept], "skip": sorted([binned, purged])}

    # Empty the trash: the purged one is remembered.
    await purge_file_rows(db, [await db.get(UserFile, ids["purged"])])
    await db.commit()
    assert await db.get(UserFile, ids["purged"]) is None
    r = await client.post("/api/devices/have", headers=auth, json={"sha256": [kept, binned, purged]})
    assert r.json() == {"have": [kept], "skip": sorted([binned, purged])}

    # Restored from the trash: it's a backup again.
    await db.execute(text("UPDATE files SET trashed_at = NULL WHERE id = :f"), {"f": ids["binned"]})
    await db.commit()
    r = await client.post("/api/devices/have", headers=auth, json={"sha256": [binned]})
    assert r.json() == {"have": [binned], "skip": []}
