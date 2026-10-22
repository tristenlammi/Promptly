"""WebDAV at /dav/ (WP-8.4, Part C §5.7): a sync client's view of My files,
over the web app's own rules. These talk to it the way Finder and rclone do."""
from __future__ import annotations

import base64
import hashlib
import unicodedata
import uuid
import xml.etree.ElementTree as ET

import httpx
import pytest
from sqlalchemy import select

D = "{DAV:}"
OC = "{http://owncloud.org/ns}"


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    from app.files import dav
    from app.tasks import queue

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(queue, "enqueue_media", nothing)
    monkeypatch.setattr(queue, "enqueue_office_text", nothing)
    dav.locks.clear()


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


async def _device(db, user, scopes=("dav:read", "dav:write", "dav:delete")):
    from app.auth.app_passwords import AppPassword, hint, new_token, token_hash

    token = new_token()
    row = AppPassword(user_id=user.id, name="Laptop", token_hash=token_hash(token), hint=hint(token), scopes=list(scopes))
    db.add(row)
    await db.commit()
    return row, {"Authorization": "Basic " + base64.b64encode(f"{user.username}:{token}".encode()).decode()}


@pytest.fixture
async def dav(client, db, user):
    _row, auth = await _device(db, user)

    async def call(method, path, *, headers=None, **kw):
        return await client.request(method, "/dav" + path, headers={**auth, **(headers or {})}, **kw)

    call.auth = auth
    return call


def _listing(r: httpx.Response) -> dict[str, dict[str, str | None]]:
    """href → {prop name: text} from a 207."""
    assert r.status_code == 207, r.text
    out = {}
    for resp in ET.fromstring(r.content).findall(f"{D}response"):
        href = resp.findtext(f"{D}href")
        props: dict[str, str | None] = {}
        for stat in resp.findall(f"{D}propstat"):
            if "200" not in (stat.findtext(f"{D}status") or ""):
                continue
            for p in stat.find(f"{D}prop"):
                props[p.tag] = "".join(p.itertext()) or ("collection" if p.find(f"{D}collection") is not None else None)
        out[href] = props
    return out


async def _file(db, user, name):
    from app.files.models import UserFile

    return (
        await db.execute(select(UserFile).where(UserFile.user_id == user.id, UserFile.filename == name, UserFile.trashed_at.is_(None)))
    ).scalars().one()


@pytest.mark.asyncio
async def test_only_a_device_password_gets_in_and_read_only_ones_can_t_write(client, db, user):
    r = await client.request("OPTIONS", "/dav/")
    assert r.status_code == 200 and "2" in r.headers["DAV"] and "PROPFIND" in r.headers["Allow"]

    r = await client.request("PROPFIND", "/dav/", headers={"Depth": "0"})
    assert r.status_code == 401 and r.headers["WWW-Authenticate"].startswith("Basic")
    bad = "Basic " + base64.b64encode(f"{user.username}:the-account-password".encode()).decode()
    assert (await client.request("PROPFIND", "/dav/", headers={"Authorization": bad})).status_code == 401

    _row, reader = await _device(db, user, scopes=("dav:read",))
    assert (await client.request("PROPFIND", "/dav/", headers={**reader, "Depth": "0"})).status_code == 207
    assert (await client.request("PUT", "/dav/a.txt", headers=reader, content=b"x")).status_code == 403
    assert (await client.request("MKCOL", "/dav/Docs", headers=reader)).status_code == 403


@pytest.mark.asyncio
async def test_folders_files_and_a_listing_with_hashes(dav, db, user):
    assert (await dav("MKCOL", "/Notes")).status_code == 201
    assert (await dav("MKCOL", "/Notes")).status_code == 405
    assert (await dav("MKCOL", "/Missing/Inner")).status_code == 409
    body = b"Meeting notes\n"
    r = await dav("PUT", "/Notes/monday.txt", content=body, headers={"Content-Type": "text/plain"})
    assert r.status_code == 201, r.text
    sha256, sha1 = hashlib.sha256(body).hexdigest(), hashlib.sha1(body).hexdigest()  # noqa: S324
    assert r.headers["ETag"] == f'"{sha256}"'

    listing = _listing(await dav("PROPFIND", "/Notes/", headers={"Depth": "1"}))
    assert set(listing) == {"/dav/Notes/", "/dav/Notes/monday.txt"}
    f = listing["/dav/Notes/monday.txt"]
    assert f[f"{D}getcontentlength"] == str(len(body)) and f[f"{D}getetag"] == f'"{sha256}"'
    md5 = hashlib.md5(body).hexdigest()  # noqa: S324
    assert f[f"{OC}checksums"] == f"SHA1:{sha1} MD5:{md5}" and f[f"{D}resourcetype"] is None
    assert listing["/dav/Notes/"][f"{D}resourcetype"] == "collection"

    # Only the properties asked for — and the quota.
    ask = b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:quota-used-bytes/><d:nope/></d:prop></d:propfind>'
    r = await dav("PROPFIND", "/", headers={"Depth": "0"}, content=ask)
    assert "quota-used-bytes" in r.text and "404 Not Found" in r.text
    # The whole tree in one go: no.
    assert (await dav("PROPFIND", "/", headers={"Depth": "infinity"})).status_code == 403

    r = await dav("GET", "/Notes/monday.txt")
    assert r.status_code == 200 and r.content == body
    r = await dav("HEAD", "/Notes/monday.txt")
    assert r.status_code == 200 and r.headers["Content-Length"] == str(len(body))
    # Behind nginx the bytes come from nginx.
    r = await dav("GET", "/Notes/monday.txt", headers={"X-Promptly-Accel": "1"})
    assert r.headers["X-Accel-Redirect"].startswith("/_blobs/") and r.content == b""
    assert (await dav("GET", "/Notes/nothing.txt")).status_code == 404


@pytest.mark.asyncio
async def test_writing_over_a_file_keeps_a_version_and_refuses_a_stale_write(dav, db, user):
    from app.files.models import FileVersion

    await dav("PUT", "/plan.txt", content=b"first")
    row = await _file(db, user, "plan.txt")
    first_tag = f'"{row.content_sha256}"'
    r = await dav("PUT", "/plan.txt", content=b"second", headers={"If-Match": first_tag, "X-OC-Mtime": "1700000000"})
    assert r.status_code == 204 and r.headers["X-OC-MTime"] == "accepted"
    again = await _file(db, user, "plan.txt")
    await db.refresh(again)
    assert again.id == row.id and again.size_bytes == 6
    assert again.client_mtime.timestamp() == 1700000000
    versions = (await db.execute(select(FileVersion).where(FileVersion.file_id == row.id))).scalars().all()
    assert [(v.source, v.size_bytes) for v in versions] == [("dav", 5)]
    # Someone else's write got there first.
    assert (await dav("PUT", "/plan.txt", content=b"third", headers={"If-Match": first_tag})).status_code == 412
    listing = _listing(await dav("PROPFIND", "/plan.txt", headers={"Depth": "0"}))
    assert listing["/dav/plan.txt"][f"{D}getlastmodified"].endswith("2023 22:13:20 GMT")


@pytest.mark.asyncio
async def test_a_checksum_that_doesn_t_match_stores_nothing(dav, db, user):
    r = await dav("PUT", "/x.txt", content=b"hello", headers={"OC-Checksum": "SHA1:" + "0" * 40})
    assert r.status_code == 400
    assert (await dav("GET", "/x.txt")).status_code == 404
    good = hashlib.sha1(b"hello").hexdigest()  # noqa: S324
    assert (await dav("PUT", "/x.txt", content=b"hello", headers={"OC-Checksum": f"SHA1:{good}"})).status_code == 201


@pytest.mark.asyncio
async def test_finder_s_empty_file_then_content_and_its_clutter(dav, db, user):
    from app.files.models import FileVersion

    assert (await dav("PUT", "/photo.jpg", content=b"")).status_code == 201
    jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 64 + b"\xff\xd9"
    assert (await dav("PUT", "/photo.jpg", content=jpeg)).status_code == 204
    row = await _file(db, user, "photo.jpg")
    assert row.size_bytes == len(jpeg)
    # The empty placeholder isn't kept as a version.
    assert (await db.execute(select(FileVersion).where(FileVersion.file_id == row.id))).scalars().all() == []

    assert (await dav("PUT", "/._photo.jpg", content=b"resource fork")).status_code == 201
    assert (await dav("PUT", "/.DS_Store", content=b"settings")).status_code == 201
    names = set(_listing(await dav("PROPFIND", "/", headers={"Depth": "1"})))
    # (The Photos folder is always there — it was Camera Uploads, WP-8.5.)
    assert names == {"/dav/", "/dav/photo.jpg", "/dav/Photos/"}
    assert (await dav("DELETE", "/._photo.jpg")).status_code == 204


@pytest.mark.asyncio
async def test_names_from_a_mac_and_two_files_with_one_name(dav, db, user):
    from app.files import blobstore
    from app.files.models import UserFile
    from app.files.storage import storage_path_for

    nfd = unicodedata.normalize("NFD", "Café.txt")
    assert (await dav("PUT", "/" + nfd, content=b"latte")).status_code == 201
    assert (await _file(db, user, "Café.txt")) is not None
    assert (await dav("GET", "/" + unicodedata.normalize("NFC", "Café.txt"))).content == b"latte"

    # Drive allows two files with one name; WebDAV shows the second as "(2)".
    for text in (b"one", b"two"):
        fid = uuid.uuid4()
        rel = storage_path_for(user.id, fid, ".txt")
        await blobstore.put_bytes(rel, text)
        db.add(UserFile(id=fid, user_id=user.id, filename="dup.txt", original_filename="dup.txt",
                        mime_type="text/plain", size_bytes=3, storage_path=rel))
        await db.commit()
    names = set(_listing(await dav("PROPFIND", "/", headers={"Depth": "1"})))
    assert {"/dav/dup.txt", "/dav/dup%20%282%29.txt"} <= names
    assert (await dav("GET", "/dup.txt")).content == b"one"
    assert (await dav("GET", "/dup (2).txt")).content == b"two"
    # Names that wouldn't be stored as given are refused, not changed.
    assert (await dav("PUT", "/.env", content=b"x")).status_code == 400


@pytest.mark.asyncio
async def test_documents_are_read_only_exports_and_mirrors_never_show(dav, db, user):
    from app.files import blobstore
    from app.files.models import UserFile
    from app.files.storage import storage_path_for

    for name, kind, data in (("Letter.html", "document", b"<p>Dear Sam</p>"), ("Board.md", "board_text", b"- a task")):
        fid = uuid.uuid4()
        rel = storage_path_for(user.id, fid, "." + name.rsplit(".", 1)[1])
        await blobstore.put_bytes(rel, data)
        db.add(UserFile(id=fid, user_id=user.id, filename=name, original_filename=name, mime_type="text/html",
                        size_bytes=len(data), storage_path=rel, source_kind=kind))
    await db.commit()
    names = set(_listing(await dav("PROPFIND", "/", headers={"Depth": "1"})))
    assert "/dav/Letter.html" in names and "/dav/Board.md" not in names
    assert (await dav("GET", "/Letter.html")).content == b"<p>Dear Sam</p>"
    assert (await dav("PUT", "/Letter.html", content=b"<p>hacked</p>")).status_code == 403
    assert (await dav("DELETE", "/Letter.html")).status_code == 403
    assert (await dav("MOVE", "/Letter.html", headers={"Destination": "http://test/dav/L2.html"})).status_code == 403
    assert (await dav("GET", "/Board.md")).status_code == 404


@pytest.mark.asyncio
async def test_delete_goes_to_the_trash_as_this_device(dav, db, user):
    from app.files.models import FileFolder

    await dav("MKCOL", "/Old")
    await dav("PUT", "/Old/a.txt", content=b"a")
    await dav("PUT", "/b.txt", content=b"b")
    row = await _file(db, user, "b.txt")
    assert (await dav("DELETE", "/b.txt")).status_code == 204
    assert (await dav("DELETE", "/Old/")).status_code == 204
    await db.refresh(row)
    assert row.trashed_at is not None and row.trashed_credential.startswith("app_password:")
    folder = (await db.execute(select(FileFolder).where(FileFolder.user_id == user.id, FileFolder.name == "Old"))).scalars().one()
    assert folder.trashed_at is not None
    assert (await dav("GET", "/b.txt")).status_code == 404
    assert (await dav("DELETE", "/")).status_code == 403


@pytest.mark.asyncio
async def test_move_and_copy(dav, db, user):
    from app.files.models import FileVersion

    await dav("MKCOL", "/A")
    await dav("MKCOL", "/B")
    await dav("PUT", "/A/one.txt", content=b"1")
    row = await _file(db, user, "one.txt")
    r = await dav("MOVE", "/A/one.txt", headers={"Destination": "http://test/dav/B/uno.txt"})
    assert r.status_code == 201
    await db.refresh(row)
    assert row.filename == "uno.txt"
    assert (await dav("GET", "/B/uno.txt")).content == b"1"
    # Overwrite: F refuses a taken name.
    await dav("PUT", "/B/dos.txt", content=b"2")
    r = await dav("MOVE", "/B/uno.txt", headers={"Destination": "http://test/dav/B/dos.txt", "Overwrite": "F"})
    assert r.status_code == 412

    # A safe save: write a temp file, move it over the real one — the real
    # one keeps its id and its old bytes as a version; the temp is gone.
    target = await _file(db, user, "dos.txt")
    await dav("PUT", "/B/dos (saving).txt", content=b"2, edited")
    r = await dav("MOVE", "/B/dos%20(saving).txt", headers={"Destination": "http://test/dav/B/dos.txt"})
    assert r.status_code == 204
    await db.refresh(target)
    assert (await dav("GET", "/B/dos.txt")).content == b"2, edited"
    assert (await dav("GET", "/B/dos (saving).txt")).status_code == 404
    versions = (await db.execute(select(FileVersion).where(FileVersion.file_id == target.id))).scalars().all()
    assert [v.size_bytes for v in versions] == [1]

    # A folder moves with everything in it; it can't go inside itself.
    assert (await dav("MOVE", "/A/", headers={"Destination": "http://test/dav/B/A/"})).status_code == 201
    assert (await dav("MOVE", "/B/", headers={"Destination": "http://test/dav/B/A/B/"})).status_code == 403

    assert (await dav("COPY", "/B/dos.txt", headers={"Destination": "http://test/dav/copy.txt"})).status_code == 201
    assert (await dav("GET", "/copy.txt")).content == b"2, edited"
    assert (await dav("COPY", "/B/", headers={"Destination": "http://test/dav/B2/"})).status_code == 201
    names = set(_listing(await dav("PROPFIND", "/B2/", headers={"Depth": "1"})))
    assert {"/dav/B2/dos.txt", "/dav/B2/uno.txt", "/dav/B2/A/"} <= names


@pytest.mark.asyncio
async def test_locks_keep_other_writers_out_until_unlocked(dav, db, user):
    await dav("PUT", "/report.txt", content=b"v1")
    body = (b'<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope>'
            b"<d:locktype><d:write/></d:locktype><d:owner>Finder</d:owner></d:lockinfo>")
    r = await dav("LOCK", "/report.txt", content=body, headers={"Timeout": "Second-600"})
    assert r.status_code == 200
    token = r.headers["Lock-Token"].strip("<>")
    assert token in r.text
    assert (await dav("LOCK", "/report.txt", content=body)).status_code == 423
    assert (await dav("PUT", "/report.txt", content=b"v2")).status_code == 423
    assert (await dav("DELETE", "/report.txt")).status_code == 423
    assert (await dav("PUT", "/report.txt", content=b"v2", headers={"If": f"(<{token}>)"})).status_code == 204
    # A refresh, then an If that doesn't hold.
    assert (await dav("LOCK", "/report.txt", headers={"If": f"(<{token}>)", "Timeout": "Second-60"})).status_code == 200
    assert (await dav("PUT", "/report.txt", content=b"v3", headers={"If": "(<opaquelocktoken:nope>)"})).status_code == 412
    assert "lockdiscovery" in (await dav("PROPFIND", "/report.txt", headers={"Depth": "0"})).text
    assert (await dav("UNLOCK", "/report.txt", headers={"Lock-Token": f"<{token}>"})).status_code == 204
    assert (await dav("PUT", "/report.txt", content=b"v3")).status_code == 204
    # A name that doesn't exist yet can be locked first (the PUT makes it).
    r = await dav("LOCK", "/new.txt", content=body)
    assert r.status_code == 201
    assert (await dav("PUT", "/new.txt", content=b"n", headers={"If": f"({r.headers['Lock-Token']})"})).status_code == 201


@pytest.mark.asyncio
async def test_proppatch_sets_the_modified_time_only(dav, db, user):
    await dav("PUT", "/t.txt", content=b"t")
    body = (b'<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:z="urn:schemas-microsoft-com:"><d:set><d:prop>'
            b"<z:Win32LastModifiedTime>Wed, 01 Jan 2020 10:00:00 GMT</z:Win32LastModifiedTime>"
            b"<z:Win32FileAttributes>00000020</z:Win32FileAttributes></d:prop></d:set></d:propertyupdate>")
    r = await dav("PROPPATCH", "/t.txt", content=body)
    assert r.status_code == 207 and "200 OK" in r.text
    row = await _file(db, user, "t.txt")
    await db.refresh(row)
    assert row.client_mtime.year == 2020
    other = b'<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:x="urn:x"><d:set><d:prop><x:colour>red</x:colour></d:prop></d:set></d:propertyupdate>'
    assert "403 Forbidden" in (await dav("PROPPATCH", "/t.txt", content=other)).text


@pytest.mark.asyncio
async def test_over_the_quota_and_into_a_workspace_are_refused(dav, db, user):
    from app.auth.models import User
    from app.files.models import FileFolder
    from app.files.system_folders import SystemKind

    me = await db.get(User, user.id)
    me.storage_cap_bytes = 10
    await db.commit()
    assert (await dav("PUT", "/big.txt", content=b"x" * 100)).status_code == 507

    me.storage_cap_bytes = None
    db.add(FileFolder(user_id=user.id, name="Workspaces", system_kind=SystemKind.WORKSPACES_ROOT.value))
    await db.commit()
    assert (await dav("PUT", "/Workspaces/x.txt", content=b"x")).status_code == 403
    assert (await dav("MKCOL", "/Workspaces/New")).status_code == 403


@pytest.mark.asyncio
async def test_a_text_file_that_is_really_binary_is_stored_not_a_500(dav, db, user):
    # Its "text" has NUL bytes, which Postgres can't hold: the save of the
    # search text failed, and the error path then answered 500 for a stored file.
    data = bytes(range(256)) * 40
    assert (await dav("PUT", "/random.txt", content=data)).status_code == 201
    row = await _file(db, user, "random.txt")
    assert row.content_text is None or "\x00" not in row.content_text
    assert (await dav("GET", "/random.txt")).content == data


@pytest.mark.asyncio
async def test_a_phone_that_may_not_delete_keeps_the_file_here(client, db, user):
    """Without ``dav:delete`` a device's DELETE frees space on the device
    only — the file stays in Promptly (and the app is told it went)."""
    _row, auth = await _device(db, user, scopes=("dav:read", "dav:write"))

    async def dav(method, path, **kw):
        return await client.request(method, "/dav" + path, headers=auth, **kw)

    await dav("MKCOL", "/Camera")
    assert (await dav("PUT", "/Camera/notes.txt", content=b"phone notes")).status_code == 201
    assert (await dav("DELETE", "/Camera/notes.txt")).status_code == 204
    assert (await dav("DELETE", "/Camera/")).status_code == 204
    row = await _file(db, user, "notes.txt")
    assert row.trashed_at is None
    assert (await dav("GET", "/Camera/notes.txt")).content == b"phone notes"
    assert (await dav("DELETE", "/Camera/nothing.txt")).status_code == 404


@pytest.mark.asyncio
async def test_a_device_can_be_allowed_to_delete_later(client, db, user):
    from tests.test_app_passwords_wp83 import _auth

    row, auth = await _device(db, user, scopes=("dav:read", "dav:write"))
    await client.request("PUT", "/dav/old.txt", headers=auth, content=b"old")
    r = await client.patch(f"/api/auth/app-passwords/{row.id}", json={"scopes": ["dav:read", "dav:write", "dav:delete"]},
                           headers=_auth(user))
    assert r.status_code == 200 and r.json()["scopes"] == ["dav:delete", "dav:read", "dav:write"]
    assert (await client.request("DELETE", "/dav/old.txt", headers=auth)).status_code == 204
    gone = (await db.execute(select(UserFile_()).where(UserFile_().filename == "old.txt"))).scalars().one()
    await db.refresh(gone)
    assert gone.trashed_at is not None
    assert (await client.patch(f"/api/auth/app-passwords/{row.id}", json={"scopes": ["root"]},
                               headers=_auth(user))).status_code == 422


def UserFile_():  # noqa: N802 — the model, imported late like the other tests do
    from app.files.models import UserFile

    return UserFile
