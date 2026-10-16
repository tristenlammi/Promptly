"""Office files are files (WP-3.2): sheet / whiteboard shells, one access
function, the unified collab token, the internal collab channel, quota."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from jose import jwt


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


@pytest.fixture
def drops(monkeypatch):
    from app import collab_internal

    calls = []

    async def fake_drop(user_id, *, room=None):
        calls.append(user_id)
        return 1

    monkeypatch.setattr(collab_internal, "drop_user", fake_drop)
    return calls


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


async def _workspace(client, owner, title="Home"):
    r = await client.post("/api/workspaces", json={"title": title}, headers=_auth(owner))
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _member(db, ws_id, owner, member, role="editor"):
    from app.chat.models import WorkspaceShare

    db.add(WorkspaceShare(workspace_id=uuid.UUID(ws_id), inviter_user_id=owner.id, invitee_user_id=member.id,
                          status="accepted", role=role, accepted_at=datetime.now(timezone.utc)))
    await db.commit()


async def _item(client, owner, ws_id, kind, title):
    r = await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": kind, "title": title}, headers=_auth(owner))
    assert r.status_code == 201, r.text
    return r.json()


async def _shell(db, item):
    from app.chat.models import Spreadsheet, WorkspaceCanvas
    from app.files.models import UserFile

    model = Spreadsheet if item["kind"] == "sheet" else WorkspaceCanvas
    entity = await db.get(model, uuid.UUID(item["ref_id"]), populate_existing=True)
    return entity, await db.get(UserFile, entity.file_id, populate_existing=True)


# ---------------------------------------------------------------- shells


@pytest.mark.asyncio
async def test_a_new_sheet_and_whiteboard_are_drive_files(client, db, user):
    from app.files.models import FileFolder

    ws_id = await _workspace(client, user)
    sheet = await _item(client, user, ws_id, "sheet", "Budget")
    board = await _item(client, user, ws_id, "canvas", "Floor plan")
    _s, shell = await _shell(db, sheet)
    assert shell.source_kind == "sheet" and shell.filename == "Budget.sheet"
    assert shell.user_id == user.id
    assert (await db.get(FileFolder, shell.folder_id)).name == "Sheets"
    _c, wshell = await _shell(db, board)
    assert wshell.source_kind == "whiteboard" and wshell.filename == "Floor plan.whiteboard"

    # Drive search finds the sheet itself (its text mirror stays hidden).
    r = (await client.get("/api/files/search?q=budget", headers=_auth(user))).json()
    assert [h["file"]["source_kind"] for h in r["hits"]] == ["sheet"]


@pytest.mark.asyncio
async def test_shells_follow_rename_trash_restore_and_purge(client, db, user):
    from app.files.models import UserFile

    ws_id = await _workspace(client, user)
    sheet = await _item(client, user, ws_id, "sheet", "Chores")
    r = await client.patch(f"/api/workspaces/{ws_id}/items/{sheet['id']}", json={"title": "Chore chart"},
                           headers=_auth(user))
    assert r.status_code == 200, r.text
    _s, shell = await _shell(db, sheet)
    assert shell.filename == "Chore chart.sheet"
    shell_id = shell.id

    r = await client.delete(f"/api/workspaces/{ws_id}/items/{sheet['id']}", headers=_auth(user))
    assert r.status_code in (200, 204), r.text
    assert (await db.get(UserFile, shell_id, populate_existing=True)).trashed_at is not None
    r = await client.post(f"/api/workspaces/{ws_id}/trash/{sheet['id']}/restore", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert (await db.get(UserFile, shell_id, populate_existing=True)).trashed_at is None

    # Gone for good → its shell goes too.
    await client.delete(f"/api/workspaces/{ws_id}/items/{sheet['id']}", headers=_auth(user))
    r = await client.delete(f"/api/workspaces/{ws_id}/trash/{sheet['id']}", headers=_auth(user))
    assert r.status_code in (200, 204), r.text
    assert await db.get(UserFile, shell_id, populate_existing=True) is None


@pytest.mark.asyncio
async def test_a_trashed_workspace_takes_its_shells_along(client, db, user):
    from app.files.models import UserFile

    ws_id = await _workspace(client, user)
    sheet = await _item(client, user, ws_id, "sheet", "Packing")
    _s, shell = await _shell(db, sheet)
    sid = shell.id
    await client.delete(f"/api/workspaces/{ws_id}", headers=_auth(user))
    assert (await db.get(UserFile, sid, populate_existing=True)).trashed_at is not None
    await client.post(f"/api/workspaces/{ws_id}/restore", headers=_auth(user))
    assert (await db.get(UserFile, sid, populate_existing=True)).trashed_at is None
    await client.delete(f"/api/workspaces/{ws_id}", headers=_auth(user))
    r = await client.delete(f"/api/workspaces/{ws_id}?permanent=true", headers=_auth(user))
    assert r.status_code in (200, 204), r.text
    assert await db.get(UserFile, sid, populate_existing=True) is None


# ---------------------------------------------------------------- access


@pytest.mark.asyncio
async def test_one_access_answer_for_grants_roles_and_drafts(client, db, user, drops):
    from app.config import get_settings
    from app.files.models import ResourceGrant

    ws_id = await _workspace(client, user)
    sheet = await _item(client, user, ws_id, "sheet", "Rota")
    _s, shell = await _shell(db, sheet)
    viewer, outsider, friend = await _user(db, "v"), await _user(db, "o"), await _user(db, "f")
    await _member(db, ws_id, user, viewer, role="viewer")

    def claims(r):
        return jwt.decode(r.json()["token"], get_settings().SECRET_KEY, algorithms=["HS256"])

    r = await client.post(f"/api/files/{shell.id}/collab-token", headers=_auth(user))
    assert r.status_code == 200 and r.json()["room"] == f"sheet:{sheet['ref_id']}"
    assert claims(r)["perm"] == "write"
    r = await client.post(f"/api/files/{shell.id}/collab-token", headers=_auth(viewer))
    assert claims(r)["perm"] == "read" and r.json()["can_edit"] is False
    r = await client.post(f"/api/files/{shell.id}/collab-token", headers=_auth(outsider))
    assert r.status_code == 404

    # A Drive grant opens it outside the workspace; editor grants work on sheets now.
    r = await client.post(f"/api/files/file/{shell.id}/grants", json={"grantee_user_id": str(friend.id), "can_edit": True},
                          headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    r = await client.post(f"/api/files/{shell.id}/collab-token", headers=_auth(friend))
    assert claims(r)["perm"] == "write"
    # The old workspace endpoint gives the same answer.
    r = await client.get(f"/api/workspaces/{ws_id}/spreadsheets/{sheet['ref_id']}/collab-token", headers=_auth(viewer))
    assert claims(r)["perm"] == "read"

    # Revoking cuts their sockets straight away.
    from sqlalchemy import select

    grant = (await db.execute(select(ResourceGrant).where(ResourceGrant.grantee_user_id == friend.id))).scalar_one()
    r = await client.delete(f"/api/files/file/{shell.id}/grants/{grant.id}", headers=_auth(user))
    assert r.status_code == 200
    import asyncio

    await asyncio.sleep(0.05)
    assert friend.id in drops


# ---------------------------------------------------------------- download / quota


@pytest.mark.asyncio
async def test_shells_download_as_office_formats(client, db, user):
    ws_id = await _workspace(client, user)
    sheet = await _item(client, user, ws_id, "sheet", "Invoice")
    board = await _item(client, user, ws_id, "canvas", "Mind map")
    _s, shell = await _shell(db, sheet)
    _c, wshell = await _shell(db, board)
    r = await client.get(f"/api/files/{shell.id}/download", headers=_auth(user))
    assert r.status_code == 200 and r.content[:2] == b"PK"
    assert "Invoice.xlsx" in r.headers["content-disposition"]
    r = await client.get(f"/api/files/{wshell.id}/download", headers=_auth(user))
    assert r.status_code == 200 and r.json()["type"] == "excalidraw"


@pytest.mark.asyncio
async def test_sheets_count_toward_quota_after_the_grace_period(client, db, user):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.files.quota import get_quota

    ws_id = await _workspace(client, user)
    sheet = await _item(client, user, ws_id, "sheet", "Big")
    r = await client.put(f"/api/workspaces/{ws_id}/spreadsheets/{sheet['ref_id']}",
                         json={"data": [{"name": "S", "celldata": [{"r": 0, "c": 0, "v": {"v": "x" * 500}}]}]},
                         headers=_auth(user))
    assert r.status_code == 200, r.text
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.office_quota_from = datetime.now(timezone.utc) + timedelta(days=30)
    await db.commit()
    before = await get_quota(db, user)
    assert before.office_pending_bytes > 500
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    row.office_quota_from = datetime.now(timezone.utc) - timedelta(days=1)
    await db.commit()
    after = await get_quota(db, user)
    assert after.office_pending_bytes == 0
    assert after.used_bytes == before.used_bytes + before.office_pending_bytes


# ---------------------------------------------------------------- internal channel


@pytest.mark.asyncio
async def test_the_snapshot_route_is_internal_and_not_keyed_by_secret_key(client, db, user):
    from app.collab_internal import internal_token
    from app.config import get_settings

    r = await client.post("/api/documents", json={"name": "Notes"}, headers=_auth(user))
    doc_id = r.json()["id"]
    old = await client.post(f"/api/documents/{doc_id}/snapshot", content=b"",
                            headers={"Authorization": f"Bearer {get_settings().SECRET_KEY}"})
    assert old.status_code in (404, 405)
    key = await client.post(f"/api/internal/documents/{doc_id}/snapshot", content=b"",
                            headers={"Authorization": f"Bearer {get_settings().SECRET_KEY}"})
    assert key.status_code == 403
    ok = await client.post(f"/api/internal/documents/{doc_id}/snapshot", content=b"",
                           headers={"Authorization": f"Bearer {internal_token()}"})
    assert ok.status_code == 204
    assert internal_token() != get_settings().SECRET_KEY
