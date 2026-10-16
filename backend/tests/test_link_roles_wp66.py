"""Comment / edit links (WP-6.6): "signed-in users with the link can
comment or edit". Opening one grants that role for as long as the link
lives; editing is never anonymous; a direct share isn't changed by a link."""
from __future__ import annotations

import io
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
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

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _office(client, owner, kind="document", title="Plan"):
    r = await client.post("/api/files/office", json={"kind": kind, "title": title}, headers=_auth(owner))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _link(client, owner, fid, role, mode="invite"):
    return await client.post(f"/api/files/{fid}/share-links", json={"access_mode": mode, "role": role},
                             headers=_auth(owner))


async def _open(client, who, token):
    r = await client.get(f"/api/s/{token}/meta", headers=_auth(who) if who else {})
    assert r.status_code == 200, r.text
    return r.json()


async def _access(db, fid, who):
    from app.files.models import UserFile
    from app.files.office import get_office_access

    row = await db.get(UserFile, uuid.UUID(fid), populate_existing=True)
    return await get_office_access(db, row, who)


ANCHOR = {"from": "AQIDBA==", "to": "BQYHCA=="}


@pytest.mark.asyncio
async def test_a_comment_link_lets_signed_in_people_comment_but_not_edit(client, db, user):
    bob = await _user(db, "bob")
    fid = await _office(client, user)
    r = await _link(client, user, fid, "comment")
    assert r.status_code == 201, r.text
    link = r.json()
    assert (link["role"], link["access_mode"]) == ("comment", "invite")

    # Anonymous: nothing — not even what the link is to.
    anon = await _open(client, None, link["token"])
    assert anon["requires_auth"] is True and anon.get("open_path") is None and anon.get("filename") is None

    # Bob, signed in: sent to the editor, as a commenter.
    meta = await _open(client, bob, link["token"])
    assert meta["role"] == "comment" and meta["open_path"] == f"/files/doc/{fid}"
    assert await _access(db, fid, bob) == "comment"
    tok = (await client.get(f"/api/documents/{fid}/collab-token", headers=_auth(bob))).json()
    assert tok["can_edit"] is False
    listed = (await client.get(f"/api/documents/{fid}/comments", headers=_auth(bob))).json()
    assert listed["can_comment"] is True
    r = await client.post(f"/api/documents/{fid}/comments", json={"body": "Looks good", "anchor": ANCHOR},
                          headers=_auth(bob))
    assert r.status_code == 201, r.text
    r = await client.post(f"/api/documents/{fid}/comments/{r.json()['id']}/resolve", json={"resolved": True},
                          headers=_auth(bob))
    assert r.status_code == 200, r.text

    # The owner sees him on the list, marked as joined through the link.
    grants = (await client.get(f"/api/files/file/{fid}/grants", headers=_auth(user))).json()["grants"]
    assert [(g["username"], g["can_comment"], g["can_edit"], g["via_link"]) for g in grants] == [
        (bob.username, True, False, True)
    ]


@pytest.mark.asyncio
async def test_an_edit_link_lets_people_edit_until_it_is_revoked(client, db, user):
    carol = await _user(db, "carol")
    fid = await _office(client, user, kind="sheet", title="Budget")
    link = (await _link(client, user, fid, "edit")).json()
    meta = await _open(client, carol, link["token"])
    assert meta["open_path"] == f"/files/sheet/{fid}"
    assert await _access(db, fid, carol) == "edit"
    tok = (await client.post(f"/api/files/{fid}/collab-token", headers=_auth(carol))).json()
    assert tok["can_edit"] is True

    # Revoked: the access goes with it.
    assert (await client.delete(f"/api/files/share-links/{link['id']}", headers=_auth(user))).status_code == 204
    assert await _access(db, fid, carol) == "none"
    assert (await client.post(f"/api/files/{fid}/collab-token", headers=_auth(carol))).status_code == 404


@pytest.mark.asyncio
async def test_an_expired_link_stops_counting_at_once(client, db, user):
    from app.files.access import can_read
    from app.files.link_roles import purge_dead_link_grants
    from app.files.models import FileShareLink, ResourceGrant

    dan = await _user(db, "dan")
    fid = await _office(client, user, kind="whiteboard", title="Ideas")
    link = (await _link(client, user, fid, "comment")).json()
    await _open(client, dan, link["token"])
    assert await can_read(db, uuid.UUID(fid), dan.id)

    row = await db.get(FileShareLink, uuid.UUID(link["id"]))
    row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db.commit()
    assert not await can_read(db, uuid.UUID(fid), dan.id)
    assert await _access(db, fid, dan) == "none"
    # …and the nightly pass tidies the grant away.
    assert await purge_dead_link_grants(db) == 1
    await db.commit()
    assert (await db.execute(
        ResourceGrant.__table__.select().where(ResourceGrant.grantee_user_id == dan.id)
    )).first() is None


@pytest.mark.asyncio
async def test_editing_is_never_anonymous_and_roles_fit_the_file(client, db, user):
    fid = await _office(client, user)
    r = await _link(client, user, fid, "edit", mode="public")
    assert r.status_code == 400 and "sign in" in r.json()["detail"]
    assert (await _link(client, user, fid, "view", mode="public")).status_code == 201

    # A plain upload: view only. A PDF: edit, not comment. A folder: view.
    up = await client.post("/api/files/", files={"file": ("a.txt", b"hello", "text/plain")}, data={"scope": "mine"},
                           headers=_auth(user))
    assert (await _link(client, user, up.json()["id"], "comment")).status_code == 400
    pdf = await client.post("/api/files/", files={"file": ("f.pdf", _pdf(), "application/pdf")},
                            data={"scope": "mine"}, headers=_auth(user))
    assert (await _link(client, user, pdf.json()["id"], "comment")).status_code == 400
    assert (await _link(client, user, pdf.json()["id"], "edit")).status_code == 201
    folder = await client.post("/api/files/folders", json={"name": "Shared", "scope": "mine"}, headers=_auth(user))
    r = await client.post(f"/api/files/folders/{folder.json()['id']}/share-links",
                          json={"access_mode": "invite", "role": "comment"}, headers=_auth(user))
    assert r.status_code == 400


def _pdf() -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(72, 720, "x")
    c.showPage()
    c.save()
    return buf.getvalue()


@pytest.mark.asyncio
async def test_a_pdf_edit_link_lets_people_save_it(client, db, user):
    eve = await _user(db, "eve")
    up = await client.post("/api/files/", files={"file": ("form.pdf", _pdf(), "application/pdf")},
                           data={"scope": "mine"}, headers=_auth(user))
    fid = up.json()["id"]
    link = (await _link(client, user, fid, "edit")).json()
    meta = await _open(client, eve, link["token"])
    assert meta["open_path"] == f"/files/f/{fid}"
    info = (await client.get(f"/api/files/{fid}/pdf", headers=_auth(eve))).json()
    assert info["can_edit"] is True


@pytest.mark.asyncio
async def test_a_direct_share_is_not_changed_by_a_link(client, db, user):
    from app.files.models import ResourceGrant

    frank = await _user(db, "frank")
    fid = await _office(client, user)
    r = await client.post(f"/api/files/file/{fid}/grants", json={"grantee_user_id": str(frank.id)},
                          headers=_auth(user))
    assert r.status_code == 201
    link = (await _link(client, user, fid, "edit")).json()
    await _open(client, frank, link["token"])
    assert await _access(db, fid, frank) == "read"
    # Revoking the link leaves the direct share alone.
    await client.delete(f"/api/files/share-links/{link['id']}", headers=_auth(user))
    assert await _access(db, fid, frank) == "read"
    grant = (await db.execute(
        ResourceGrant.__table__.select().where(ResourceGrant.grantee_user_id == frank.id)
    )).first()
    assert grant is not None and grant.via_link_id is None


@pytest.mark.asyncio
async def test_sharing_directly_with_a_link_joiner_makes_it_theirs(client, db, user):
    gil = await _user(db, "gil")
    fid = await _office(client, user)
    link = (await _link(client, user, fid, "comment")).json()
    await _open(client, gil, link["token"])
    r = await client.post(f"/api/files/file/{fid}/grants",
                          json={"grantee_user_id": str(gil.id), "can_edit": True}, headers=_auth(user))
    assert r.status_code == 201, r.text
    [g] = r.json()["grants"]
    assert (g["can_edit"], g["via_link"]) == (True, False)
    # Revoking the link no longer takes it away.
    await client.delete(f"/api/files/share-links/{link['id']}", headers=_auth(user))
    assert await _access(db, fid, gil) == "edit"


@pytest.mark.asyncio
async def test_commenter_is_a_role_for_people_too(client, db, user):
    hal = await _user(db, "hal")
    fid = await _office(client, user)
    r = await client.post(f"/api/files/file/{fid}/grants",
                          json={"grantee_user_id": str(hal.id), "can_comment": True}, headers=_auth(user))
    assert r.status_code == 201, r.text
    assert await _access(db, fid, hal) == "comment"
    grant_id = r.json()["grants"][0]["grant_id"]
    r = await client.patch(f"/api/files/file/{fid}/grants/{grant_id}",
                           json={"can_copy": False, "can_comment": False}, headers=_auth(user))
    assert r.status_code == 200
    assert await _access(db, fid, hal) == "read"
    # Not on a file without comments.
    up = await client.post("/api/files/", files={"file": ("f.pdf", _pdf(), "application/pdf")},
                           data={"scope": "mine"}, headers=_auth(user))
    r = await client.post(f"/api/files/file/{up.json()['id']}/grants",
                          json={"grantee_user_id": str(hal.id), "can_comment": True}, headers=_auth(user))
    assert r.status_code == 400
