"""The Forms home (WP-F1.2): ``GET /api/forms`` lists your forms and forms
shared with you with their counts; ``POST /api/forms`` makes a form in
the ``Forms`` folder; pictures can be copied in from your files; and a
rename in Files keeps the form's search text in step."""
from __future__ import annotations

import io
import uuid

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


async def _form(db, file_id):
    from sqlalchemy import select

    from app.forms.models import Form

    return (
        await db.execute(
            select(Form).where(Form.file_id == uuid.UUID(str(file_id))).execution_options(populate_existing=True)
        )
    ).scalar_one()


def _png(color="red"):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (30, 20), color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_new_form_goes_in_the_forms_folder(client, db, user):
    from app.files.models import FileFolder, UserFile

    r = await client.post("/api/forms", json={}, headers=_auth(user))
    assert r.status_code == 201, r.text
    first = r.json()["file"]
    assert first["filename"] == "Untitled form.form" and first["source_kind"] == "form"
    folder = await db.get(FileFolder, uuid.UUID(first["folder_id"]))
    assert folder.name == "Forms" and folder.system_kind == "forms" and folder.parent_id is None

    # From a built-in template, with a title: same folder (made once).
    r = await client.post("/api/forms", json={"template": "rsvp", "title": "BBQ on Saturday"}, headers=_auth(user))
    assert r.status_code == 201, r.text
    rsvp = r.json()["file"]
    assert rsvp["folder_id"] == first["folder_id"] and rsvp["filename"] == "BBQ on Saturday.form"
    form = await _form(db, rsvp["id"])
    assert form.definition["title"] == "BBQ on Saturday" and form.allow_edit is True

    # From a form you saved (any form you can read): its questions, not its answers.
    r = await client.post("/api/forms", json={"template_id": rsvp["id"]}, headers=_auth(user))
    assert r.status_code == 201, r.text
    copy = await _form(db, r.json()["file"]["id"])
    assert [i["id"] for i in copy.definition["items"]] == [i["id"] for i in form.definition["items"]]

    # Unknown templates, and someone else's form, are "not found".
    assert (await client.post("/api/forms", json={"template": "nope"}, headers=_auth(user))).status_code == 404
    other = await _user(db, "other")
    r = await client.post("/api/forms", json={"template_id": rsvp["id"]}, headers=_auth(other))
    assert r.status_code == 404
    # The system folder can't be renamed or trashed, but forms move out of it freely.
    r = await client.patch(f"/api/files/folders/{first['folder_id']}", json={"name": "Mine"}, headers=_auth(user))
    assert r.status_code == 400
    r = await client.patch(f"/api/files/{first['id']}", json={"move_to_root": True}, headers=_auth(user))
    assert r.status_code == 200 and r.json()["folder_id"] is None
    assert (await db.get(UserFile, uuid.UUID(first["id"]))) is not None


@pytest.mark.asyncio
async def test_home_lists_mine_and_shared_with_counts(client, db, user):
    from app.forms.models import FormNotify, FormResponse

    a = (await client.post("/api/forms", json={"template": "signup"}, headers=_auth(user))).json()["file"]
    # A form made in another folder (from Files) shows on the home too.
    r = await client.post("/api/files/folders", json={"scope": "mine", "name": "Club"}, headers=_auth(user))
    b = (
        await client.post(
            "/api/files/office", json={"kind": "form", "folder_id": r.json()["id"]}, headers=_auth(user)
        )
    ).json()
    trashed = (await client.post("/api/forms", json={}, headers=_auth(user))).json()["file"]
    assert (await client.delete(f"/api/files/{trashed['id']}", headers=_auth(user))).status_code == 204

    form = await _form(db, a["id"])
    for n in (1, 2, 3):
        db.add(FormResponse(form_id=form.id, number=n, source="server", answers={"name": f"P{n}"},
                            submit_id=uuid.uuid4()))
    form.response_count = 3
    form.next_number = 4
    await db.commit()

    r = await client.get("/api/forms", headers=_auth(user))
    assert r.status_code == 200, r.text
    rows = {f["file_id"]: f for f in r.json()["forms"]}
    assert set(rows) == {a["id"], b["id"]}
    card = rows[a["id"]]
    assert card["title"] == "Sign-up sheet" and card["accent"] == "green"
    assert card["response_count"] == 3 and card["new_count"] == 3 and card["state"] == "open"
    assert card["questions"] == 3 and card["owner"] is None

    # "New" counts answers since you last looked.
    from datetime import datetime, timezone

    db.add(FormNotify(form_id=form.id, user_id=user.id, seen_at=datetime.now(timezone.utc)))
    await db.commit()
    db.add(FormResponse(form_id=form.id, number=4, source="server", answers={"name": "P4"}, submit_id=uuid.uuid4()))
    form.response_count = 4
    await db.commit()
    rows = {f["file_id"]: f for f in (await client.get("/api/forms", headers=_auth(user))).json()["forms"]}
    assert rows[a["id"]]["new_count"] == 1 and rows[a["id"]]["response_count"] == 4

    # Closed shows as closed.
    r = await client.patch(f"/api/forms/{b['id']}/settings", json={"accepting": False}, headers=_auth(user))
    assert r.status_code == 200
    rows = {f["file_id"]: f for f in (await client.get("/api/forms", headers=_auth(user))).json()["forms"]}
    assert rows[b["id"]]["state"] == "closed"

    # Shared with me: a grant on the form, or on a folder above it.
    friend = await _user(db, "friend")
    assert (await client.get("/api/forms?scope=shared", headers=_auth(friend))).json()["forms"] == []
    r = await client.post(f"/api/files/file/{a['id']}/grants", json={"grantee_user_id": str(friend.id)},
                          headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    r = await client.post(f"/api/files/folder/{b['folder_id']}/grants", json={"grantee_user_id": str(friend.id)},
                          headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    shared = {f["file_id"]: f for f in (await client.get("/api/forms?scope=shared", headers=_auth(friend))).json()["forms"]}
    assert set(shared) == {a["id"], b["id"]}
    assert shared[a["id"]]["owner"] == user.username
    # Their own list doesn't have them, and the owner's shared list is empty.
    assert (await client.get("/api/forms", headers=_auth(friend))).json()["forms"] == []
    assert (await client.get("/api/forms?scope=shared", headers=_auth(user))).json()["forms"] == []


@pytest.mark.asyncio
async def test_picture_from_your_files_is_copied_in(client, db, user):
    from app.files.models import UserFile

    f = (await client.post("/api/forms", json={}, headers=_auth(user))).json()["file"]
    r = await client.post("/api/files/", files={"file": ("beach.png", _png("blue"), "image/png")},
                          data={"scope": "mine"}, headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    photo = r.json()
    photo_id = photo["id"]

    r = await client.post(f"/api/forms/{f['id']}/assets/from-file", json={"file_id": photo_id}, headers=_auth(user))
    assert r.status_code == 201, r.text
    asset = r.json()
    assert asset["id"] != photo_id
    row = await db.get(UserFile, uuid.UUID(asset["id"]))
    assert row.source_kind == "form_asset" and str(row.source_file_id) == f["id"]
    r = await client.get(asset["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    # It can be the header.
    form = await _form(db, f["id"])
    defn = dict(form.definition, theme={"accent": "teal", "header_asset_id": asset["id"]})
    r = await client.put(f"/api/forms/{f['id']}/definition", json={"definition": defn, "data_version": form.data_version},
                         headers=_auth(user))
    assert r.status_code == 200, r.text

    # Not a picture, or not yours: refused.
    r = await client.post("/api/files/", files={"file": ("notes.txt", b"hello", "text/plain")},
                          data={"scope": "mine"}, headers=_auth(user))
    body = r.json()
    txt = body["id"]
    r = await client.post(f"/api/forms/{f['id']}/assets/from-file", json={"file_id": txt}, headers=_auth(user))
    assert r.status_code == 400
    other = await _user(db, "other")
    g = (await client.post("/api/forms", json={}, headers=_auth(other))).json()["file"]
    r = await client.post(f"/api/forms/{g['id']}/assets/from-file", json={"file_id": photo_id}, headers=_auth(other))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_rename_in_files_updates_the_search_text(client, db, user):
    from app.files.models import UserFile

    f = (await client.post("/api/forms", json={"template": "rsvp"}, headers=_auth(user))).json()["file"]
    r = await client.patch(f"/api/files/{f['id']}", json={"filename": "Garden party"}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["filename"] == "Garden party.form"
    shell = await db.get(UserFile, uuid.UUID(f["id"]))
    await db.refresh(shell)
    assert shell.content_text.startswith("Garden party\n")
    assert "RSVP\n" not in shell.content_text
    form = await _form(db, f["id"])
    assert form.definition["title"] == "Garden party"
