"""Personal office files (WP-3.4): create from Files, templates, the
file-scoped sheet routes, Recent from activity, copies that stay
editable, grant notifications, share-link views, rename and purge."""
from __future__ import annotations

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


def _book(*values):
    return [{"name": "Sheet1", "celldata": [{"r": i, "c": 0, "v": {"v": v}} for i, v in enumerate(values)]}]


async def _new(client, user, kind, **extra):
    r = await client.post("/api/files/office", json={"kind": kind, **extra}, headers=_auth(user))
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------- create + open


@pytest.mark.asyncio
async def test_new_personal_sheet_opens_saves_and_exports(client, db, user):
    f = await _new(client, user, "sheet", title="Groceries")
    assert f["filename"] == "Groceries.sheet"
    info = (await client.get(f"/api/files/{f['id']}/office", headers=_auth(user))).json()
    assert info["kind"] == "sheet" and info["access"] == "edit" and info["workspace_id"] is None
    assert info["content_id"] and info["file"]["id"] == f["id"]

    url = f"/api/files/{f['id']}/sheet"
    v0 = (await client.get(url, headers=_auth(user))).json()["data_version"]
    r = await client.put(url, json={"data": _book("milk", "eggs"), "content_text": "milk eggs",
                                    "data_version": v0}, headers=_auth(user))
    assert r.status_code == 200, r.text
    stale = await client.put(url, json={"data": _book("x"), "data_version": v0}, headers=_auth(user))
    assert stale.status_code == 409
    r = await client.get(f"{url}/export?format=csv", headers=_auth(user))
    assert r.status_code == 200 and b"milk" in r.content
    # Drive search finds it by its cells.
    r = await client.get("/api/files/search?q=eggs", headers=_auth(user))
    assert any(h["file"]["id"] == f["id"] for h in r.json()["hits"])


@pytest.mark.asyncio
async def test_new_document_and_whiteboard(client, db, user):
    doc = await _new(client, user, "document", title="Notes")
    assert doc["filename"] == "Notes.html"
    wb = await _new(client, user, "whiteboard")
    assert wb["filename"] == "Untitled whiteboard.whiteboard"
    info = (await client.get(f"/api/files/{wb['id']}/office", headers=_auth(user))).json()
    # The canvas endpoints answer for a personal whiteboard too.
    r = await client.get(f"/api/canvas/{info['content_id']}", headers=_auth(user))
    assert r.status_code == 200 and r.json()["workspace_id"] is None and r.json()["can_edit"]
    r = await client.get(f"/api/canvas/{info['content_id']}/collab-token", headers=_auth(user))
    assert r.status_code == 200 and r.json()["can_edit"]


@pytest.mark.asyncio
async def test_new_office_file_refuses_a_workspace_folder(client, db, user):
    from app.chat.models import Workspace

    r = await client.post("/api/workspaces", json={"title": "Home"}, headers=_auth(user))
    ws = await db.get(Workspace, uuid.UUID(r.json()["id"]), populate_existing=True)
    r = await client.post("/api/files/office", json={"kind": "sheet", "folder_id": str(ws.root_folder_id)},
                          headers=_auth(user))
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_a_stranger_cant_open_or_save(client, db, user):
    f = await _new(client, user, "sheet")
    other = await _user(db, "o")
    assert (await client.get(f"/api/files/{f['id']}/office", headers=_auth(other))).status_code == 404
    r = await client.put(f"/api/files/{f['id']}/sheet", json={"data": _book("x")}, headers=_auth(other))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_new_from_files_lands_in_the_folder_with_default_names(client, db, user):
    """Files → New: every kind lands in the folder you're in, named so it
    can be renamed later; a Note is a Document that starts "Untitled note"."""
    r = await client.post("/api/files/folders", json={"scope": "mine", "name": "Plans"}, headers=_auth(user))
    assert r.status_code == 201, r.text
    folder_id = r.json()["id"]
    expected = {
        "document": ("document", "Untitled document"),
        "note": ("document", "Untitled note"),
        "sheet": ("sheet", "Untitled spreadsheet"),
        "whiteboard": ("whiteboard", "Untitled whiteboard"),
    }
    for kind, (source_kind, title) in expected.items():
        f = await _new(client, user, kind, folder_id=folder_id)
        assert f["source_kind"] == source_kind, kind
        assert f["folder_id"] == folder_id, kind
        assert f["filename"].startswith(title), (kind, f["filename"])
        info = (await client.get(f"/api/files/{f['id']}/office", headers=_auth(user))).json()
        assert info["kind"] == source_kind and info["access"] == "edit"
    r = await client.get(f"/api/files/browse?scope=mine&folder_id={folder_id}", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert len(r.json()["files"]) == 4


@pytest.mark.asyncio
async def test_new_rejects_an_unknown_kind(client, user):
    r = await client.post("/api/files/office", json={"kind": "spaceship"}, headers=_auth(user))
    assert r.status_code == 422


# ---------------------------------------------------------------- templates


@pytest.mark.asyncio
async def test_templates_seed_once_and_copy(client, db, user):
    r = await client.get("/api/files/templates", headers=_auth(user))
    assert r.status_code == 200
    templates = r.json()["templates"]
    kinds = {t["kind"] for t in templates}
    assert kinds == {"document", "sheet", "whiteboard"}
    assert {"Budget", "Invoice", "Mind map", "Meeting agenda"} <= {t["title"] for t in templates}
    # Deleting one doesn't bring it back.
    budget = next(t for t in templates if t["title"] == "Budget")
    assert (await client.delete(f"/api/files/{budget['id']}", headers=_auth(user))).status_code == 204
    again = (await client.get("/api/files/templates", headers=_auth(user))).json()["templates"]
    assert len(again) == len(templates) - 1

    invoice = next(t for t in templates if t["title"] == "Invoice")
    f = await _new(client, user, None, template_id=invoice["id"])
    assert f["filename"] == "Invoice.sheet"
    data = (await client.get(f"/api/files/{f['id']}/sheet", headers=_auth(user))).json()["data"]
    values = [c["v"].get("v") for c in data[0]["celldata"]]
    assert "INVOICE" in values and "[date]" not in values  # the date is filled in
    total = next(c for c in data[0]["celldata"] if c["r"] == 11 and c["c"] == 3)
    assert total["v"]["f"] == "=D10+D11" and total["v"]["v"] == 110  # totals are calculated

    mind = next(t for t in templates if t["title"] == "Mind map")
    wb = await _new(client, user, None, template_id=mind["id"], title="Trip ideas")
    assert wb["filename"] == "Trip ideas.whiteboard"
    from app.chat.models import WorkspaceCanvas
    from app.workspaces.export_router import canvas_scene_json
    from sqlalchemy import select

    canvas = (
        await db.execute(select(WorkspaceCanvas).where(WorkspaceCanvas.file_id == uuid.UUID(wb["id"])))
    ).scalar_one()
    import json

    scene = json.loads(canvas_scene_json(canvas.yjs_update))
    assert any(e.get("text") == "Main idea" for e in scene["elements"])


@pytest.mark.asyncio
async def test_save_as_template(client, db, user):
    f = await _new(client, user, "sheet", title="Weekly meals")
    await client.put(f"/api/files/{f['id']}/sheet", json={"data": _book("pasta")}, headers=_auth(user))
    r = await client.post(f"/api/files/{f['id']}/save-as-template", headers=_auth(user))
    assert r.status_code == 201
    titles = [t["title"] for t in (await client.get("/api/files/templates", headers=_auth(user))).json()["templates"]]
    assert "Weekly meals" in titles


# ---------------------------------------------------------------- sharing


@pytest.mark.asyncio
async def test_grant_notifies_and_shared_sheet_is_editable_and_in_recent(client, db, user, monkeypatch):
    from app.notifications import dispatch

    sent = []

    async def fake(**kw):
        sent.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", fake)
    f = await _new(client, user, "sheet", title="Rota")
    other = await _user(db, "g")
    r = await client.post(f"/api/files/file/{f['id']}/grants",
                          json={"grantee_user_id": str(other.id), "can_edit": True, "can_copy": True},
                          headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    assert sent and sent[0]["user_id"] == other.id and "Rota" in sent[0]["title"]
    assert sent[0]["url"] == f"/files/sheet/{f['id']}"

    info = (await client.get(f"/api/files/{f['id']}/office", headers=_auth(other))).json()
    assert info["access"] == "edit" and info["is_owner"] is False
    r = await client.put(f"/api/files/{f['id']}/sheet", json={"data": _book("me")}, headers=_auth(other))
    assert r.status_code == 200
    recent = (await client.get("/api/files/recent", headers=_auth(other))).json()["files"]
    assert recent and recent[0]["id"] == f["id"]

    # "Make a copy" keeps it a sheet, with the workbook.
    r = await client.post(f"/api/files/files/{f['id']}/copy-to-mine", headers=_auth(other))
    assert r.status_code == 201, r.text
    copy = r.json()["file"]
    assert copy["filename"] == "Rota (copy).sheet"
    data = (await client.get(f"/api/files/{copy['id']}/sheet", headers=_auth(other))).json()["data"]
    assert data[0]["celldata"][0]["v"]["v"] == "me"

    # Revoked → gone from their Recent.
    grants = (await client.get(f"/api/files/file/{f['id']}/grants", headers=_auth(user))).json()
    gid = grants["grants"][0]["grant_id"]
    await client.delete(f"/api/files/file/{f['id']}/grants/{gid}", headers=_auth(user))
    recent = (await client.get("/api/files/recent", headers=_auth(other))).json()["files"]
    assert all(x["id"] != f["id"] for x in recent)


@pytest.mark.asyncio
async def test_share_link_shows_a_sheet_and_downloads_xlsx(client, db, user):
    f = await _new(client, user, "sheet", title="Scores")
    await client.put(f"/api/files/{f['id']}/sheet", json={"data": _book("10", "20")}, headers=_auth(user))
    r = await client.post(f"/api/files/{f['id']}/share-links", json={}, headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    token = r.json()["token"]
    view = await client.get(f"/api/s/{token}/office")
    assert view.status_code == 200 and view.json()["kind"] == "sheet"
    assert view.json()["data"][0]["celldata"][1]["v"]["v"] == "20"
    dl = await client.get(f"/api/s/{token}/download")
    assert dl.status_code == 200 and dl.content[:2] == b"PK"  # an .xlsx


# ---------------------------------------------------------------- rename, thumbnail, purge


@pytest.mark.asyncio
async def test_rename_follows_and_purge_removes_content(client, db, user):
    from sqlalchemy import select

    from app.chat.models import Spreadsheet

    f = await _new(client, user, "sheet", title="Old")
    r = await client.patch(f"/api/files/{f['id']}", json={"filename": "New name"}, headers=_auth(user))
    assert r.status_code == 200 and r.json()["filename"] == "New name.sheet"
    sheet = (
        await db.execute(
            select(Spreadsheet).where(Spreadsheet.file_id == uuid.UUID(f["id"])).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert sheet.title == "New name"

    await client.delete(f"/api/files/{f['id']}", headers=_auth(user))
    r = await client.post("/api/files/bulk/purge", json={"file_ids": [f["id"]]}, headers=_auth(user))
    assert r.status_code in (200, 204), r.text
    gone = (
        await db.execute(select(Spreadsheet).where(Spreadsheet.file_id == uuid.UUID(f["id"])))
    ).scalar_one_or_none()
    assert gone is None


@pytest.mark.asyncio
async def test_whiteboard_thumbnail_push(client, db, user):
    import io

    from PIL import Image

    wb = await _new(client, user, "whiteboard")
    r = await client.get(f"/api/files/{wb['id']}/thumbnail", headers=_auth(user))
    assert r.status_code == 415  # nothing pushed yet
    buf = io.BytesIO()
    Image.new("RGB", (800, 500), "white").save(buf, format="PNG")
    r = await client.put(f"/api/files/{wb['id']}/thumbnail", files={"file": ("t.png", buf.getvalue(), "image/png")},
                         headers=_auth(user))
    assert r.status_code == 204, r.text
    r = await client.get(f"/api/files/{wb['id']}/thumbnail", headers=_auth(user))
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(r.content)).width == 320
    bad = await client.put(f"/api/files/{wb['id']}/thumbnail", files={"file": ("t.png", b"nope", "image/png")},
                           headers=_auth(user))
    assert bad.status_code == 422
