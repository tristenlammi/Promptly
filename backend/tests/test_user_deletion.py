"""Deleting a user doesn't take the team's work with them (R-004).

Members' notes in a workspace are stored under the *owner's* account, so the
cascade from deleting the owner used to wipe them. These tests delete an
owner (and a member) and check what survives and who owns it.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.auth.events import AuthEvent
from app.auth.models import User
from app.chat.models import Conversation, Workspace, WorkspaceItem, WorkspaceShare
from app.files import storage
from app.files.models import BlobTombstone, FileFolder, UserFile
from app.files.system_folders import create_workspace_folder_tree
from app.tasks.deletion import DeletionRefused, purge_user


async def _user(db, name, role="user"):
    u = User(
        email=f"{name}-{uuid.uuid4().hex[:8]}@example.com",
        username=f"{name}{uuid.uuid4().hex[:6]}",
        password_hash="x",
        role=role,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


@pytest.fixture
async def team(db, tmp_path, monkeypatch):
    """``leaver`` owns a workspace; ``member`` wrote a note in it."""
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    leaver = await _user(db, "leaver")
    member = await _user(db, "member")
    folder = await create_workspace_folder_tree(db, leaver, "Team")
    ws = Workspace(user_id=leaver.id, title="Team", root_folder_id=folder.id)
    db.add(ws)
    await db.flush()
    db.add(WorkspaceShare(workspace_id=ws.id, inviter_user_id=leaver.id,
                          invitee_user_id=member.id, status="accepted", role="editor"))
    rel = f"u_{leaver.id}/{uuid.uuid4()}.html"
    p = Path(tmp_path, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("<p>member's work</p>")
    note = UserFile(user_id=leaver.id, folder_id=folder.id, filename="n.html",
                    original_filename="n.html", mime_type="text/html", size_bytes=20,
                    storage_path=rel, source_kind="document")
    db.add(note)
    await db.flush()
    db.add(WorkspaceItem(workspace_id=ws.id, kind="note", title="Member's note",
                         position=1.0, ref_id=note.id, created_by=member.id))
    await db.commit()
    return leaver, member, ws, note


@pytest.mark.asyncio
async def test_a_shared_workspace_must_be_handed_over_first(db, team):
    leaver, _member, ws, _note = team
    ws_id = ws.id

    with pytest.raises(DeletionRefused, match="Team"):
        await purge_user(db, leaver)
    await db.rollback()

    assert await db.get(Workspace, ws_id) is not None


@pytest.mark.asyncio
async def test_transfer_keeps_the_teams_work(db, team):
    leaver, member, ws, note = team
    ws_id, note_id, folder_id = ws.id, note.id, ws.root_folder_id
    leaver_id, member_id = leaver.id, member.id

    assert await purge_user(db, leaver, transfers={ws_id: member_id}) is True

    db.expire_all()
    ws = await db.get(Workspace, ws_id)
    assert ws is not None and ws.user_id == member_id
    note = await db.get(UserFile, note_id)
    assert note is not None and note.user_id == member_id
    assert (await db.get(FileFolder, folder_id)).user_id == member_id
    # The new owner isn't also listed as a member of their own workspace.
    shares = (await db.execute(select(WorkspaceShare).where(WorkspaceShare.workspace_id == ws_id))).all()
    assert shares == []
    # The bucket is tombstoned, and the sweep will spare the note's blob.
    t = (await db.execute(select(BlobTombstone))).scalar_one()
    assert t.is_dir and t.storage_path == f"u_{leaver_id}"
    ev = (await db.execute(select(AuthEvent).where(AuthEvent.event_type == "user_deleted"))).scalar_one()
    assert "transferred=1" in ev.detail


@pytest.mark.asyncio
async def test_new_owner_must_be_a_member_or_admin(db, team):
    leaver, _member, ws, _note = team
    stranger = await _user(db, "stranger")

    with pytest.raises(DeletionRefused, match="members or an admin"):
        await purge_user(db, leaver, transfers={ws.id: stranger.id})


@pytest.mark.asyncio
async def test_deleting_a_member_keeps_their_invites_and_shared_chats(db, user, provider, tmp_path, monkeypatch):
    """A member who invited others (as an admin of the workspace) and
    started a team chat: both used to cascade away with them."""
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    owner = user
    helper = await _user(db, "helper")
    newbie = await _user(db, "newbie")
    ws = Workspace(user_id=owner.id, title="Ops")
    db.add(ws)
    await db.flush()
    db.add_all([
        WorkspaceShare(workspace_id=ws.id, inviter_user_id=owner.id,
                       invitee_user_id=helper.id, status="accepted", role="admin"),
        WorkspaceShare(workspace_id=ws.id, inviter_user_id=helper.id,
                       invitee_user_id=newbie.id, status="accepted", role="editor"),
        Conversation(user_id=helper.id, title="Runbook chat", provider_id=provider.id,
                     model_id="m", workspace_id=ws.id, visibility="workspace"),
        Conversation(user_id=helper.id, title="My private chat", provider_id=provider.id,
                     model_id="m", workspace_id=ws.id, visibility="private"),
    ])
    await db.commit()
    owner_id, newbie_id = owner.id, newbie.id

    assert await purge_user(db, helper) is True

    db.expire_all()
    newbie_share = (await db.execute(
        select(WorkspaceShare).where(WorkspaceShare.invitee_user_id == newbie_id)
    )).scalar_one()
    assert newbie_share.inviter_user_id == owner_id
    titles = {c.title: c.user_id for c in (await db.execute(select(Conversation))).scalars()}
    assert titles == {"Runbook chat": owner_id}


@pytest.mark.asyncio
async def test_admin_endpoint_requires_typed_confirmation(db, user, team):
    from starlette.requests import Request

    from app.admin.router import _DeleteUserRequest, delete_user

    leaver, member, ws, _note = team
    leaver_id, leaver_name = leaver.id, leaver.username
    other_admin = await _user(db, "admin2", role="admin")
    admin_id, admin_name = other_admin.id, other_admin.username
    req = Request({"type": "http", "headers": [], "client": ("1.2.3.4", 1)})

    with pytest.raises(HTTPException) as e:
        await delete_user(leaver_id, req, _DeleteUserRequest(confirm_username="nope"), db=db, actor=user)
    assert e.value.status_code == 400

    with pytest.raises(HTTPException) as e:
        await delete_user(leaver_id, req, _DeleteUserRequest(confirm_username=leaver_name), db=db, actor=user)
    assert e.value.status_code == 409  # shared workspace not handed over

    await db.refresh(user)
    with pytest.raises(HTTPException) as e:
        await delete_user(admin_id, req, _DeleteUserRequest(confirm_username=admin_name), db=db, actor=user)
    assert e.value.status_code == 403 and "Change their role" in e.value.detail
