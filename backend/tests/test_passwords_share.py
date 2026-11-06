"""Secure Send and emergency access: who can do what, and the limits holding."""
from __future__ import annotations

import os
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from tests.test_passwords import b64, client, make_user, setup_vault, shared_vault  # noqa: F401


def _send(**over):
    body = {"id": str(uuid.uuid4()), "blob": b64(os.urandom(200)), "days": 7, "views": None, "password_salt": None, "password_proof": None}
    body.update(over)
    return body


# ------------------------------------------------------------------ Secure Send


async def test_send_opens_without_an_account_and_views_run_out(client, db):
    a = await setup_vault(client, await make_user(db))
    body = _send(views=2)
    assert (await client.post("/api/passwords/sends", headers=a.h, json=body)).status_code == 201
    url = f"/api/passwords/public/sends/{body['id']}"

    # Asking whether it needs a password doesn't use a view, so a link preview can't.
    for _ in range(3):
        assert (await client.get(url)).json()["has_password"] is False
    r = await client.post(f"{url}/open", json={})
    assert r.status_code == 200 and r.json()["blob"] == body["blob"] and r.json()["views_left"] == 1
    assert r.headers["cache-control"] == "no-store"
    r = await client.post(f"{url}/open", json={})
    assert r.status_code == 200 and r.json()["views_left"] == 0
    assert (await client.post(f"{url}/open", json={})).status_code == 404
    assert (await client.get(url)).status_code == 404


async def test_send_password_is_checked_and_not_stored(client, db):
    from app.passwords.models import PwSend

    a = await setup_vault(client, await make_user(db))
    proof = os.urandom(32)
    body = _send(views=1, password_salt=b64(os.urandom(16)), password_proof=b64(proof))
    await client.post("/api/passwords/sends", headers=a.h, json=body)
    url = f"/api/passwords/public/sends/{body['id']}"
    assert (await client.get(url)).json()["has_password"] is True
    # Wrong tries don't use up the view.
    assert (await client.post(f"{url}/open", json={})).status_code == 403
    assert (await client.post(f"{url}/open", json={"proof": b64(os.urandom(32))})).status_code == 403
    row = await db.get(PwSend, uuid.UUID(body["id"]))
    await db.refresh(row)
    assert row.views_left == 1
    assert row.password_verifier != proof
    assert (await client.post(f"{url}/open", json={"proof": b64(proof)})).status_code == 200


async def test_send_expiry_and_ownership(client, db):
    from app.passwords.models import PwSend

    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    body = _send()
    await client.post("/api/passwords/sends", headers=a.h, json=body)
    url = f"/api/passwords/public/sends/{body['id']}"
    # Someone else's can't be seen or deleted.
    assert (await client.get("/api/passwords/sends", headers=b.h)).json() == []
    assert (await client.delete(f"/api/passwords/sends/{body['id']}", headers=b.h)).status_code == 404
    assert len((await client.get("/api/passwords/sends", headers=a.h)).json()) == 1

    row = await db.get(PwSend, uuid.UUID(body["id"]))
    row.expires_at = row.expires_at - timedelta(days=30)
    await db.commit()
    assert (await client.post(f"{url}/open", json={})).status_code == 404

    # Limits, and it needs a vault session to make one.
    assert (await client.post("/api/passwords/sends", headers=a.h, json=_send(days=31))).status_code == 422
    assert (await client.post("/api/passwords/sends", json=_send())).status_code in (401, 403)
    assert (await client.post("/api/passwords/sends", headers=a.h, json=_send(blob=b64(os.urandom(10 * 1024 * 1024 + 1))))).status_code == 413
    # A malformed id reads as gone.
    assert (await client.get("/api/passwords/public/sends/not-a-uuid")).status_code == 404


async def test_send_posts_only_a_link(client, db):
    a = await setup_vault(client, await make_user(db))
    other = await make_user(db)
    body = _send()
    await client.post("/api/passwords/sends", headers=a.h, json=body)
    url = f"/api/passwords/sends/{body['id']}/via-rooms"
    key = "A" * 43
    # Anything that isn't a link to this Send can't go in, so no plain text gets through.
    for bad in ("the password is hunter2", f"https://x.example/passwords/send/{uuid.uuid4()}#{key}", f"https://x.example/passwords/send/{body['id']}#short"):
        assert (await client.post(url, headers=a.h, json={"link": bad, "user_id": str(other.id)})).status_code == 400

    from app.rooms.models import RoomMessage

    good = f"https://x.example/passwords/send/{body['id']}#{key}"
    assert (await client.post(url, headers=a.h, json={"link": good, "user_id": str(other.id)})).status_code == 204
    posted = (await db.execute(select(RoomMessage.body))).scalars().all()
    assert any(good in (m or "") for m in posted)


# ------------------------------------------------------------------ emergency access


async def _ready(client, db, wait=3):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    r = await client.post("/api/passwords/emergency", headers=a.h, json={"grantee_id": str(b.user.id), "wait_days": wait})
    assert r.status_code == 201, r.text
    eid = r.json()["id"]
    assert (await client.post(f"/api/passwords/emergency/{eid}/accept", headers=b.h)).status_code == 200
    wrap = {"grants": [{"vault_id": a.vault_id, "generation": 1, "wrapped_key": b64(os.urandom(94)), "signature": b64(os.urandom(64))}]}
    r = await client.put(f"/api/passwords/emergency/{eid}/wrap", headers=a.h, json=wrap)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "ready" and r.json()["wrapped"] == {a.vault_id: 1}
    return a, b, eid


async def test_emergency_waits_then_opens_view_only(client, db):
    from app.passwords.models import PwEmergency, PwVaultMember

    a, b, eid = await _ready(client, db)
    # Not before it's asked for, and not before the wait.
    assert (await client.post(f"/api/passwords/emergency/{eid}/open", headers=b.h)).status_code == 409
    r = await client.post(f"/api/passwords/emergency/{eid}/request", headers=b.h)
    assert r.status_code == 200 and r.json()["opens_at"]
    assert (await client.post(f"/api/passwords/emergency/{eid}/open", headers=b.h)).status_code == 403
    assert a.vault_id not in [v["id"] for v in (await client.get("/api/passwords/vaults", headers=b.h)).json()]

    row = await db.get(PwEmergency, uuid.UUID(eid))
    await db.refresh(row)
    row.requested_at = row.requested_at - timedelta(days=3, minutes=1)
    await db.commit()
    r = await client.post(f"/api/passwords/emergency/{eid}/open", headers=b.h)
    assert r.status_code == 200 and r.json()["state"] == "opened"

    # To them it's a shared vault they can only read, and not their own personal one.
    vaults = {v["id"]: v for v in (await client.get("/api/passwords/vaults", headers=b.h)).json()}
    assert vaults[a.vault_id]["role"] == "view" and vaults[a.vault_id]["kind"] == "shared"
    assert vaults[b.vault_id]["kind"] == "personal"
    r = await client.post(f"/api/passwords/vaults/{a.vault_id}/items", headers=b.h, json={"items": [{"id": str(uuid.uuid4()), "blob": b64(os.urandom(100))}]})
    assert r.status_code == 403

    # Reset of their own vault can't take the other person's with it.
    # Ending it takes them out.
    assert (await client.delete(f"/api/passwords/emergency/{eid}", headers=a.h)).status_code == 204
    left = (await db.execute(select(PwVaultMember).where(PwVaultMember.vault_id == uuid.UUID(a.vault_id), PwVaultMember.user_id == b.user.id))).scalar_one_or_none()
    assert left is None


async def test_emergency_refused_means_no_access(client, db):
    from app.passwords.models import PwEmergency

    a, b, eid = await _ready(client, db)
    await client.post(f"/api/passwords/emergency/{eid}/request", headers=b.h)
    # Only the grantor refuses, and only the grantee asks or opens.
    assert (await client.post(f"/api/passwords/emergency/{eid}/refuse", headers=b.h)).status_code == 403
    assert (await client.post(f"/api/passwords/emergency/{eid}/open", headers=a.h)).status_code == 403
    r = await client.post(f"/api/passwords/emergency/{eid}/refuse", headers=a.h)
    assert r.json()["state"] == "refused"
    # An old request time can't be used now.
    row = await db.get(PwEmergency, uuid.UUID(eid))
    await db.refresh(row)
    assert row.requested_at is None
    assert (await client.post(f"/api/passwords/emergency/{eid}/open", headers=b.h)).status_code == 409


async def test_emergency_is_invisible_to_others_and_needs_right_vaults(client, db):
    a, b, eid = await _ready(client, db)
    c = await setup_vault(client, await make_user(db))
    assert (await client.get("/api/passwords/emergency", headers=c.h)).json() == []
    for action in ("accept", "request", "refuse", "open"):
        assert (await client.post(f"/api/passwords/emergency/{eid}/{action}", headers=c.h)).status_code == 404
    assert (await client.delete(f"/api/passwords/emergency/{eid}", headers=c.h)).status_code == 404

    # You can only hand over keys to vaults you manage, at their current generation.
    other = await shared_vault(client, c)
    for vault_id, gen in ((other, 1), (a.vault_id, 99)):
        wrap = {"grants": [{"vault_id": vault_id, "generation": gen, "wrapped_key": b64(os.urandom(94)), "signature": b64(os.urandom(64))}]}
        assert (await client.put(f"/api/passwords/emergency/{eid}/wrap", headers=a.h, json=wrap)).status_code in (404, 409)
    # And not yourself.
    assert (await client.post("/api/passwords/emergency", headers=a.h, json={"grantee_id": str(a.user.id), "wait_days": 1})).status_code == 400
    assert (await client.post("/api/passwords/emergency", headers=a.h, json={"grantee_id": str(b.user.id), "wait_days": 1})).status_code == 409
    assert (await client.post("/api/passwords/emergency", headers=c.h, json={"grantee_id": str(b.user.id), "wait_days": 91})).status_code == 422


async def test_reset_keeps_a_vault_opened_through_emergency_access(client, db):
    from app.auth.utils import hash_password  # noqa: F401
    from app.passwords.models import PwEmergency, PwVault

    a, b, eid = await _ready(client, db)
    await client.post(f"/api/passwords/emergency/{eid}/request", headers=b.h)
    row = await db.get(PwEmergency, uuid.UUID(eid))
    await db.refresh(row)
    row.requested_at = row.requested_at - timedelta(days=4)
    await db.commit()
    await client.post(f"/api/passwords/emergency/{eid}/open", headers=b.h)
    # The rule a reset depends on: the grantee can't delete it or be treated as its owner.
    assert (await client.delete(f"/api/passwords/vaults/{a.vault_id}", headers=b.h)).status_code in (400, 403)
    vault = await db.get(PwVault, uuid.UUID(a.vault_id))
    assert vault is not None and vault.created_by == a.user.id
    # They can walk away from it, unlike from their own.
    assert (await client.post(f"/api/passwords/vaults/{a.vault_id}/leave", headers=b.h)).status_code == 204
    assert (await client.post(f"/api/passwords/vaults/{b.vault_id}/leave", headers=b.h)).status_code == 400


@pytest.mark.parametrize("wait", [0, 91])
async def test_emergency_wait_limits(client, db, wait):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    assert (await client.post("/api/passwords/emergency", headers=a.h, json={"grantee_id": str(b.user.id), "wait_days": wait})).status_code == 422


async def test_people_lists_others_and_needs_a_session(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await make_user(db)
    r = await client.get("/api/passwords/people", headers=a.h)
    ids = {p["id"]: p for p in r.json()}
    assert str(a.user.id) not in ids and ids[str(b.id)]["has_vault"] is False
    assert (await client.get("/api/passwords/people")).status_code in (401, 403)

async def test_alerts_are_bare_counts_for_a_locked_client(client, db):
    from tests.test_passwords import bearer, grant

    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    assert (await client.get("/api/passwords/alerts")).status_code in (401, 403)
    # Works with no vault session, because a locked app has none.
    empty = await client.get("/api/passwords/alerts", headers=bearer(b.user))
    assert empty.status_code == 200, empty.text
    assert empty.json() == {"device_requests": 0, "invitations": 0, "emergency": 0}
    vault = await shared_vault(client, a)
    r = await client.post(f"/api/passwords/vaults/{vault}/members", headers=a.h, json={"user_id": str(b.user.id), "role": "view", "grant": grant()})
    assert r.status_code == 204, r.text
    r = await client.post("/api/passwords/emergency", headers=a.h, json={"grantee_id": str(b.user.id), "wait_days": 2})
    assert r.status_code == 201
    got = (await client.get("/api/passwords/alerts", headers=bearer(b.user))).json()
    assert got == {"device_requests": 0, "invitations": 1, "emergency": 1}
    # Someone else's counts stay their own.
    assert (await client.get("/api/passwords/alerts", headers=bearer(a.user))).json()["invitations"] == 0
