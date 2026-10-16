"""The Files shell (WP-3.5): Shared with me / by me, workspaces as drives,
the details pane, the storage meter, and asking about shared files."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

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


async def _sheet(client, user, title, cells=("a",)):
    r = await client.post("/api/files/office", json={"kind": "sheet", "title": title}, headers=_auth(user))
    assert r.status_code == 201, r.text
    f = r.json()
    data = [{"name": "Sheet1", "celldata": [{"r": i, "c": 0, "v": {"v": v}} for i, v in enumerate(cells)]}]
    await client.put(f"/api/files/{f['id']}/sheet", json={"data": data, "content_text": " ".join(cells)},
                     headers=_auth(user))
    return f


async def _grant(client, owner, file_id, grantee):
    r = await client.post(f"/api/files/file/{file_id}/grants", json={"grantee_user_id": str(grantee.id)},
                          headers=_auth(owner))
    assert r.status_code == 201, r.text


def _names(resp):
    return {f["filename"] for f in resp.json()["files"]}


# ---------------------------------------------------------------- shared views


@pytest.mark.asyncio
async def test_shared_splits_with_me_and_by_me(client, db, user, monkeypatch):
    from app.notifications import dispatch

    async def quiet(**_kw):
        return None

    monkeypatch.setattr(dispatch, "notify_user", quiet)
    other = await _user(db, "o")
    mine = await _sheet(client, user, "Mine shared")
    theirs = await _sheet(client, other, "Theirs")
    linked = await _sheet(client, user, "Only a link")
    await _grant(client, user, mine["id"], other)
    await _grant(client, other, theirs["id"], user)
    r = await client.post(f"/api/files/{linked['id']}/share-links", json={}, headers=_auth(user))
    assert r.status_code == 201

    url = "/api/files/browse?scope=shared"
    assert _names(await client.get(f"{url}&shared=with_me", headers=_auth(user))) == {"Theirs.sheet"}
    assert _names(await client.get(f"{url}&shared=by_me", headers=_auth(user))) == {
        "Mine shared.sheet", "Only a link.sheet"
    }
    # The default stays "everything", as before.
    assert {"Theirs.sheet", "Mine shared.sheet"} <= _names(await client.get(url, headers=_auth(user)))


# ---------------------------------------------------------------- ask about shared files


@pytest.mark.asyncio
async def test_a_shared_sheet_can_be_attached_and_reads_as_text(client, db, user, monkeypatch):
    from fastapi import HTTPException

    from app.files.models import UserFile
    from app.files.prompt import build_attachment_preamble
    from app.files.router import resolve_attachments
    from app.notifications import dispatch

    async def quiet(**_kw):
        return None

    monkeypatch.setattr(dispatch, "notify_user", quiet)
    other = await _user(db, "o")
    f = await _sheet(client, other, "Invoices", cells=("total", "1234"))
    stranger = await _user(db, "s")
    await _grant(client, other, f["id"], user)

    rows = await resolve_attachments(db, [uuid.UUID(f["id"])], user)
    row = await db.get(UserFile, rows[0].id, populate_existing=True)
    assert "1234" in build_attachment_preamble([row])
    with pytest.raises(HTTPException):
        await resolve_attachments(db, [uuid.UUID(f["id"])], stranger)


# ---------------------------------------------------------------- workspace drives


@pytest.mark.asyncio
async def test_workspace_drive_lists_items_and_hides_private_drafts(client, db, user):
    from app.chat.models import WorkspaceFile, WorkspaceItem

    r = await client.post("/api/workspaces", json={"title": "Family"}, headers=_auth(user))
    ws_id = r.json()["id"]
    made = {}
    for kind, title in (("note", "Plans"), ("sheet", "Budget"), ("canvas", "Garden")):
        r = await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": kind, "title": title},
                              headers=_auth(user))
        assert r.status_code == 201, r.text
        made[kind] = r.json()
    other_doc = await client.post("/api/files/office", json={"kind": "document", "title": "Pinned doc"},
                                  headers=_auth(user))
    db.add(WorkspaceFile(workspace_id=uuid.UUID(ws_id), file_id=uuid.UUID(other_doc.json()["id"])))
    await db.commit()

    listing = await client.get(f"/api/files/workspaces/{ws_id}", headers=_auth(user))
    assert listing.status_code == 200, listing.text
    kinds = {e["item_kind"] for e in listing.json()["entries"]}
    assert kinds == {"note", "sheet", "canvas", "pinned"}

    # Someone else's private draft isn't listed; a trashed item isn't either.
    someone = await _user(db, "m")
    item = await db.get(WorkspaceItem, uuid.UUID(made["sheet"]["id"]))
    item.visibility = "private"
    item.created_by = someone.id
    canvas = await db.get(WorkspaceItem, uuid.UUID(made["canvas"]["id"]))
    canvas.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    kinds = {e["item_kind"] for e in (await client.get(f"/api/files/workspaces/{ws_id}", headers=_auth(user))).json()["entries"]}
    assert kinds == {"note", "pinned"}

    stranger = await _user(db, "s")
    assert (await client.get(f"/api/files/workspaces/{ws_id}", headers=_auth(stranger))).status_code == 404


# ---------------------------------------------------------------- details + storage


@pytest.mark.asyncio
async def test_details_and_storage_breakdown(client, db, user):
    from app.backups.models import BackupRun

    r = await client.post("/api/files/folders", json={"scope": "mine", "name": "Taxes", "parent_id": None},
                          headers=_auth(user))
    folder_id = r.json()["id"]
    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "2026", "folder_id": folder_id},
                          headers=_auth(user))
    f = r.json()
    d = (await client.get(f"/api/files/{f['id']}/details", headers=_auth(user))).json()
    assert d["is_owner"] and d["location"] == "My files / Taxes" and d["owner_name"] == user.username
    stranger = await _user(db, "s")
    assert (await client.get(f"/api/files/{f['id']}/details", headers=_auth(stranger))).status_code == 404

    trashed = await _sheet(client, user, "Old", cells=("x" * 500,))
    await client.delete(f"/api/files/{trashed['id']}", headers=_auth(user))
    db.add(BackupRun(kind="nightly", status="ok", finished_at=datetime.now(timezone.utc)))
    await db.commit()
    s = (await client.get("/api/files/storage", headers=_auth(user))).json()
    assert s["trash_bytes"] > 0
    assert s["files_bytes"] + s["trash_bytes"] == s["used_bytes"]
    assert s["last_backup_at"] is not None
