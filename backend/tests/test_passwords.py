"""Promptly Passwords API (plan 13.3): authorisation across users on every
endpoint, removed members, revoked devices, sign-out-everywhere, rate limits,
sync conflicts, cascade delete, SECRET_KEY rotation.

The server treats everything as opaque, so these use random bytes for blobs.
Real client-side encryption is covered by the core's tests and the canary run.
"""
from __future__ import annotations

import base64
import logging
import os
import re
import uuid
from datetime import timedelta

import httpx
import pytest


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


KDF = {"alg": "argon2id", "m": 65536, "t": 3, "p": 1}


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


async def make_user(db, role="user", name=None):
    from app.auth.models import User

    tag = name or uuid.uuid4().hex[:8]
    row = User(email=f"{tag}@example.com", username=f"u{tag}", password_hash="x", role=role)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def bearer(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


class Vaulted:
    """A user with an account, a session and a personal vault."""

    def __init__(self, user, auth_key, session, vault_id, account_id):
        self.user = user
        self.auth_key = auth_key
        self.session = session
        self.vault_id = vault_id
        self.account_id = account_id

    @property
    def h(self):
        return {**bearer(self.user), "X-Vault-Session": self.session}


async def setup_vault(client, user) -> Vaulted:
    auth_key = os.urandom(32)
    account_id, vault_id = str(uuid.uuid4()), str(uuid.uuid4())
    r = await client.post(
        "/api/passwords/account",
        headers=bearer(user),
        json={
            "account_id": account_id,
            "kdf": KDF,
            "salt": b64(os.urandom(16)),
            "auth_key": b64(auth_key),
            "wrapped_keyset": b64(os.urandom(93)),
            "x25519_pub": b64(os.urandom(32)),
            "ed25519_pub": b64(os.urandom(32)),
            "personal_vault_id": vault_id,
            "personal_vault_name": b64(os.urandom(286)),
            "personal_vault_grant": {"wrapped_key": b64(os.urandom(94)), "signature": b64(os.urandom(64))},
        },
    )
    assert r.status_code == 201, r.text
    return Vaulted(user, auth_key, r.json()["token"], vault_id, account_id)


def grant():
    return {"wrapped_key": b64(os.urandom(94)), "signature": b64(os.urandom(64))}


async def shared_vault(client, owner: Vaulted) -> str:
    vid = str(uuid.uuid4())
    r = await client.post("/api/passwords/vaults", headers=owner.h, json={"id": vid, "name": b64(os.urandom(286)), "grant": grant()})
    assert r.status_code == 201, r.text
    return vid


async def write(client, who: Vaulted, vault_id, entries):
    r = await client.post(f"/api/passwords/vaults/{vault_id}/items", headers=who.h, json={"items": entries})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ accounts


async def test_setup_unlock_and_prelogin(client, db):
    u = await make_user(db)
    r = await client.get("/api/passwords/account", headers=bearer(u))
    assert r.json()["exists"] is False
    v = await setup_vault(client, u)
    r = await client.get("/api/passwords/account", headers=bearer(u))
    body = r.json()
    assert body["exists"] is True
    assert body["kdf"] == KDF
    # Prelogin gives no ciphertext: that needs a session.
    assert "wrapped_keyset" not in body

    r = await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": b64(v.auth_key)})
    assert r.status_code == 200
    assert r.json()["token"].startswith("pws_")
    assert r.json()["wrapped_keyset"]

    r = await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": b64(os.urandom(32))})
    assert r.status_code == 401


async def test_second_account_refused(client, db):
    u = await make_user(db)
    await setup_vault(client, u)
    r = await client.post(
        "/api/passwords/account",
        headers=bearer(u),
        json={
            "account_id": str(uuid.uuid4()),
            "kdf": KDF,
            "salt": b64(os.urandom(16)),
            "auth_key": b64(os.urandom(32)),
            "wrapped_keyset": b64(os.urandom(93)),
            "x25519_pub": b64(os.urandom(32)),
            "ed25519_pub": b64(os.urandom(32)),
            "personal_vault_id": str(uuid.uuid4()),
            "personal_vault_name": b64(os.urandom(10)),
            "personal_vault_grant": grant(),
        },
    )
    assert r.status_code == 409


@pytest.mark.parametrize(
    "kdf",
    [
        {"alg": "argon2id", "m": 32768, "t": 3, "p": 1},
        {"alg": "argon2id", "m": 65536, "t": 2, "p": 1},
        {"alg": "argon2i", "m": 65536, "t": 3, "p": 1},
        {"alg": "argon2id", "m": 9999999, "t": 3, "p": 1},
    ],
)
async def test_weak_kdf_refused(client, db, kdf):
    u = await make_user(db)
    r = await client.post(
        "/api/passwords/account",
        headers=bearer(u),
        json={
            "account_id": str(uuid.uuid4()),
            "kdf": kdf,
            "salt": b64(os.urandom(16)),
            "auth_key": b64(os.urandom(32)),
            "wrapped_keyset": b64(os.urandom(93)),
            "x25519_pub": b64(os.urandom(32)),
            "ed25519_pub": b64(os.urandom(32)),
            "personal_vault_id": str(uuid.uuid4()),
            "personal_vault_name": b64(os.urandom(10)),
            "personal_vault_grant": grant(),
        },
    )
    assert r.status_code == 400


async def test_server_stores_only_a_salted_hash_of_auth_key(client, db):
    from sqlalchemy import select

    from app.passwords.models import PwAccount

    u = await make_user(db)
    v = await setup_vault(client, u)
    row = await db.scalar(select(PwAccount).where(PwAccount.user_id == u.id))
    assert v.auth_key not in (row.auth_hash, row.auth_salt)
    assert v.auth_key not in bytes(row.auth_hash)
    other = await make_user(db)
    v2 = await setup_vault(client, other)
    _ = v2
    row2 = await db.scalar(select(PwAccount).where(PwAccount.user_id == other.id))
    assert row.auth_salt != row2.auth_salt


async def test_vault_needs_session_as_well_as_identity(client, db):
    """A stolen Promptly session alone can't download ciphertext."""
    u = await make_user(db)
    v = await setup_vault(client, u)
    await write(client, v, v.vault_id, [{"id": str(uuid.uuid4()), "blob": b64(os.urandom(300))}])
    for path in (
        f"/api/passwords/vaults/{v.vault_id}/changes",
        "/api/passwords/vaults",
        "/api/passwords/activity",
    ):
        r = await client.get(path, headers=bearer(u))
        assert r.status_code == 401, path
        assert r.json()["detail"] == "vault_locked"
        r = await client.get(path, headers=v.h)
        assert r.status_code == 200, path
    # And a session can't be used without its identity.
    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes", headers={"X-Vault-Session": v.session})
    assert r.status_code == 401


async def test_session_belongs_to_one_user(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    r = await client.get("/api/passwords/vaults", headers={**bearer(b.user), "X-Vault-Session": a.session})
    assert r.status_code == 401


async def test_account_locks_after_too_many_wrong_keys(client, db):
    from app.passwords import service

    u = await make_user(db)
    v = await setup_vault(client, u)
    for _ in range(service.FAILED_LIMIT):
        r = await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": b64(os.urandom(32))})
        assert r.status_code == 401
    r = await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": b64(v.auth_key)})
    assert r.status_code == 429
    assert "Retry-After" in r.headers


async def test_ip_rate_limit_counts_only_wrong_proofs(db):
    from app import rate_limit
    from app.main import app
    from app.passwords import router as pw_router

    u = await make_user(db)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        rate_limit._settings.RATE_LIMIT_ENABLED = False
        v = await setup_vault(c, u)
        rate_limit._settings.RATE_LIMIT_ENABLED = True
        try:
            # A fresh IP so other tests' counters don't matter.
            headers = {**bearer(u), "CF-Connecting-IP": "203.0.113.77", "X-Real-IP": "203.0.113.77"}
            await rate_limit._limiter.storage.reset() if hasattr(rate_limit._limiter.storage, "reset") else None
            for _ in range(pw_router._PROOF_LIMIT.amount + 3):
                ok = await c.post("/api/passwords/session", headers=headers, json={"auth_key": b64(v.auth_key)})
                assert ok.status_code == 200
            codes = []
            for _ in range(pw_router._PROOF_LIMIT.amount + 3):
                bad = await c.post("/api/passwords/session", headers=headers, json={"auth_key": b64(os.urandom(32))})
                codes.append(bad.status_code)
            assert 429 in codes
        finally:
            rate_limit._settings.RATE_LIMIT_ENABLED = True


async def test_rekey_replaces_the_proof_and_ends_other_sessions(client, db):
    u = await make_user(db)
    v = await setup_vault(client, u)
    r = await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": b64(v.auth_key)})
    other_session = r.json()["token"]

    new_key = os.urandom(32)
    bad = await client.post(
        "/api/passwords/account/rekey",
        headers=v.h,
        json={"auth_key": b64(os.urandom(32)), "new_kdf": KDF, "new_salt": b64(os.urandom(16)), "new_auth_key": b64(new_key), "new_wrapped_keyset": b64(os.urandom(93))},
    )
    assert bad.status_code == 401
    r = await client.post(
        "/api/passwords/account/rekey",
        headers=v.h,
        json={"auth_key": b64(v.auth_key), "new_kdf": KDF, "new_salt": b64(os.urandom(16)), "new_auth_key": b64(new_key), "new_wrapped_keyset": b64(os.urandom(93))},
    )
    assert r.status_code == 204
    assert (await client.get("/api/passwords/vaults", headers=v.h)).status_code == 200
    assert (await client.get("/api/passwords/vaults", headers={**bearer(u), "X-Vault-Session": other_session})).status_code == 401
    assert (await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": b64(v.auth_key)})).status_code == 401
    assert (await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": b64(new_key)})).status_code == 200


async def test_reset_needs_typed_confirmation_and_password(client, db):
    from app.auth.utils import hash_password

    u = await make_user(db)
    u.password_hash = hash_password("Login-pass-1!")
    await db.commit()
    v = await setup_vault(client, u)
    await write(client, v, v.vault_id, [{"id": str(uuid.uuid4()), "blob": b64(os.urandom(300))}])
    r = await client.post("/api/passwords/account/reset", headers=bearer(u), json={"confirm": "yes", "password": "Login-pass-1!"})
    assert r.status_code == 400
    r = await client.post("/api/passwords/account/reset", headers=bearer(u), json={"confirm": "DELETE MY VAULT", "password": "nope"})
    assert r.status_code == 403
    r = await client.post("/api/passwords/account/reset", headers=bearer(u), json={"confirm": "DELETE MY VAULT", "password": "Login-pass-1!"})
    assert r.status_code == 204
    assert (await client.get("/api/passwords/account", headers=bearer(u))).json()["exists"] is False
    # A vault session died with it.
    assert (await client.get("/api/passwords/vaults", headers=v.h)).status_code == 401


# ------------------------------------------------------------------ sync


async def test_delta_sync_and_conflicts(client, db):
    v = await setup_vault(client, await make_user(db))
    a, c = str(uuid.uuid4()), str(uuid.uuid4())
    first = await write(client, v, v.vault_id, [{"id": a, "blob": b64(b"a1" * 150)}, {"id": c, "blob": b64(b"c1" * 150)}])
    assert first["revision"] == 1
    assert sorted(first["applied"]) == sorted([a, c])

    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes?since=0", headers=v.h)
    assert {i["id"] for i in r.json()["items"]} == {a, c}
    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes?since=1", headers=v.h)
    assert r.json()["items"] == []

    second = await write(client, v, v.vault_id, [{"id": a, "base_revision": 1, "blob": b64(b"a2" * 150)}])
    assert second["revision"] == 2
    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes?since=1", headers=v.h)
    assert [i["id"] for i in r.json()["items"]] == [a]

    # A stale edit is refused and hands back what's there: nothing is lost.
    stale = await write(client, v, v.vault_id, [{"id": a, "base_revision": 1, "blob": b64(b"a3" * 150)}])
    assert stale["applied"] == []
    assert stale["revision"] == 2
    assert stale["conflicts"][0]["id"] == a
    assert unb64(stale["conflicts"][0]["blob"]) == b"a2" * 150
    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes?since=0", headers=v.h)
    assert unb64(next(i for i in r.json()["items"] if i["id"] == a)["blob"]) == b"a2" * 150


async def test_paging_changes(client, db):
    v = await setup_vault(client, await make_user(db))
    for _ in range(5):
        await write(client, v, v.vault_id, [{"id": str(uuid.uuid4()), "blob": b64(os.urandom(280))}])
    seen = []
    since = 0
    while True:
        r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes?since={since}&limit=2", headers=v.h)
        body = r.json()
        seen += body["items"]
        if not body["more"]:
            break
        since = body["items"][-1]["revision"]
    assert len(seen) == 5


async def test_versions_kept_and_capped(client, db):
    from app.passwords import service

    v = await setup_vault(client, await make_user(db))
    a = str(uuid.uuid4())
    rev = 0
    total = service.VERSIONS_KEPT + 5
    for i in range(total):
        out = await write(client, v, v.vault_id, [{"id": a, "base_revision": rev, "blob": b64(bytes([i]) * 300)}])
        rev = out["revision"]
    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/items/{a}/versions", headers=v.h)
    versions = r.json()
    assert len(versions) == service.VERSIONS_KEPT
    assert unb64(versions[0]["blob"]) == bytes([total - 2]) * 300
    assert versions[0]["revision"] > versions[-1]["revision"]


async def test_trash_and_purge_and_sweep(client, db):
    from datetime import datetime, timezone

    from sqlalchemy import select

    from app.passwords import service
    from app.passwords.models import PwItem

    v = await setup_vault(client, await make_user(db))
    a, c = str(uuid.uuid4()), str(uuid.uuid4())
    await write(client, v, v.vault_id, [{"id": a, "blob": b64(b"a" * 300)}, {"id": c, "blob": b64(b"c" * 300)}])
    await write(client, v, v.vault_id, [{"id": a, "base_revision": 1, "deleted": True}])
    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes?since=1", headers=v.h)
    item = r.json()["items"][0]
    assert item["deleted"] is True and item["purged"] is False and item["blob"]

    # Restore clears it.
    await write(client, v, v.vault_id, [{"id": a, "base_revision": 2, "deleted": False}])
    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes?since=2", headers=v.h)
    assert r.json()["items"][0]["deleted"] is False

    # Purge leaves a tombstone so other devices drop it too.
    out = await write(client, v, v.vault_id, [{"id": c, "base_revision": 1, "purge": True}])
    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes?since={out['revision'] - 1}", headers=v.h)
    t = r.json()["items"][0]
    assert t["purged"] is True and t["blob"] is None

    # Trash past 30 days gets swept the same way.
    await write(client, v, v.vault_id, [{"id": a, "base_revision": 3, "deleted": True}])
    row = await db.scalar(select(PwItem).where(PwItem.id == uuid.UUID(a)))
    row.deleted_at = datetime.now(timezone.utc) - timedelta(days=31)
    await db.commit()
    assert (await service.sweep(db))["trash"] == 1
    db.expire_all()
    row = await db.scalar(select(PwItem).where(PwItem.id == uuid.UUID(a)))
    assert row.blob is None


async def test_blob_size_cap(client, db):
    v = await setup_vault(client, await make_user(db))
    r = await client.post(
        f"/api/passwords/vaults/{v.vault_id}/items",
        headers=v.h,
        json={"items": [{"id": str(uuid.uuid4()), "blob": b64(b"x" * (8 * 1024 * 1024 + 1))}]},
    )
    assert r.status_code == 422
    # The error doesn't echo the blob.
    assert "xxxxxxxx" not in r.text


async def test_item_id_from_another_vault_cant_be_overwritten(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    item = str(uuid.uuid4())
    await write(client, a, a.vault_id, [{"id": item, "blob": b64(b"mine" * 75)}])
    out = await write(client, b, b.vault_id, [{"id": item, "base_revision": 99, "blob": b64(b"evil" * 75)}])
    assert out["applied"] == []
    assert out["conflicts"][0]["reason"] == "other_vault"
    assert "blob" not in out["conflicts"][0] or out["conflicts"][0]["blob"] is None
    r = await client.get(f"/api/passwords/vaults/{a.vault_id}/changes?since=0", headers=a.h)
    assert unb64(r.json()["items"][0]["blob"]) == b"mine" * 75


# ------------------------------------------------------------------ authorisation sweep


async def test_other_users_get_404_on_every_vault_endpoint(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    item = str(uuid.uuid4())
    await write(client, a, a.vault_id, [{"id": item, "blob": b64(b"x" * 300)}])
    vid = a.vault_id
    calls = [
        ("GET", f"/api/passwords/vaults/{vid}/changes", None),
        ("POST", f"/api/passwords/vaults/{vid}/items", {"items": [{"id": str(uuid.uuid4()), "blob": b64(b"e" * 300)}]}),
        ("GET", f"/api/passwords/vaults/{vid}/items/{item}/versions", None),
        ("GET", f"/api/passwords/vaults/{vid}/members", None),
        ("POST", f"/api/passwords/vaults/{vid}/members", {"user_id": str(b.user.id), "role": "view", "grant": grant()}),
        ("PATCH", f"/api/passwords/vaults/{vid}", {"name": b64(b"n")}),
        ("DELETE", f"/api/passwords/vaults/{vid}", None),
        ("POST", f"/api/passwords/vaults/{vid}/accept", None),
        ("POST", f"/api/passwords/vaults/{vid}/leave", None),
        ("PATCH", f"/api/passwords/vaults/{vid}/members/{a.user.id}", {"role": "view"}),
        ("POST", f"/api/passwords/vaults/{vid}/rotate", {"from_generation": 1, "name": b64(b"n"), "members": [], "items": []}),
    ]
    for method, path, body in calls:
        r = await client.request(method, path, headers=b.h, json=body)
        assert r.status_code == 404, f"{method} {path} -> {r.status_code}"
    # Nothing changed for the owner.
    r = await client.get(f"/api/passwords/vaults/{vid}/changes?since=0", headers=a.h)
    assert len(r.json()["items"]) == 1


async def test_endpoints_refuse_no_auth_at_all(client, db):
    for method, path in (
        ("GET", "/api/passwords/account"),
        ("POST", "/api/passwords/account"),
        ("POST", "/api/passwords/session"),
        ("GET", "/api/passwords/vaults"),
        ("GET", "/api/passwords/devices"),
        ("POST", "/api/passwords/device-requests"),
        ("GET", "/api/passwords/activity"),
        ("GET", "/api/passwords/connect/code/ABCD1234"),
        ("POST", "/api/passwords/connect/code/ABCD1234/approve"),
        ("GET", "/api/passwords/status"),
        ("GET", "/api/passwords/admin/policy"),
    ):
        r = await client.request(method, path, json={} if method == "POST" else None)
        assert r.status_code in (401, 403, 422), f"{method} {path} -> {r.status_code}"
        assert r.status_code != 200


# ------------------------------------------------------------------ sharing


async def test_sharing_roles_and_removal(client, db):
    owner = await setup_vault(client, await make_user(db))
    bob = await setup_vault(client, await make_user(db))
    eve = await setup_vault(client, await make_user(db))
    vid = await shared_vault(client, owner)
    item = str(uuid.uuid4())
    await write(client, owner, vid, [{"id": item, "blob": b64(b"s" * 300)}])

    r = await client.post(f"/api/passwords/vaults/{vid}/members", headers=owner.h, json={"user_id": str(bob.user.id), "role": "view", "grant": grant()})
    assert r.status_code == 204
    r = await client.get(f"/api/passwords/vaults/{vid}/changes?since=0", headers=bob.h)
    assert len(r.json()["items"]) == 1

    # A viewer can't write or manage.
    r = await client.post(f"/api/passwords/vaults/{vid}/items", headers=bob.h, json={"items": [{"id": str(uuid.uuid4()), "blob": b64(b"e" * 300)}]})
    assert r.status_code == 403
    r = await client.post(f"/api/passwords/vaults/{vid}/members", headers=bob.h, json={"user_id": str(eve.user.id), "role": "view", "grant": grant()})
    assert r.status_code == 403
    r = await client.patch(f"/api/passwords/vaults/{vid}/members/{bob.user.id}", headers=bob.h, json={"role": "manage"})
    assert r.status_code == 403

    # An editor can write, but not manage.
    r = await client.patch(f"/api/passwords/vaults/{vid}/members/{bob.user.id}", headers=owner.h, json={"role": "edit"})
    assert r.status_code == 204
    r = await client.post(f"/api/passwords/vaults/{vid}/items", headers=bob.h, json={"items": [{"id": str(uuid.uuid4()), "blob": b64(b"e" * 300)}]})
    assert r.status_code == 200
    r = await client.delete(f"/api/passwords/vaults/{vid}", headers=bob.h)
    assert r.status_code == 403

    # Rotation needs every remaining member and every live item.
    live = (await client.get(f"/api/passwords/vaults/{vid}/changes?since=0", headers=owner.h)).json()["items"]
    r = await client.post(
        f"/api/passwords/vaults/{vid}/rotate",
        headers=owner.h,
        json={"from_generation": 1, "name": b64(b"n" * 286), "remove_user_ids": [str(bob.user.id)], "members": [], "items": []},
    )
    assert r.status_code == 400
    r = await client.post(
        f"/api/passwords/vaults/{vid}/rotate",
        headers=owner.h,
        json={
            "from_generation": 1,
            "name": b64(b"n" * 286),
            "remove_user_ids": [str(bob.user.id)],
            "members": [{"user_id": str(owner.user.id), "grant": grant()}],
            "items": [{"id": i["id"], "blob": b64(b"rotated" * 40)} for i in live],
        },
    )
    assert r.status_code == 204
    # Bob's gone, immediately.
    assert (await client.get(f"/api/passwords/vaults/{vid}/changes?since=0", headers=bob.h)).status_code == 404
    v = next(x for x in (await client.get("/api/passwords/vaults", headers=owner.h)).json() if x["id"] == vid)
    assert v["generation"] == 2 and v["member_generation"] == 2
    # Replaying the old generation is refused.
    r = await client.post(
        f"/api/passwords/vaults/{vid}/rotate",
        headers=owner.h,
        json={"from_generation": 1, "name": b64(b"n"), "members": [{"user_id": str(owner.user.id), "grant": grant()}], "items": []},
    )
    assert r.status_code == 409


async def test_rotation_drops_versions_it_didnt_reencrypt(client, db):
    from sqlalchemy import select

    from app.passwords.models import PwItemVersion

    owner = await setup_vault(client, await make_user(db))
    vid = await shared_vault(client, owner)
    a = str(uuid.uuid4())
    await write(client, owner, vid, [{"id": a, "blob": b64(b"1" * 300)}])
    await write(client, owner, vid, [{"id": a, "base_revision": 1, "blob": b64(b"2" * 300)}])
    await write(client, owner, vid, [{"id": a, "base_revision": 2, "blob": b64(b"3" * 300)}])
    r = await client.post(
        f"/api/passwords/vaults/{vid}/rotate",
        headers=owner.h,
        json={
            "from_generation": 1,
            "name": b64(b"n"),
            "members": [{"user_id": str(owner.user.id), "grant": grant()}],
            "items": [{"id": a, "blob": b64(b"4" * 300), "versions": [{"revision": 2, "blob": b64(b"v" * 300)}]}],
        },
    )
    assert r.status_code == 204
    versions = (await db.execute(select(PwItemVersion).where(PwItemVersion.item_id == uuid.UUID(a)))).scalars().all()
    assert [(v.revision, bytes(v.blob)) for v in versions] == [(2, b"v" * 300)]


async def test_last_manager_rules(client, db):
    owner = await setup_vault(client, await make_user(db))
    bob = await setup_vault(client, await make_user(db))
    vid = await shared_vault(client, owner)
    await client.post(f"/api/passwords/vaults/{vid}/members", headers=owner.h, json={"user_id": str(bob.user.id), "role": "view", "grant": grant()})
    r = await client.patch(f"/api/passwords/vaults/{vid}/members/{owner.user.id}", headers=owner.h, json={"role": "view"})
    assert r.status_code == 400
    r = await client.post(f"/api/passwords/vaults/{vid}/leave", headers=owner.h)
    assert r.status_code == 400
    r = await client.post(f"/api/passwords/vaults/{vid}/leave", headers=bob.h)
    assert r.status_code == 204
    # The last one out takes the vault with them.
    r = await client.post(f"/api/passwords/vaults/{vid}/leave", headers=owner.h)
    assert r.status_code == 204
    assert all(v["id"] != vid for v in (await client.get("/api/passwords/vaults", headers=owner.h)).json())


async def test_personal_vault_cant_be_shared_left_or_deleted(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    r = await client.post(f"/api/passwords/vaults/{a.vault_id}/members", headers=a.h, json={"user_id": str(b.user.id), "role": "view", "grant": grant()})
    assert r.status_code == 400
    assert (await client.post(f"/api/passwords/vaults/{a.vault_id}/leave", headers=a.h)).status_code == 400
    assert (await client.delete(f"/api/passwords/vaults/{a.vault_id}", headers=a.h)).status_code == 400


# ------------------------------------------------------------------ devices


async def connect_device(client, user, platform="firefox", name="Firefox on Laptop", scopes=None):
    r = await client.post("/api/passwords/connect/start", json={"name": name, "platform": platform, "scopes": scopes or ["vault"]})
    assert r.status_code == 201, r.text
    started = r.json()
    r = await client.post("/api/passwords/connect/poll", json={"id": started["id"], "poll_secret": started["poll_secret"]})
    assert r.json()["status"] == "pending"
    assert r.json()["token"] is None
    r = await client.get(f"/api/passwords/connect/code/{started['code']}", headers=bearer(user))
    assert r.json()["name"] == name
    r = await client.post(f"/api/passwords/connect/code/{started['code']}/approve", headers=bearer(user))
    assert r.status_code == 204
    r = await client.post("/api/passwords/connect/poll", json={"id": started["id"], "poll_secret": started["poll_secret"]})
    body = r.json()
    assert body["status"] == "approved" and body["token"].startswith("pwd_")
    return body


async def test_connect_flow_and_device_session(client, db):
    u = await make_user(db)
    v = await setup_vault(client, u)
    d = await connect_device(client, u)
    hd = {"Authorization": f"Bearer {d['token']}"}
    # The token alone gets no ciphertext.
    assert (await client.get("/api/passwords/vaults", headers=hd)).status_code == 401
    r = await client.post("/api/passwords/session", headers=hd, json={"auth_key": b64(v.auth_key)})
    assert r.status_code == 200
    hs = {**hd, "X-Vault-Session": r.json()["token"]}
    assert (await client.get("/api/passwords/vaults", headers=hs)).status_code == 200
    # The device's session doesn't work from a different identity.
    assert (await client.get("/api/passwords/vaults", headers={**bearer(u), "X-Vault-Session": r.json()["token"]})).status_code == 401
    # A token isn't handed out twice.
    devices = (await client.get("/api/passwords/devices", headers=hd)).json()
    assert [x["current"] for x in devices] == [True]
    assert devices[0]["platform"] == "firefox"


async def test_connect_token_is_collected_once_and_needs_the_secret(client, db):
    u = await make_user(db)
    r = await client.post("/api/passwords/connect/start", json={"name": "x", "platform": "chromium"})
    started = r.json()
    r = await client.post("/api/passwords/connect/poll", json={"id": started["id"], "poll_secret": "wrong"})
    assert r.status_code == 404
    await client.post(f"/api/passwords/connect/code/{started['code']}/approve", headers=bearer(u))
    r = await client.post("/api/passwords/connect/poll", json={"id": started["id"], "poll_secret": "wrong"})
    assert r.status_code == 404
    r = await client.post("/api/passwords/connect/poll", json={"id": started["id"], "poll_secret": started["poll_secret"]})
    assert r.json()["token"]
    r = await client.post("/api/passwords/connect/poll", json={"id": started["id"], "poll_secret": started["poll_secret"]})
    assert r.status_code == 404


async def test_device_token_stored_only_as_a_hash(client, db):
    from sqlalchemy import select

    from app.passwords.models import PwDevice

    u = await make_user(db)
    d = await connect_device(client, u)
    row = await db.scalar(select(PwDevice).where(PwDevice.user_id == u.id))
    assert row.token_hash != d["token"]
    assert d["token"] not in row.token_hash
    assert len(row.token_hash) == 64


async def test_denied_connect_gets_nothing(client, db):
    u = await make_user(db)
    started = (await client.post("/api/passwords/connect/start", json={"name": "x", "platform": "chromium"})).json()
    await client.post(f"/api/passwords/connect/code/{started['code']}/deny", headers=bearer(u))
    r = await client.post("/api/passwords/connect/poll", json={"id": started["id"], "poll_secret": started["poll_secret"]})
    assert r.json() == {"status": "denied", "token": None, "device_id": None, "user_id": None}
    r = await client.post(f"/api/passwords/connect/code/{started['code']}/approve", headers=bearer(u))
    assert r.status_code == 409


async def test_device_token_cant_approve_or_register_another(client, db):
    u = await make_user(db)
    d = await connect_device(client, u)
    hd = {"Authorization": f"Bearer {d['token']}"}
    started = (await client.post("/api/passwords/connect/start", json={"name": "x", "platform": "chromium"})).json()
    assert (await client.post(f"/api/passwords/connect/code/{started['code']}/approve", headers=hd)).status_code == 401
    assert (await client.post("/api/passwords/devices/register", headers=hd, json={"name": "y", "platform": "android"})).status_code == 401


async def test_revoked_device_is_locked_out(client, db):
    u = await make_user(db)
    v = await setup_vault(client, u)
    d = await connect_device(client, u)
    hd = {"Authorization": f"Bearer {d['token']}"}
    r = await client.post("/api/passwords/session", headers=hd, json={"auth_key": b64(v.auth_key)})
    hs = {**hd, "X-Vault-Session": r.json()["token"]}
    r = await client.delete(f"/api/passwords/devices/{d['device_id']}", headers=bearer(u))
    assert r.status_code == 204
    assert (await client.get("/api/passwords/vaults", headers=hs)).status_code == 401
    assert (await client.post("/api/passwords/session", headers=hd, json={"auth_key": b64(v.auth_key)})).status_code == 401
    assert (await client.get("/api/passwords/devices", headers=bearer(u))).json() == []


async def test_cant_revoke_someone_elses_device(client, db):
    a = await make_user(db)
    b = await make_user(db)
    d = await connect_device(client, a)
    assert (await client.delete(f"/api/passwords/devices/{d['device_id']}", headers=bearer(b))).status_code == 404


async def test_sign_out_everywhere_reaches_devices_and_sessions(client, db):
    u = await make_user(db)
    v = await setup_vault(client, u)
    d = await connect_device(client, u)
    hd = {"Authorization": f"Bearer {d['token']}"}
    assert (await client.get("/api/passwords/devices", headers=hd)).status_code == 200
    old_h = v.h
    u.token_version += 1
    await db.commit()
    assert (await client.get("/api/passwords/devices", headers=hd)).status_code == 401
    assert (await client.get("/api/passwords/vaults", headers=old_h)).status_code == 401
    # A fresh login with the new version still needs a new vault session.
    assert (await client.get("/api/passwords/vaults", headers={**bearer(u), "X-Vault-Session": v.session})).status_code == 401


async def test_disabled_user_loses_devices(client, db):
    u = await make_user(db)
    d = await connect_device(client, u)
    hd = {"Authorization": f"Bearer {d['token']}"}
    u.disabled = True
    await db.commit()
    assert (await client.get("/api/passwords/devices", headers=hd)).status_code == 401


async def test_mail_scope_cant_reach_the_vault(client, db):
    u = await make_user(db)
    d = await connect_device(client, u, scopes=["mail_codes"])
    hd = {"Authorization": f"Bearer {d['token']}"}
    assert (await client.get("/api/passwords/account", headers=hd)).status_code == 403
    assert (await client.get("/api/passwords/devices", headers=hd)).status_code == 403


async def test_unknown_scope_or_platform_refused(client, db):
    assert (await client.post("/api/passwords/connect/start", json={"name": "x", "platform": "chromium", "scopes": ["admin"]})).status_code == 400
    assert (await client.post("/api/passwords/connect/start", json={"name": "x", "platform": "toaster"})).status_code == 400


async def test_device_approval_flow(client, db):
    u = await make_user(db)
    v = await setup_vault(client, u)
    other = await make_user(db)
    device_pub, approver_pub = os.urandom(32), os.urandom(32)
    payload = os.urandom(200)
    pushes = []

    import app.passwords.router as pw_router

    async def fake_notify(**kw):
        pushes.append(kw)

    orig = pw_router.notify_user
    pw_router.notify_user = fake_notify
    try:
        r = await client.post("/api/passwords/device-requests", headers=bearer(u), json={"name": "New laptop", "platform": "windows", "device_pub": b64(device_pub)})
    finally:
        pw_router.notify_user = orig
    assert r.status_code == 201
    req = r.json()
    # The push says who's asking and nothing about the vault.
    assert pushes[0]["category"] == "passwords"
    assert "New laptop" in pushes[0]["body"]

    # Needs an unlocked session to see, and it's per-user.
    assert (await client.get("/api/passwords/device-requests", headers=bearer(u))).status_code == 401
    listed = (await client.get("/api/passwords/device-requests", headers=v.h)).json()
    assert listed[0]["id"] == req["id"] and unb64(listed[0]["device_pub"]) == device_pub
    assert (await client.post(f"/api/passwords/device-requests/{req['id']}/approver", headers={**bearer(other), "X-Vault-Session": "pws_x"}, json={"approver_pub": b64(approver_pub)})).status_code == 401

    # Approve needs the approver key published first, so both sides can show words.
    assert (await client.post(f"/api/passwords/device-requests/{req['id']}/approve", headers=v.h, json={"payload": b64(payload)})).status_code == 409
    assert (await client.post(f"/api/passwords/device-requests/{req['id']}/approver", headers=v.h, json={"approver_pub": b64(approver_pub)})).status_code == 204
    # A second approver can't swap the key.
    assert (await client.post(f"/api/passwords/device-requests/{req['id']}/approver", headers=v.h, json={"approver_pub": b64(os.urandom(32))})).status_code == 409

    poll = {"poll_secret": req["poll_secret"]}
    state = (await client.post(f"/api/passwords/device-requests/{req['id']}/poll", headers=bearer(u), json=poll)).json()
    assert state["status"] == "pending" and unb64(state["approver_pub"]) == approver_pub and state["payload"] is None
    assert (await client.post(f"/api/passwords/device-requests/{req['id']}/poll", headers=bearer(u), json={"poll_secret": "no"})).status_code == 404
    assert (await client.post(f"/api/passwords/device-requests/{req['id']}/poll", headers=bearer(other), json=poll)).status_code == 404

    assert (await client.post(f"/api/passwords/device-requests/{req['id']}/approve", headers=v.h, json={"payload": b64(payload)})).status_code == 204
    state = (await client.post(f"/api/passwords/device-requests/{req['id']}/poll", headers=bearer(u), json=poll)).json()
    assert state["status"] == "approved" and unb64(state["payload"]) == payload
    # Picked up once.
    assert (await client.post(f"/api/passwords/device-requests/{req['id']}/poll", headers=bearer(u), json=poll)).status_code == 404


async def test_register_device_with_bearer(client, db):
    u = await make_user(db)
    r = await client.post("/api/passwords/devices/register", headers=bearer(u), json={"name": "Pixel", "platform": "android"})
    assert r.status_code == 201
    assert r.json()["token"].startswith("pwd_")
    assert (await client.post("/api/passwords/devices/register", json={"name": "Pixel", "platform": "android"})).status_code == 401


# ------------------------------------------------------------------ deletes, keys, logs


async def test_user_delete_cascades(client, db):
    from sqlalchemy import func, select

    from app.passwords.models import PwAccount, PwActivity, PwDevice, PwItem, PwSession, PwVault, PwVaultMember

    u = await make_user(db)
    v = await setup_vault(client, u)
    await connect_device(client, u)
    await write(client, v, v.vault_id, [{"id": str(uuid.uuid4()), "blob": b64(b"x" * 300)}])
    await db.delete(u)
    await db.commit()
    for model in (PwAccount, PwDevice, PwSession, PwVaultMember, PwActivity):
        assert await db.scalar(select(func.count()).select_from(model)) == 0, model.__name__
    # The vault row itself goes once nobody's left (sweep removes empties).
    assert await db.scalar(select(func.count()).select_from(PwVault)) in (0, 1)
    _ = PwItem


async def test_sweep_removes_vaults_with_no_members(client, db):
    from sqlalchemy import func, select

    from app.passwords import service
    from app.passwords.models import PwItem, PwVault

    u = await make_user(db)
    v = await setup_vault(client, u)
    await write(client, v, v.vault_id, [{"id": str(uuid.uuid4()), "blob": b64(b"x" * 300)}])
    await db.delete(u)
    await db.commit()
    await service.sweep(db)
    assert await db.scalar(select(func.count()).select_from(PwVault)) == 0
    assert await db.scalar(select(func.count()).select_from(PwItem)) == 0


async def test_secret_key_rotation_leaves_the_vault_alone(client, db, monkeypatch):
    """Nothing in the vault depends on the server's SECRET_KEY."""
    from app.config import get_settings

    u = await make_user(db)
    v = await setup_vault(client, u)
    blob = b"opaque" * 50
    item = str(uuid.uuid4())
    await write(client, v, v.vault_id, [{"id": item, "blob": b64(blob)}])
    monkeypatch.setattr(get_settings(), "SECRET_KEY", "a-completely-different-key-" + "x" * 40)
    # A new login token under the new key, and the same auth_key still proves.
    u2 = await db.get(type(u), u.id)
    r = await client.post("/api/passwords/session", headers=bearer(u2), json={"auth_key": b64(v.auth_key)})
    assert r.status_code == 200, r.text
    h = {**bearer(u2), "X-Vault-Session": r.json()["token"]}
    r = await client.get(f"/api/passwords/vaults/{v.vault_id}/changes?since=0", headers=h)
    assert unb64(r.json()["items"][0]["blob"]) == blob


async def test_nothing_from_bodies_reaches_logs(client, db, caplog):
    """auth_key, blobs and poll secrets stay out of every logger, at every level."""
    u = await make_user(db)
    caplog.set_level(logging.DEBUG)
    v = await setup_vault(client, u)
    blob = b"CANARYBLOB" * 40
    await write(client, v, v.vault_id, [{"id": str(uuid.uuid4()), "blob": b64(blob)}])
    bad_key = os.urandom(32)
    await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": b64(bad_key)})
    await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": "not*base64*"})
    started = (await client.post("/api/passwords/connect/start", json={"name": "x", "platform": "chromium"})).json()
    await client.post("/api/passwords/connect/poll", json={"id": started["id"], "poll_secret": started["poll_secret"]})
    text = "\n".join(r.getMessage() + " " + str(r.__dict__) for r in caplog.records)
    for secret in (b64(v.auth_key), b64(bad_key), b64(blob), started["poll_secret"], v.session):
        assert secret not in text


async def test_validation_errors_dont_echo_secrets(client, db):
    u = await make_user(db)
    secret = "A" * 10 + "!!not-base64-secret!!"
    r = await client.post("/api/passwords/session", headers=bearer(u), json={"auth_key": secret})
    assert r.status_code == 422
    assert secret not in r.text


async def test_activity_has_no_names_and_is_per_user(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    events = (await client.get("/api/passwords/activity", headers=a.h)).json()
    assert "vault_created" in [e["event"] for e in events]
    assert set(events[0]) == {"event", "device_id", "at"}
    await client.post("/api/passwords/activity/export", headers=b.h)
    assert "exported" not in [e["event"] for e in (await client.get("/api/passwords/activity", headers=a.h)).json()]


async def test_health_counts_only(client, db):
    from app.passwords.models import PwHealth

    v = await setup_vault(client, await make_user(db))
    r = await client.put("/api/passwords/health", headers=v.h, json={"weak": 1, "reused": 2, "breached": 3, "old": 4, "names": ["Instagram"]})
    assert r.status_code == 204
    row = await db.get(PwHealth, v.user.id)
    assert row.counts == {"weak": 1, "reused": 2, "breached": 3, "old": 4}
    assert (await client.delete("/api/passwords/health", headers=v.h)).status_code == 204


async def test_admin_policy_needs_admin_and_applies(client, db):
    admin = await make_user(db, role="admin")
    u = await make_user(db)
    assert (await client.patch("/api/passwords/admin/policy", headers=bearer(u), json={"preview_badge": False})).status_code == 403
    r = await client.patch("/api/passwords/admin/policy", headers=bearer(admin), json={"min_kdf_m": 131072, "preview_badge": False})
    assert r.status_code == 200 and r.json()["preview_badge"] is False
    r = await client.post(
        "/api/passwords/account",
        headers=bearer(u),
        json={
            "account_id": str(uuid.uuid4()),
            "kdf": KDF,
            "salt": b64(os.urandom(16)),
            "auth_key": b64(os.urandom(32)),
            "wrapped_keyset": b64(os.urandom(93)),
            "x25519_pub": b64(os.urandom(32)),
            "ed25519_pub": b64(os.urandom(32)),
            "personal_vault_id": str(uuid.uuid4()),
            "personal_vault_name": b64(os.urandom(10)),
            "personal_vault_grant": grant(),
        },
    )
    assert r.status_code == 400
    # Turning the feature off closes the API but doesn't touch the data.
    assert (await client.patch("/api/passwords/admin/policy", headers=bearer(admin), json={"enabled": False})).status_code == 200
    assert (await client.get("/api/passwords/account", headers=bearer(u))).status_code == 403


async def test_admin_has_no_route_into_a_vault(client, db):
    admin = await make_user(db, role="admin")
    a = await setup_vault(client, await make_user(db))
    await setup_vault(client, admin)
    r = await client.get(f"/api/passwords/vaults/{a.vault_id}/changes", headers={**bearer(admin), "X-Vault-Session": (await client.post("/api/passwords/session", headers=bearer(admin), json={"auth_key": b64(os.urandom(32))})).json().get("token", "pws_x")})
    assert r.status_code == 401


def test_module_never_imports_server_side_encryption():
    """encrypt_secret is decryptable by the server, so it can't touch vault content."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parent.parent / "app" / "passwords"
    for path in root.glob("*.py"):
        text = path.read_text(encoding="utf8")
        assert not re.search(r"\bencrypt_secret\(|import .*\bencrypt_secret\b", text), path.name


def test_no_chat_tool_touches_the_vault():
    """No AI path: nothing in chat, memory, search or automations imports this module."""
    import pathlib

    app = pathlib.Path(__file__).resolve().parent.parent / "app"
    for sub in ("chat", "memory", "search", "research", "assistant", "tasks", "secrets", "custom_models", "workspaces"):
        for path in (app / sub).rglob("*.py"):
            text = path.read_text(encoding="utf8")
            assert "app.passwords" not in text, path
            assert "pw_items" not in text, path


def test_tables_have_no_plaintext_looking_columns():
    from app.passwords import models

    banned = {"title", "url", "urls", "username", "password", "notes", "folder", "tag", "tags", "item_type", "type", "domain", "icon", "totp"}
    for table in models.Base.metadata.tables.values():
        if table.name.startswith("pw_"):
            assert not banned & {c.name for c in table.columns}, table.name
