"""Resumable uploads (WP-8.2, Part C §5.6): tusd asks the backend before a
byte is accepted (pre-create) and hands the finished file over to the one
upload path (pre-finish). These drive the hook endpoint the way tusd does."""
from __future__ import annotations

import json
import os
import time
import uuid

import httpx
import pytest


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    from app.tasks import queue

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(queue, "enqueue_media", nothing)
    monkeypatch.setattr(queue, "enqueue_office_text", nothing)


@pytest.fixture
async def client(db, root, monkeypatch):
    from app import rate_limit
    from app.config import get_settings
    from app.main import app

    monkeypatch.setattr(get_settings(), "TUS_ENABLED", True)
    monkeypatch.setattr(get_settings(), "TUS_HOOK_SECRET", None)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _token(user) -> str:
    from app.auth.utils import create_access_token

    return create_access_token(user.id, token_version=user.token_version)


def _auth(user):
    return {"Authorization": f"Bearer {_token(user)}"}


def _event(user, *, size, meta, upload_id="", offset=0, method="POST"):
    return {
        "Upload": {
            "ID": upload_id, "Size": size, "SizeIsDeferred": False, "Offset": offset, "MetaData": meta,
            "IsPartial": False, "IsFinal": False, "PartialUploads": None, "Storage": None,
        },
        "HTTPRequest": {
            "Method": method, "URI": "/api/files/tus/", "RemoteAddr": "172.18.0.9:5000",
            "Header": {"Authorization": [f"Bearer {_token(user)}"] if user else [], "X-Real-Ip": ["203.0.113.7"]},
        },
    }


async def _hook(client, hook, event, key=None):
    url = "/api/internal/tus-hook" + (f"?key={key}" if key else "")
    r = await client.post(url, json={"Type": hook, "Event": event})
    assert r.status_code == 200, r.text  # tusd turns anything else into a 500
    return r.json()


def _rejected(reply) -> tuple[int, dict]:
    resp = reply["HTTPResponse"]
    return resp["StatusCode"], json.loads(resp["Body"])


async def _create(client, user, name, data, **meta_extra):
    meta = {"filename": name, "filetype": "text/plain", "scope": "mine", **meta_extra}
    reply = await _hook(client, "pre-create", _event(user, size=len(data), meta=meta))
    assert "RejectUpload" not in reply, reply
    upload_id = reply["ChangeFileInfo"]["ID"]
    return upload_id, reply["ChangeFileInfo"]["MetaData"]


async def _finish(client, user, root, upload_id, meta, data):
    from app.files.tus_hooks import TUS_DIR

    d = root / TUS_DIR
    d.mkdir(exist_ok=True)
    (d / upload_id).write_bytes(data)
    (d / f"{upload_id}.info").write_text("{}")
    return await _hook(
        client, "pre-finish", _event(user, size=len(data), meta=meta, upload_id=upload_id, offset=len(data), method="PATCH")
    )


@pytest.mark.asyncio
async def test_a_big_upload_is_cleared_first_and_filed_like_any_upload(client, db, user, root):
    from app.files.models import UserFile
    from app.files.tus_hooks import _reserved_for

    data = b"field notes\n" * 1000
    upload_id, meta = await _create(client, user, "notes.txt", data)
    assert len(upload_id) == 32 and meta["filename"] == "notes.txt"
    assert await _reserved_for(user.id) == len(data)  # counted while it's under way

    reply = await _finish(client, user, root, upload_id, meta, data)
    fid = reply["HTTPResponse"]["Header"]["Upload-File-Id"]
    row = await db.get(UserFile, uuid.UUID(fid), populate_existing=True)
    assert row.user_id == user.id and row.size_bytes == len(data) and row.content_sha256
    assert (root / row.storage_path).read_bytes() == data
    assert not (root / ".tus" / upload_id).exists()  # moved, not copied
    assert await _reserved_for(user.id) == 0

    # tusd's bookkeeping goes after.
    await _hook(client, "post-finish", _event(user, size=len(data), meta=meta, upload_id=upload_id))
    assert not (root / ".tus" / f"{upload_id}.info").exists()


@pytest.mark.asyncio
async def test_refusals_come_before_any_bytes(client, db, user, root, monkeypatch):
    from app.auth.models import User
    from app.files import tus_hooks

    # Not allowed here.
    reply = await _hook(client, "pre-create", _event(user, size=10, meta={"filename": "tool.exe", "scope": "mine"}))
    assert reply["RejectUpload"] is True and _rejected(reply)[0] == 400
    # Not signed in.
    reply = await _hook(client, "pre-create", _event(None, size=10, meta={"filename": "a.txt", "scope": "mine"}))
    assert _rejected(reply)[0] == 401
    # Over the admin's cap for one upload.
    async def tiny(_db):
        return 100

    monkeypatch.setattr(tus_hooks, "large_max_bytes", tiny)
    reply = await _hook(client, "pre-create", _event(user, size=101, meta={"filename": "big.txt", "scope": "mine"}))
    assert _rejected(reply)[0] == 413
    monkeypatch.undo()
    # A name to ask about — the client asks before sending 4 GB.
    await client.post("/api/files/", files={"file": ("plan.txt", b"x", "text/plain")}, data={"scope": "mine"}, headers=_auth(user))
    reply = await _hook(client, "pre-create", _event(user, size=5, meta={"filename": "plan.txt", "scope": "mine", "on_conflict": "ask"}))
    status_code, body = _rejected(reply)
    assert status_code == 409 and body["detail"]["code"] == "name_exists"
    # Storage, counting the other big uploads still under way.
    me = await db.get(User, user.id)
    me.storage_cap_bytes = 1000
    await db.commit()
    await _create(client, user, "first.txt", b"a" * 600)
    reply = await _hook(client, "pre-create", _event(user, size=600, meta={"filename": "second.txt", "scope": "mine"}))
    assert _rejected(reply)[0] == 413


@pytest.mark.asyncio
async def test_a_finished_upload_can_replace_a_file_keeping_a_version(client, db, user, root):
    first = await client.post("/api/files/", files={"file": ("cut.txt", b"take one", "text/plain")},
                              data={"scope": "mine"}, headers=_auth(user))
    upload_id, meta = await _create(client, user, "cut.txt", b"take two", on_conflict="replace")
    reply = await _finish(client, user, root, upload_id, meta, b"take two")
    assert reply["HTTPResponse"]["Header"]["Upload-File-Id"] == first.json()["id"]
    hist = (await client.get(f"/api/files/{first.json()['id']}/versions", headers=_auth(user))).json()
    assert [v["source"] for v in hist["versions"]] == ["upload"]


@pytest.mark.asyncio
async def test_what_isnt_what_it_says_is_refused_at_the_end(client, db, user, root):
    data = b"this is not a png"
    upload_id, meta = await _create(client, user, "photo.png", data)
    meta["filetype"] = "image/png"
    reply = await _finish(client, user, root, upload_id, meta, data)
    assert "RejectUpload" not in reply and _rejected(reply)[0] == 400
    assert not any((root / ".staging").glob("*")) if (root / ".staging").exists() else True
    assert not (root / ".tus" / upload_id).exists()


@pytest.mark.asyncio
async def test_a_cancelled_upload_gives_its_room_back(client, user, root):
    from app.files.tus_hooks import _reserved_for

    upload_id, meta = await _create(client, user, "big.txt", b"z" * 500)
    assert await _reserved_for(user.id) == 500
    await _hook(client, "post-terminate", _event(user, size=500, meta=meta, upload_id=upload_id))
    assert await _reserved_for(user.id) == 0


@pytest.mark.asyncio
async def test_only_tusd_can_call_the_hooks(client, user, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "TUS_HOOK_SECRET", "s3cret")
    r = await client.post("/api/internal/tus-hook", json={"Type": "pre-create", "Event": _event(user, size=1, meta={})})
    assert r.status_code == 404
    reply = await _hook(client, "pre-create", _event(user, size=3, meta={"filename": "ok.txt", "scope": "mine"}), key="s3cret")
    assert "ChangeFileInfo" in reply


@pytest.mark.asyncio
async def test_the_policy_and_the_already_there_check(client, db, user):
    pol = (await client.get("/api/files/upload-policy", headers=_auth(user))).json()
    assert pol["tus_endpoint"] == "/api/files/tus/" and pol["large_max_bytes"] == 10 * 1024 ** 3
    assert pol["tus_threshold"] < pol["max_bytes"]

    up = await client.post("/api/files/", files={"file": ("IMG_1.txt", b"photo bytes", "text/plain")},
                           data={"scope": "mine"}, headers=_auth(user))
    sha = (await client.get(f"/api/files/{up.json()['id']}", headers=_auth(user))).json()
    r = await client.post("/api/files/precheck", headers=_auth(user), json={
        "scope": "mine", "folder_id": None,
        "files": [{"name": "img_1.txt", "size": 11}, {"name": "IMG_1.txt", "size": 12}, {"name": "IMG_2.txt", "size": 11}],
    })
    matches = r.json()["matches"]
    assert list(matches) == ["0"] and len(matches["0"]) == 64
    del sha


def test_abandoned_uploads_are_swept_after_a_week(root):
    from app.files.tus_hooks import TUS_DIR, sweep

    d = root / TUS_DIR
    d.mkdir()
    old = time.time() - 8 * 86400
    for name in ("abc", "abc.info", "abc.lock"):
        (d / name).write_bytes(b"x")
        os.utime(d / name, (old, old))
    (d / "fresh").write_bytes(b"y")
    assert sweep() == 1
    assert [p.name for p in d.iterdir()] == ["fresh"]
