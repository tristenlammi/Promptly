"""One upload path (WP-7.6, Part C §2.3): uploading into a workspace's
drive is Drive's upload (``POST /api/files/`` with ``workspace_id``) —
staged, sniffed, quota-locked and audited — with the workspace's rules on
top: editors only, the owner's storage, the workspace's own cap, and the
file pinned and indexed for the workspace."""
from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import select


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture
def indexed(monkeypatch):
    from app.tasks import queue
    from app.workspaces import drive_router

    seen: list = []

    async def index(ws_id, file_id):
        seen.append((ws_id, file_id))

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(drive_router, "index_file_for_workspace", index)
    monkeypatch.setattr(queue, "enqueue_media", nothing)
    return seen


@pytest.fixture
async def client(db, root, indexed):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _person(db, name):
    from app.auth.models import User

    row = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
               password_hash="x", role="user")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def _workspace(db, owner, members: dict):
    from app.chat.models import Workspace, WorkspaceShare

    ws = Workspace(user_id=owner.id, title="Family")
    db.add(ws)
    await db.flush()
    for member, role in members.items():
        db.add(WorkspaceShare(workspace_id=ws.id, inviter_user_id=owner.id, invitee_user_id=member.id, status="accepted", role=role))
    await db.commit()
    return ws


async def _upload(client, user, ws_id, name="notes.txt", data=b"hello workspace", folder=None):
    form = {"scope": "mine", "workspace_id": str(ws_id)}
    if folder:
        form["folder_id"] = folder
    return await client.post("/api/files/", files={"file": (name, data, "text/plain")}, data=form, headers=_auth(user))


@pytest.mark.asyncio
async def test_an_editor_uploads_into_the_workspace_drive_through_drive_upload(client, db, user, indexed):
    from app.chat.models import WorkspaceFile
    from app.files.models import UserFile

    editor = await _person(db, "editor")
    ws = await _workspace(db, user, {editor: "editor"})
    r = await _upload(client, editor, ws.id)
    assert r.status_code == 201, r.text
    fid = uuid.UUID(r.json()["id"])

    row = await db.get(UserFile, fid, populate_existing=True)
    assert row.user_id == user.id  # the owner's bytes, whoever uploads
    assert row.content_sha256  # staged + hashed like any upload (WP-7.1)
    pin = (await db.execute(select(WorkspaceFile).where(WorkspaceFile.file_id == fid))).scalar_one()
    assert pin.workspace_id == ws.id and pin.pinned_by == editor.id
    assert indexed == [(ws.id, fid)]

    # It's in the drive listing, in the workspace's Files folder.
    drive = (await client.get(f"/api/workspaces/{ws.id}/drive", headers=_auth(editor))).json()
    assert [f["file_id"] for f in drive["files"]] == [str(fid)]
    assert row.folder_id == uuid.UUID(drive["root_folder_id"])

    # The older route is the same upload underneath.
    old = await client.post(
        f"/api/workspaces/{ws.id}/drive/files",
        files={"file": ("more.txt", b"more", "text/plain")},
        headers=_auth(editor),
    )
    assert old.status_code == 201, old.text
    assert old.json()["filename"] == "more.txt" and old.json()["owner"]["username"] == editor.username


@pytest.mark.asyncio
async def test_viewers_and_strangers_cant_upload_and_bad_files_are_refused_and_audited(client, db, user):
    from app.auth.events import EVENT_FILE_UPLOAD_REJECTED, AuthEvent

    viewer = await _person(db, "viewer")
    stranger = await _person(db, "stranger")
    ws = await _workspace(db, user, {viewer: "viewer"})
    assert (await _upload(client, viewer, ws.id)).status_code == 403
    assert (await _upload(client, stranger, ws.id)).status_code in (403, 404)

    bad = await _upload(client, user, ws.id, name="evil.exe", data=b"MZ\x90\x00")
    assert bad.status_code == 400
    # Refused through the one upload path, so it's in the audit log (the
    # workspace route never recorded these).
    rows = (await db.execute(select(AuthEvent).where(AuthEvent.user_id == user.id))).scalars().all()
    assert any(r.event_type == EVENT_FILE_UPLOAD_REJECTED for r in rows)


@pytest.mark.asyncio
async def test_the_workspace_cap_is_kept(client, db, user, root):
    from app.chat.models import Workspace

    ws = await _workspace(db, user, {})
    row = await db.get(Workspace, ws.id)
    row.storage_quota_bytes = 20
    await db.commit()
    assert (await _upload(client, user, ws.id, data=b"x" * 10)).status_code == 201
    r = await _upload(client, user, ws.id, name="big.txt", data=b"y" * 50)
    assert r.status_code == 413 and "workspace" in r.json()["detail"]
    # Nothing of the refused upload is left on disk.
    left = [p for p in root.rglob("*") if p.is_file() and ".staging" not in p.parts]
    assert len(left) == 1


@pytest.mark.asyncio
async def test_uploads_land_in_a_drive_subfolder_only(client, db, user):
    ws = await _workspace(db, user, {})
    sub = await client.post(f"/api/workspaces/{ws.id}/drive/folders", json={"name": "Receipts"}, headers=_auth(user))
    assert sub.status_code in (200, 201), sub.text
    ok = await _upload(client, user, ws.id, folder=sub.json()["id"])
    assert ok.status_code == 201 and ok.json()["folder_id"] == sub.json()["id"]
    # A folder outside the workspace's drive is refused.
    outside = await client.post("/api/files/folders", json={"name": "Elsewhere", "scope": "mine"}, headers=_auth(user))
    r = await _upload(client, user, ws.id, folder=outside.json()["id"])
    assert r.status_code == 404
