"""Who can open a form (WP-F1.1): owner and edit grants edit, other grants
read, everyone else — strangers, disabled accounts, anyone once it's in the
trash — gets a 404 from every route, never a 403. A form is never served
or shared through a file link."""
from __future__ import annotations

import io
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

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

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def _png():
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (20, 20), "blue").save(buf, format="PNG")
    return buf.getvalue()


async def _routes(client, fid, who):
    """Every owner-side route, as ``who``: status codes."""
    h = _auth(who)
    out = {
        "get": (await client.get(f"/api/forms/{fid}", headers=h)).status_code,
        "save": (await client.put(f"/api/forms/{fid}/definition",
                                  json={"definition": {"title": "x", "items": []}, "data_version": 1},
                                  headers=h)).status_code,
        "settings": (await client.patch(f"/api/forms/{fid}/settings", json={"accepting": False},
                                        headers=h)).status_code,
        "asset": (await client.post(f"/api/forms/{fid}/assets", files={"file": ("a.png", _png(), "image/png")},
                                    headers=h)).status_code,
        "download": (await client.get(f"/api/files/{fid}/download", headers=h)).status_code,
        "office": (await client.get(f"/api/files/{fid}/office", headers=h)).status_code,
        "collab": (await client.post(f"/api/files/{fid}/collab-token", headers=h)).status_code,
    }
    return out


@pytest.mark.asyncio
async def test_access_matrix_is_404_only(client, db, user):
    from app.forms.access import form_access
    from app.files.models import UserFile

    r = await client.post("/api/files/office", json={"kind": "form", "form_template": "rsvp"}, headers=_auth(user))
    fid = r.json()["id"]
    editor = await _user(db, "ed")
    reader = await _user(db, "rd")
    stranger = await _user(db, "st")
    disabled = await _user(db, "dis")
    for who, can_edit in ((editor, True), (reader, False), (disabled, True)):
        r = await client.post(f"/api/files/file/{fid}/grants",
                              json={"grantee_user_id": str(who.id), "can_edit": can_edit}, headers=_auth(user))
        assert r.status_code in (200, 201), r.text
    # Forms have no comments, so no commenter role either.
    r = await client.post(f"/api/files/file/{fid}/grants",
                          json={"grantee_user_id": str(stranger.id), "can_comment": True}, headers=_auth(user))
    assert r.status_code == 400

    shell = await db.get(UserFile, uuid.UUID(fid))
    assert await form_access(db, shell, user) == "edit"
    assert await form_access(db, shell, editor) == "edit"
    assert await form_access(db, shell, reader) == "read"
    assert await form_access(db, shell, stranger) == "none"
    disabled.disabled = True
    await db.commit()
    assert await form_access(db, shell, disabled) == "none"

    # Reader: sees the form, can download it (answers are part of read), can't change it.
    r = await _routes(client, fid, reader)
    assert r["get"] == 200 and r["download"] == 200 and r["office"] == 200
    assert r["save"] == r["settings"] == r["asset"] == r["collab"] == 404
    body = (await client.get(f"/api/forms/{fid}", headers=_auth(reader))).json()
    assert body["access"] == "read" and body["is_owner"] is False

    # Stranger: nothing, and nothing says it exists.
    r = await _routes(client, fid, stranger)
    assert set(r.values()) == {404}, r
    missing = await _routes(client, uuid.uuid4(), stranger)
    assert set(missing.values()) == {404}

    # Editor: builds and changes settings.
    r = await client.put(f"/api/forms/{fid}/definition",
                         json={"definition": {"title": "Edited", "items": []}, "data_version": 1},
                         headers=_auth(editor))
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/forms/{fid}/settings", json={"allow_edit": False}, headers=_auth(editor))
    assert r.status_code == 200

    # In the trash: 404 for everyone, the owner included.
    await client.post(f"/api/files/{fid}/trash", headers=_auth(user))
    for who in (user, editor, reader):
        r = await _routes(client, fid, who)
        assert r["get"] == r["save"] == r["settings"] == r["asset"] == r["download"] == 404, r


@pytest.mark.asyncio
async def test_a_form_is_never_served_through_a_file_link(client, db, user):
    r = await client.post("/api/files/office", json={"kind": "form", "form_template": "rsvp"}, headers=_auth(user))
    fid = r.json()["id"]
    # No file link on a form: its answer link is made with Send.
    r = await client.post(f"/api/files/{fid}/share-links", json={"access_mode": "public"}, headers=_auth(user))
    assert r.status_code == 400 and "Send" in r.json()["detail"]
    # The Share dialog can still list (none).
    r = await client.get(f"/api/files/{fid}/share-links", headers=_auth(user))
    assert r.status_code == 200 and r.json()["links"] == []

    # A shared folder that holds a form neither lists nor serves it.
    r = await client.post("/api/files/folders", json={"scope": "mine", "name": "Party"}, headers=_auth(user))
    folder = r.json()["id"]
    await client.patch(f"/api/files/{fid}", json={"folder_id": folder}, headers=_auth(user))
    r = await client.post(f"/api/files/folders/{folder}/share-links", json={"access_mode": "public"},
                          headers=_auth(user))
    assert r.status_code == 201, r.text
    token = r.json()["token"]
    r = await client.get(f"/api/s/{token}/browse")
    assert r.status_code == 200 and all(f["id"] != fid for f in r.json()["files"])
    assert (await client.get(f"/api/s/{token}/file/{fid}/download")).status_code == 404
    assert (await client.get(f"/api/s/{token}/file/{fid}/office")).status_code == 404


@pytest.mark.asyncio
async def test_picture_links_die_with_the_form(client, db, user):
    r = await client.post("/api/files/office", json={"kind": "form"}, headers=_auth(user))
    fid = r.json()["id"]
    pic = (await client.post(f"/api/forms/{fid}/assets", files={"file": ("a.png", _png(), "image/png")},
                             headers=_auth(user))).json()
    assert (await client.get(pic["url"])).status_code == 200
    # A link for one form doesn't open another form's picture.
    other = (await client.post("/api/files/office", json={"kind": "form"}, headers=_auth(user))).json()["id"]
    assert (await client.get(pic["url"].replace(fid, other))).status_code == 404
    await client.post(f"/api/files/{fid}/trash", headers=_auth(user))
    assert (await client.get(pic["url"])).status_code == 404


def test_answer_state():
    """The one rule the answer link (WP-F1.3) goes by: unknown, revoked,
    expired, trashed and switched-off all look the same ("gone")."""
    from app.forms.access import answer_state

    now = datetime.now(timezone.utc)
    shell = SimpleNamespace(id=uuid.uuid4(), trashed_at=None, source_kind="form")
    form = SimpleNamespace(audience="server", accepting=True, close_at=None, max_responses=None, response_count=0)
    link = SimpleNamespace(resource_type="form", resource_id=shell.id, revoked_at=None, expires_at=None)
    someone = SimpleNamespace(disabled=False)

    def state(**kw):
        args = {"form": form, "shell": shell, "link": link, "user": someone, "link_answers_allowed": True, "now": now}
        args.update(kw)
        return answer_state(**args)

    assert state() == "open"
    assert state(user=None) == "sign_in"
    assert state(user=SimpleNamespace(disabled=True)) == "sign_in"
    assert state(link=None) == "gone"
    assert state(link=SimpleNamespace(**{**link.__dict__, "revoked_at": now})) == "gone"
    assert state(link=SimpleNamespace(**{**link.__dict__, "expires_at": now - timedelta(seconds=1)})) == "gone"
    assert state(link=SimpleNamespace(**{**link.__dict__, "resource_type": "file"})) == "gone"
    assert state(link=SimpleNamespace(**{**link.__dict__, "resource_id": uuid.uuid4()})) == "gone"
    assert state(shell=SimpleNamespace(**{**shell.__dict__, "trashed_at": now})) == "gone"
    # Closed: switched off, past its time, or full.
    assert state(form=SimpleNamespace(**{**form.__dict__, "accepting": False})) == "closed"
    assert state(form=SimpleNamespace(**{**form.__dict__, "close_at": now})) == "closed"
    assert state(form=SimpleNamespace(**{**form.__dict__, "max_responses": 3, "response_count": 3})) == "closed"
    assert state(form=SimpleNamespace(**{**form.__dict__, "max_responses": 3, "response_count": 2})) == "open"
    # Link forms: no account needed — unless the admin switched that off.
    link_form = SimpleNamespace(**{**form.__dict__, "audience": "link"})
    assert state(form=link_form, user=None) == "open"
    assert state(form=link_form, user=None, link_answers_allowed=False) == "gone"
