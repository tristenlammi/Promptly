"""Shared helpers for the Porch tests (``test_porch_*.py``)."""
from __future__ import annotations

import io
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
async def client(db, root):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_user(db, name: str, role: str = "user"):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}", password_hash="x", role=role)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


@pytest.fixture
async def people(db):
    """ann (a server admin), bob, cat, dan."""
    return [await mk_user(db, "ann", "admin")] + [await mk_user(db, n) for n in ("bob", "cat", "dan")]


async def ok(r, code=200):
    assert r.status_code == code, f"{r.status_code}: {r.text}"
    return r.json() if r.content else None


async def boot(client, u) -> dict:
    return await ok(await client.get("/api/porch/bootstrap", headers=H(u)))


async def group(client, owner, name, visibility="private", invite=(), **extra) -> str:
    body = {"name": name, "visibility": visibility, "invite": [str(x.id) for x in invite], **extra}
    return (await ok(await client.post("/api/porch/groups", headers=H(owner), json=body), 201))["id"]


async def accept(client, u, gid) -> dict:
    return await ok(await client.post(f"/api/porch/groups/{gid}/accept", headers=H(u)))


async def members_of(client, owner, name, people_in, visibility="private") -> str:
    """A group with these people in it (invited and accepted)."""
    gid = await group(client, owner, name, visibility, invite=people_in)
    for p in people_in:
        await accept(client, p, gid)
    return gid


async def say(client, u, groups, body="hello", **extra) -> dict:
    payload = {"kind": "text", "body": body, "groups": groups if groups == "all" else [str(g) for g in groups], **extra}
    return await ok(await client.post("/api/porch/posts", headers=H(u), json=payload), 201)


async def sees(client, u, post_id) -> bool:
    r = await client.get(f"/api/porch/posts/{post_id}", headers=H(u))
    assert r.status_code in (200, 404), r.text
    return r.status_code == 200


async def feed_ids(client, u, **params) -> list[str]:
    got = await ok(await client.get("/api/porch/feed", headers=H(u), params=params))
    return [p["id"] for p in got["posts"]]


async def everyone_id(client, u) -> str:
    return (await boot(client, u))["everyone"]["id"]


def jpeg(size=(1200, 900), colour=(200, 80, 40)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, "JPEG", quality=85)
    return buf.getvalue()


async def upload(client, u, name="IMG_0001.jpg", data: bytes | None = None, mime="image/jpeg", route="camera") -> str:
    """A photo in their Photos library (Files' upload with route=camera)."""
    form = {"scope": "mine"}
    if route:
        form["route"] = route
    r = await client.post("/api/files/", headers=H(u), files={"file": (name, data or jpeg(), mime)}, data=form)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def photo(client, u, name="IMG_0001.jpg", data: bytes | None = None, *, ingest=True) -> str:
    fid = await upload(client, u, name, data or jpeg(colour=(uuid.uuid4().int % 255, 90, 40)))
    if ingest:
        from app.files.media_pipeline import ingest as run

        await run(fid)
    return fid


async def post_photos(client, u, groups, file_ids, body="", **extra) -> dict:
    payload = {
        "kind": "photo", "body": body, "groups": groups if groups == "all" else [str(g) for g in groups],
        "media": [f if isinstance(f, dict) else {"file_id": f} for f in file_ids], **extra,
    }
    return await ok(await client.post("/api/porch/posts", headers=H(u), json=payload), 201)


async def set_porch(db, **values):
    """Change the admin's Porch settings (the app_settings row)."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    for k, v in values.items():
        setattr(row, k, v)
    await db.commit()
    return row


def mpath(url: str) -> str:
    assert url and url.startswith("/m/"), url
    return "/api" + url
