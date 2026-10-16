"""Signed media links (WP-7.5): short-lived ``/m/<token>`` URLs that
``<img>``, ``<video>`` and ``<a download>`` can use without a bearer header,
served by nginx via X-Accel-Redirect (Range, sendfile) once the backend has
checked that whoever the link was issued to may still read the file."""
from __future__ import annotations

import io
import subprocess
import time
import uuid

import httpx
import pytest
from PIL import Image

import app.files.imaging  # noqa: F401


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture(autouse=True)
def no_queue(monkeypatch):
    from app.tasks import queue

    async def nothing(file_id):
        return None

    monkeypatch.setattr(queue, "enqueue_media", nothing)


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


async def _person(db, name):
    from app.auth.models import User

    row = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
               password_hash="x", role="user")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def _jpeg(size=(1600, 1200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (40, 120, 200)).save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _video(tmp_path, name, *codec) -> bytes:
    p = tmp_path / f"src-{uuid.uuid4().hex}-{name}"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
         "-f", "lavfi", "-i", "sine=duration=2", "-shortest", *codec, str(p)],
        check=True,
    )
    return p.read_bytes()


async def _upload(client, user, name, data, mime):
    r = await client.post("/api/files/", files={"file": (name, data, mime)}, data={"scope": "mine"}, headers=_auth(user))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _urls(client, user, fid):
    r = await client.get(f"/api/files/{fid}/signed-urls", headers=_auth(user))
    assert r.status_code == 200, r.text
    return r.json()


def _path(url: str) -> str:
    assert url.startswith("/m/")
    return "/api" + url  # what nginx forwards /m/<token> to


# ---------------------------------------------------------------- the token


def test_a_token_names_one_file_and_rendition_and_cant_be_altered():
    from app.files import media_urls

    fid, uid = uuid.uuid4(), uuid.uuid4()
    url = media_urls.sign(fid, uid, 3, "video", 42)
    claim = media_urls.verify(url.removeprefix("/m/"))
    assert (claim.file_id, claim.user_id, claim.rendition, claim.token_version, claim.ver) == (fid, uid, "video", 3, 42)
    token = url.removeprefix("/m/")
    flipped = token[:10] + ("A" if token[10] != "A" else "B") + token[11:]
    assert media_urls.verify(flipped) is None
    assert media_urls.verify("not-a-token") is None
    # Expired once the window after next has passed; stable inside a window.
    later = time.time() + 2 * media_urls.WINDOW_SECONDS + 1
    assert media_urls.verify(token, now=later) is None
    assert media_urls.sign(fid, uid, 3, "video", 42) == url


def test_the_key_is_only_for_media_links_and_survives_a_rotation(monkeypatch):
    import hashlib
    import hmac

    from app.files import media_urls

    url = media_urls.sign(uuid.uuid4(), uuid.uuid4(), 0, "thumb", 1)
    raw = media_urls._unb64(url.removeprefix("/m/"))
    payload = raw[: media_urls._PAYLOAD.size]
    # A MAC made with SECRET_KEY itself (as other signatures are) is no good.
    plain = hmac.new(media_urls.settings.SECRET_KEY.encode(), payload, hashlib.sha256).digest()[:16]
    assert media_urls.verify(media_urls._b64(payload + plain)) is None

    old = media_urls.settings.SECRET_KEY
    monkeypatch.setattr(media_urls.settings, "SECRET_KEY", "a-brand-new-secret-key-for-this-test")
    assert media_urls.verify(url.removeprefix("/m/")) is None
    monkeypatch.setattr(media_urls.settings, "SECRET_KEY_PREVIOUS", old)
    assert media_urls.verify(url.removeprefix("/m/")) is not None


# ---------------------------------------------------------------- serving


@pytest.mark.asyncio
async def test_a_photo_is_served_by_link_with_range_head_and_safe_headers(client, db, user):
    from app.files.media_pipeline import ingest

    data = _jpeg()
    fid = await _upload(client, user, "beach.jpg", data, "image/jpeg")
    urls = await _urls(client, user, fid)
    assert urls["original"] and urls["thumb"] is None and urls["state"] in (None, "pending")

    # No bearer header: the link is the credential.
    r = await client.get(_path(urls["original"]))
    assert r.status_code == 200 and r.content == data
    assert r.headers["content-type"] == "image/jpeg"
    assert r.headers["content-disposition"].startswith("attachment;")
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "immutable" in r.headers["cache-control"]

    part = await client.get(_path(urls["original"]), headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and part.content == data[:100]
    assert part.headers["content-range"] == f"bytes 0-99/{len(data)}"
    head = await client.head(_path(urls["original"]))
    assert head.status_code == 200 and head.content == b"" and int(head.headers["content-length"]) == len(data)

    await ingest(fid)
    urls = await _urls(client, user, fid)
    tile = await client.get(_path(urls["thumb"]))
    assert tile.status_code == 200 and tile.headers["content-type"] == "image/webp"
    assert "content-disposition" not in tile.headers
    assert Image.open(io.BytesIO((await client.get(_path(urls["preview"]))).content)).size == (1440, 1080)

    # The grid's rows carry the tile link — no API call per tile.
    listing = (await client.get("/api/files/browse?scope=mine", headers=_auth(user))).json()
    [row] = [f for f in listing["files"] if f["id"] == fid]
    assert row["thumb_url"] == urls["thumb"]


@pytest.mark.asyncio
async def test_behind_nginx_the_bytes_go_by_x_accel_redirect(client, db, user):
    from app.files.models import UserFile

    fid = await _upload(client, user, "notes.txt", b"hello", "text/plain")
    urls = await _urls(client, user, fid)
    r = await client.get(_path(urls["original"]), headers={"X-Promptly-Accel": "1"})
    row = await db.get(UserFile, uuid.UUID(fid))
    assert r.status_code == 200 and r.content == b""
    assert r.headers["x-accel-redirect"] == f"/_blobs/{row.storage_path}"
    assert r.headers["content-type"].startswith("text/plain")
    assert r.headers["content-disposition"].startswith("attachment;")


    # Renditions go to their own internal location (inline, no download).
    from app.files.media_pipeline import ingest

    pic = await _upload(client, user, "p.jpg", _jpeg((400, 300)), "image/jpeg")
    await ingest(pic)
    tile = await client.get(_path((await _urls(client, user, pic))["thumb"]), headers={"X-Promptly-Accel": "1"})
    assert tile.headers["x-accel-redirect"] == f"/_renditions/{pic}/thumb.webp"
    assert tile.headers["content-type"] == "image/webp" and "content-disposition" not in tile.headers


@pytest.mark.asyncio
async def test_videos_play_from_the_web_copy_or_the_original_meanwhile(client, db, user, tmp_path):
    from app.files.media_pipeline import ingest

    mp4 = await _upload(client, user, "clip.mp4", _video(tmp_path, "c.mp4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"), "video/mp4")
    mov = await _upload(client, user, "IMG.MOV", _video(tmp_path, "i.mov", "-c:v", "libx265", "-tag:v", "hvc1", "-c:a", "aac"), "video/quicktime")
    # Before the worker: an MP4 plays as uploaded; a MOV waits for its copy.
    assert (await _urls(client, user, mp4))["video"] == (await _urls(client, user, mp4))["original"]
    assert (await _urls(client, user, mov))["video"] is None

    await ingest(mov)
    urls = await _urls(client, user, mov)
    assert urls["video"] and urls["poster"] and urls["video"] != urls["original"]
    v = await client.get(_path(urls["video"]), headers={"Range": "bytes=0-1023"})
    assert v.status_code == 206 and v.headers["content-type"] == "video/mp4" and len(v.content) == 1024
    assert (await client.get(_path(urls["poster"]))).headers["content-type"] == "image/webp"


@pytest.mark.asyncio
async def test_a_link_stops_working_when_access_or_the_session_ends(client, db, user):
    from app.auth.models import User

    pal = await _person(db, "pal")
    fid = await _upload(client, user, "shared.jpg", _jpeg((200, 100)), "image/jpeg")
    r = await client.post(f"/api/files/file/{fid}/grants", json={"grantee_user_id": str(pal.id)}, headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    link = _path((await _urls(client, pal, fid))["original"])
    assert (await client.get(link)).status_code == 200

    # Unshared → the grantee's link is dead at once, not in a few hours.
    gid = (await client.get(f"/api/files/file/{fid}/grants", headers=_auth(user))).json()["grants"][0]["grant_id"]
    await client.delete(f"/api/files/file/{fid}/grants/{gid}", headers=_auth(user))
    assert (await client.get(link)).status_code == 404
    assert (await client.get(f"/api/files/{fid}/signed-urls", headers=_auth(pal))).status_code == 404

    # "Sign out everywhere" (token_version) ends the owner's links too.
    own = _path((await _urls(client, user, fid))["original"])
    assert (await client.get(own)).status_code == 200
    me = await db.get(User, user.id)
    me.token_version += 1
    await db.commit()
    assert (await client.get(own)).status_code == 404


@pytest.mark.asyncio
async def test_sheets_and_documents_have_no_original_link(client, db, user):
    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "Rota"}, headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    urls = await _urls(client, user, r.json()["id"])
    assert urls["original"] is None and urls["video"] is None


@pytest.mark.asyncio
async def test_media_links_have_their_own_rate_bucket(client, user, monkeypatch):
    from app import rate_limit

    buckets = []

    async def hit(limit, bucket, key):
        buckets.append((bucket, str(limit)))
        return True

    monkeypatch.setattr(rate_limit._limiter, "hit", hit)
    monkeypatch.setattr(rate_limit._settings, "RATE_LIMIT_ENABLED", True)
    fid = await _upload(client, user, "a.txt", b"x", "text/plain")
    buckets.clear()
    urls = await _urls(client, user, fid)
    await client.get(_path(urls["original"]), headers={"X-Real-IP": "203.0.113.9"})
    assert ("media", str(rate_limit._LIMIT_MEDIA)) in buckets
