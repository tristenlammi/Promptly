"""Attachments, the breach range, the directories and favicons."""
from __future__ import annotations

import os
import uuid

import httpx
import pytest

from tests.test_passwords import b64, bearer, client, make_user, setup_vault, shared_vault, write  # noqa: F401


async def _item(client, v, vault_id=None):
    item = str(uuid.uuid4())
    await write(client, v, vault_id or v.vault_id, [{"id": item, "blob": b64(os.urandom(300))}])
    return item


@pytest.fixture(autouse=True)
def _uploads(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path)
    return tmp_path


async def test_attachment_round_trip_and_resume(client, db, _uploads):
    v = await setup_vault(client, await make_user(db))
    item = await _item(client, v)
    aid = str(uuid.uuid4())
    url = f"/api/passwords/vaults/{v.vault_id}/attachments"
    r = await client.post(url, headers=v.h, json={"id": aid, "item_id": item, "chunk_count": 3})
    assert r.status_code == 200 and r.json()["received"] == []
    chunks = [os.urandom(1000) for _ in range(3)]
    assert (await client.put(f"{url}/{aid}/chunks/0", headers=v.h, content=chunks[0])).status_code == 204
    assert (await client.post(f"{url}/{aid}/finish", headers=v.h)).status_code == 409

    # A resumed upload learns what's there.
    r = await client.post(url, headers=v.h, json={"id": aid, "item_id": item, "chunk_count": 3})
    assert r.json()["received"] == [0]
    for i in (1, 2):
        assert (await client.put(f"{url}/{aid}/chunks/{i}", headers=v.h, content=chunks[i])).status_code == 204
    r = await client.post(f"{url}/{aid}/finish", headers=v.h)
    assert r.json()["complete"] is True
    for i in range(3):
        r = await client.get(f"{url}/{aid}/chunks/{i}", headers=v.h)
        assert r.content == chunks[i]
        assert r.headers["cache-control"] == "no-store"
    # On disk it's where off-site backups look, and only blobs.
    files = list(_uploads.glob("passwords/**/*.bin"))
    assert len(files) == 3

    assert (await client.delete(f"{url}/{aid}", headers=v.h)).status_code == 204
    assert (await client.get(f"{url}/{aid}/chunks/0", headers=v.h)).status_code == 404
    assert not list(_uploads.glob("passwords/**/*.bin"))


async def test_attachment_rules(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    item = await _item(client, a)
    aid = str(uuid.uuid4())
    url = f"/api/passwords/vaults/{a.vault_id}/attachments"
    # Item must be in that vault, and exist.
    assert (await client.post(url, headers=a.h, json={"id": aid, "item_id": str(uuid.uuid4()), "chunk_count": 1})).status_code == 409
    # Over the admin's limit.
    assert (await client.post(url, headers=a.h, json={"id": aid, "item_id": item, "chunk_count": 100000})).status_code == 413
    assert (await client.post(url, headers=a.h, json={"id": aid, "item_id": item, "chunk_count": 1})).status_code == 200
    # Too big, or out of range.
    assert (await client.put(f"{url}/{aid}/chunks/0", headers=a.h, content=b"x" * (1024 * 1024 + 65))).status_code == 413
    assert (await client.put(f"{url}/{aid}/chunks/9", headers=a.h, content=b"x")).status_code == 400
    assert (await client.put(f"{url}/{aid}/chunks/0", headers=a.h, content=b"")).status_code == 400
    # Someone else gets nothing, on any verb.
    assert (await client.post(url, headers=b.h, json={"id": aid, "item_id": item, "chunk_count": 1})).status_code == 404
    assert (await client.put(f"{url}/{aid}/chunks/0", headers=b.h, content=b"x")).status_code == 404
    assert (await client.get(f"{url}/{aid}/chunks/0", headers=b.h)).status_code == 404
    assert (await client.delete(f"{url}/{aid}", headers=b.h)).status_code == 404
    # From another vault of your own, an id doesn't cross over.
    other = await shared_vault(client, a)
    assert (await client.get(f"/api/passwords/vaults/{other}/attachments/{aid}/chunks/0", headers=a.h)).status_code == 404
    # A session is needed.
    assert (await client.get(f"{url}/{aid}/chunks/0", headers=bearer(a.user))).status_code == 401


async def test_breach_range_sends_only_the_prefix_with_padding(client, db, monkeypatch):
    from app.passwords import extras

    seen = {}

    class Fake:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, url, headers=None):
            seen["url"], seen["headers"] = url, headers
            return httpx.Response(200, text="AAAA:1\nBBBB:0")

    monkeypatch.setattr(extras.httpx, "AsyncClient", Fake)
    v = await setup_vault(client, await make_user(db))
    r = await client.post("/api/passwords/breach/range", headers=v.h, json={"prefix": "5baa6"})
    assert r.status_code == 200
    assert r.text == "AAAA:1\nBBBB:0"
    assert seen["url"].endswith("/range/5BAA6")
    assert seen["headers"]["Add-Padding"] == "true"
    # Anything but five hex characters is refused, so a whole hash can't be sent by mistake.
    for bad in ("5BAA", "5BAA61", "ZZZZZ", "../..", "5BAA6/"):
        assert (await client.post("/api/passwords/breach/range", headers=v.h, json={"prefix": bad})).status_code in (400, 422), bad
    assert (await client.post("/api/passwords/breach/range", headers=bearer(v.user), json={"prefix": "5BAA6"})).status_code == 401


async def test_breach_check_can_be_turned_off(client, db):
    admin = await make_user(db, role="admin")
    v = await setup_vault(client, await make_user(db))
    assert (await client.patch("/api/passwords/admin/policy", headers=bearer(admin), json={"breach_check": False})).status_code == 200
    assert (await client.post("/api/passwords/breach/range", headers=v.h, json={"prefix": "5BAA6"})).status_code == 403


async def test_directory_is_the_same_for_everyone_and_needs_a_session(client, db, monkeypatch):
    from app.passwords import extras

    calls = []

    class Fake:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get(self, url, headers=None):
            calls.append(url)
            if "passkeys" in url:
                return httpx.Response(200, json={"a.example": {"mfa": "allowed"}})
            return httpx.Response(200, json={"b.example": {"methods": ["totp"], "documentation": "https://d"}})

    monkeypatch.setattr(extras.httpx, "AsyncClient", Fake)
    extras._directory.update(at=0.0, data=None)
    v = await setup_vault(client, await make_user(db))
    assert (await client.get("/api/passwords/directory", headers=bearer(v.user))).status_code == 401
    r = await client.get("/api/passwords/directory", headers=v.h)
    assert r.json() == {"twofa": {"b.example": {"documentation": "https://d"}}, "passkeys": {"a.example": True}}
    await client.get("/api/passwords/directory", headers=v.h)
    assert len(calls) == 2, "cached for a day"
    extras._directory.update(at=0.0, data=None)


async def test_icon_refuses_anything_not_a_public_domain(client, db):
    v = await setup_vault(client, await make_user(db))
    for bad in ("localhost", "127.0.0.1", "10.0.0.1", "a b.com", "http://x.com", "x.com/evil", "[::1]", "169.254.169.254", "postgres"):
        r = await client.post("/api/passwords/icon", headers=v.h, json={"domain": bad})
        assert r.status_code in (400, 422), bad
    assert (await client.post("/api/passwords/icon", headers=bearer(v.user), json={"domain": "example.com"})).status_code == 401


async def test_icon_refuses_svg_and_html(client, db, monkeypatch):
    import app.net.safe_fetch as sf

    v = await setup_vault(client, await make_user(db))

    async def fake(method, url, **kw):
        return httpx.Response(200, content=b"<svg onload=alert(1)>", headers={"content-type": "image/svg+xml"})

    monkeypatch.setattr(sf, "safe_fetch", fake)
    assert (await client.post("/api/passwords/icon", headers=v.h, json={"domain": "example.com"})).status_code == 404

    async def fake_png(method, url, **kw):
        return httpx.Response(200, content=b"\x89PNG", headers={"content-type": "image/png"})

    monkeypatch.setattr(sf, "safe_fetch", fake_png)
    r = await client.post("/api/passwords/icon", headers=v.h, json={"domain": "example.com"})
    assert r.status_code == 200 and r.headers["x-content-type-options"] == "nosniff"
