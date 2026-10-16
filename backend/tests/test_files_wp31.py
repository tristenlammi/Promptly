"""Files hardening (WP-3.1): big images, orphan blobs, thumbnails, trash,
search, workspace folders, the share picker, upload conflicts and public
links (R-205…R-217)."""
from __future__ import annotations

import io
import os
import time
import uuid
from datetime import datetime, timezone

import httpx
import pytest
from PIL import Image

from app.files import storage


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path.resolve()


@pytest.fixture
async def client(db, root):
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


async def _user(db, name):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def _png(w=40, h=30) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 80, 40)).save(buf, format="PNG")
    return buf.getvalue()


async def _upload(client, user, name, data=b"hello there", mime="text/plain", **form):
    r = await client.post(
        "/api/files/",
        files={"file": (name, data, mime)},
        data={"scope": "mine", **{k: v for k, v in form.items() if v is not None}},
        headers=_auth(user),
    )
    return r


async def _folder(client, user, name, parent=None):
    r = await client.post("/api/files/folders", json={"name": name, "parent_id": parent, "scope": "mine"},
                          headers=_auth(user))
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------- R-206


def test_an_image_too_big_to_decode_is_a_clear_refusal(tmp_path, monkeypatch):
    from app.files import safety

    p = tmp_path / "huge.png"
    p.write_bytes(_png(100, 100))
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1000)  # 100x100 > 2x → bomb
    with pytest.raises(safety.UnsafeUploadError) as e:
        safety.strip_image_metadata_in_place(p, "image/png")
    assert e.value.code == "image_too_large"


@pytest.mark.asyncio
async def test_unreferenced_blobs_are_quarantined_but_live_ones_kept(db, user, root, client):
    # R-206, revised by WP-7.2: unreferenced blobs are set aside in
    # .quarantine/ by the scrubber's weekly walk — never deleted on their own.
    from app.files.models import StorageCheck
    from app.files.scrubber import orphan_walk

    r = await _upload(client, user, "keep.txt")
    assert r.status_code == 201, r.text
    bucket = root / f"u_{user.id}"
    orphan = bucket / f"{uuid.uuid4()}.txt"
    orphan.write_text("left behind by a failed upload")
    old = time.time() - 7200
    for p in bucket.iterdir():
        os.utime(p, (old, old))
    fresh = bucket / f"{uuid.uuid4()}.txt"
    fresh.write_text("an upload still writing its row")

    check = StorageCheck(checked=0, verified=0, bytes_verified=0, missing=0, damaged=0, recovered=0, quarantined=0)
    assert await orphan_walk(db, check) == 1
    assert not orphan.exists() and fresh.exists()
    assert (root / ".quarantine" / f"u_{user.id}" / orphan.name).read_text() == "left behind by a failed upload"


# ---------------------------------------------------------------- R-207


@pytest.mark.asyncio
async def test_thumbnails_are_cached_and_revalidate_with_304(db, user, root, client):
    r = await _upload(client, user, "pic.png", _png(), "image/png")
    fid = r.json()["id"]
    t = await client.get(f"/api/files/{fid}/thumbnail", headers=_auth(user))
    assert t.status_code == 200 and t.headers["content-type"] == "image/jpeg"
    etag = t.headers["etag"]
    assert list((root / "derived" / "thumbs").iterdir())
    again = await client.get(f"/api/files/{fid}/thumbnail", headers={**_auth(user), "If-None-Match": etag})
    assert again.status_code == 304
    big = await client.get(f"/api/files/{fid}/thumbnail?size=1024", headers=_auth(user))
    assert big.status_code == 200 and big.headers["etag"] != etag


# ---------------------------------------------------------------- R-209


@pytest.mark.asyncio
async def test_trash_lists_roots_and_restore_finds_a_live_home(db, user, root, client):
    folder = await _folder(client, user, "Trip")
    f = (await _upload(client, user, "plan.txt", folder_id=folder["id"])).json()
    r = await client.post(f"/api/files/folders/{folder['id']}/trash", headers=_auth(user))
    assert r.status_code == 200

    trash = (await client.get("/api/files/trash", headers=_auth(user))).json()
    assert [x["id"] for x in trash["folders"]] == [folder["id"]]
    assert trash["files"] == []  # inside the trashed folder: not listed separately
    assert trash["folders"][0]["location"] == "My files"

    # The name of a trashed folder no longer blocks a new one.
    again = await _folder(client, user, "Trip")

    # Restoring the file alone: its folder is still trashed → the root.
    r = await client.post(f"/api/files/{f['id']}/restore", headers=_auth(user))
    assert r.status_code == 200 and r.json()["folder_id"] is None
    assert r.json()["location"] == "My files"

    # Restoring the folder next to its namesake renames it.
    r = await client.post(f"/api/files/folders/{folder['id']}/restore", headers=_auth(user))
    assert r.json()["name"] == "Trip (1)"
    assert again["name"] == "Trip"


@pytest.mark.asyncio
async def test_starring_doesnt_change_modified(db, user, root, client):
    f = (await _upload(client, user, "notes.txt")).json()
    before = f["modified_at"]
    time.sleep(0.01)
    s = await client.post(f"/api/files/{f['id']}/star", headers=_auth(user))
    assert s.json()["modified_at"] == before
    assert s.json()["updated_at"] == before


# ---------------------------------------------------------------- R-213


@pytest.mark.asyncio
async def test_search_matches_names_folders_and_shared_files(db, user, root, client):
    from app.files.models import ResourceGrant

    await _upload(client, user, "Q3_report-final.txt", b"numbers")
    await _folder(client, user, "Reports archive")
    other = await _user(db, "bob")
    shared = (await _upload(client, other, "team report.txt", b"x")).json()
    db.add(ResourceGrant(resource_type="file", resource_id=uuid.UUID(shared["id"]),
                         grantee_user_id=user.id, granted_by_user_id=other.id))
    await db.commit()

    r = (await client.get("/api/files/search?q=report", headers=_auth(user))).json()
    names = {h["file"]["filename"] for h in r["hits"]}
    assert {"Q3_report-final.txt", "team report.txt"} <= names
    assert [f["name"] for f in r["folders"]] == ["Reports archive"]

    mine = (await client.get("/api/files/search?q=report&owner=me", headers=_auth(user))).json()
    assert {h["file"]["filename"] for h in mine["hits"]} == {"Q3_report-final.txt"}

    page = (await client.get("/api/files/search?q=report&limit=1", headers=_auth(user))).json()
    assert len(page["hits"]) == 1 and page["has_more"] is True


# ---------------------------------------------------------------- R-215


@pytest.mark.asyncio
async def test_drive_leaves_a_workspaces_folders_alone(db, user, root, client):
    from sqlalchemy import select

    from app.chat.models import Workspace
    from app.files.models import FileFolder

    r = await client.post("/api/workspaces", json={"title": "Family"}, headers=_auth(user))
    ws = await db.get(Workspace, uuid.UUID(r.json()["id"]))
    notes = (
        await db.execute(select(FileFolder).where(FileFolder.parent_id == ws.root_folder_id, FileFolder.name == "Notes"))
    ).scalar_one()

    r = await client.post(f"/api/files/folders/{notes.id}/trash", headers=_auth(user))
    assert r.status_code == 409 and "Family" in r.json()["detail"]
    r = await client.post("/api/files/bulk/trash", json={"folder_ids": [str(ws.root_folder_id)]}, headers=_auth(user))
    assert r.json()["folders"] == 0 and r.json()["skipped"] == 1
    b = (await client.get(f"/api/files/browse?folder_id={notes.id}", headers=_auth(user))).json()
    assert b["workspace_title"] == "Family"


# ---------------------------------------------------------------- R-217


@pytest.mark.asyncio
async def test_the_share_picker_doesnt_hand_out_the_directory(db, user, root, client):
    stranger = await _user(db, "stranger")
    blank = (await client.get("/api/files/users/search?q=", headers=_auth(user))).json()["results"]
    assert stranger.id not in {uuid.UUID(u["id"]) for u in blank}  # not someone I work with
    wild = (await client.get("/api/files/users/search?q=%25%25", headers=_auth(user))).json()["results"]
    assert wild == []
    found = (await client.get(f"/api/files/users/search?q={stranger.username[:5]}", headers=_auth(user))).json()["results"]
    assert found and found[0]["email"] is None
    exact = (await client.get(f"/api/files/users/search?q={stranger.email}", headers=_auth(user))).json()["results"]
    assert exact[0]["email"] == stranger.email


# ---------------------------------------------------------------- R-212


@pytest.mark.asyncio
async def test_upload_policy_and_name_conflicts(db, user, root, client):
    pol = (await client.get("/api/files/upload-policy", headers=_auth(user))).json()
    assert ".pdf" in pol["allowed_extensions"] and pol["max_bytes"] > 0

    first = (await _upload(client, user, "cv.txt", b"one")).json()
    ask = await _upload(client, user, "cv.txt", b"two", on_conflict="ask")
    assert ask.status_code == 409 and ask.json()["detail"]["code"] == "name_exists"
    both = await _upload(client, user, "cv.txt", b"two", on_conflict="keep_both")
    assert both.json()["filename"] == "cv (1).txt"
    rep = await _upload(client, user, "cv.txt", b"three", on_conflict="replace")
    assert rep.status_code == 201
    # Replace keeps the same file, its old bytes as a version (WP-8.1) —
    # it used to send the old one to the trash.
    assert rep.json()["id"] == first["id"]
    hist = (await client.get(f"/api/files/{first['id']}/versions", headers=_auth(user))).json()
    assert [v["source"] for v in hist["versions"]] == ["upload"]


# ---------------------------------------------------------------- R-208


@pytest.mark.asyncio
async def test_public_links_show_in_drive_and_can_be_listed(db, user, root, client):
    f = (await _upload(client, user, "menu.txt")).json()
    r = await client.post(f"/api/files/{f['id']}/share-links", json={"access_mode": "public"}, headers=_auth(user))
    assert r.status_code == 201, r.text
    b = (await client.get("/api/files/browse", headers=_auth(user))).json()
    row = next(x for x in b["files"] if x["id"] == f["id"])
    assert row["sharing"]["public_links"] == 1
    links = (await client.get("/api/files/share-links", headers=_auth(user))).json()["links"]
    assert links[0]["resource_name"] == "menu.txt"
