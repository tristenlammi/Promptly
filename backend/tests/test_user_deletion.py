"""Deleting a user doesn't take the team's work with them (R-004).

Members' notes in a workspace are stored under the *owner's* account, so the
cascade from deleting the owner used to wipe them. These tests delete an
owner (and a member) and check what survives and who owns it.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
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
async def test_a_shared_workspace_goes_to_its_member_by_default(db, team):
    """No pick needed: the member who can edit it takes it over."""
    leaver, member, ws, note = team
    ws_id, note_id, member_id = ws.id, note.id, member.id

    assert await purge_user(db, leaver) is True

    db.expire_all()
    ws = await db.get(Workspace, ws_id)
    assert ws is not None and ws.user_id == member_id
    assert (await db.get(UserFile, note_id)).user_id == member_id


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
async def test_new_owner_must_be_a_member_who_can_edit(db, team):
    """Nobody outside the workspace can be handed it: not a stranger, and
    not the server admin (admin privacy audit L2)."""
    leaver, _member, ws, _note = team
    stranger = await _user(db, "stranger")
    admin = await _user(db, "boss", role="admin")
    ws_id, leaver_id = ws.id, leaver.id

    for outsider_id in (stranger.id, admin.id):
        leaver = await db.get(User, leaver_id)
        with pytest.raises(DeletionRefused, match="members who can edit"):
            await purge_user(db, leaver, transfers={ws_id: outsider_id})
        await db.rollback()
    assert (await db.get(Workspace, ws_id)).user_id == leaver_id


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
        await delete_user(
            leaver_id, req,
            _DeleteUserRequest(confirm_username=leaver_name, transfers={ws.id: user.id}),
            db=db, actor=user,
        )
    assert e.value.status_code == 409  # the deleting admin isn't a member

    await db.refresh(user)
    with pytest.raises(HTTPException) as e:
        await delete_user(admin_id, req, _DeleteUserRequest(confirm_username=admin_name), db=db, actor=user)
    assert e.value.status_code == 403 and "Change their role" in e.value.detail


# ------------------------------------------------- admin privacy (AP4, L2/G7)


async def _ws(db, owner, title, members=()):
    ws = Workspace(user_id=owner.id, title=title)
    db.add(ws)
    await db.flush()
    for i, (m, role) in enumerate(members):
        db.add(WorkspaceShare(
            workspace_id=ws.id, inviter_user_id=owner.id, invitee_user_id=m.id,
            status="accepted", role=role,
            accepted_at=datetime.now(timezone.utc) - timedelta(days=30 - i),
        ))
    await db.commit()
    return ws


@pytest.mark.asyncio
async def test_a_private_workspace_can_never_be_handed_over(db, tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    leaver = await _user(db, "leaver")
    admin = await _user(db, "boss", role="admin")
    diary = await _ws(db, leaver, "Diary")
    diary_id, leaver_id, admin_id = diary.id, leaver.id, admin.id

    with pytest.raises(DeletionRefused, match="shares with others"):
        await purge_user(db, leaver, transfers={diary_id: admin_id})
    await db.rollback()

    assert await purge_user(db, await db.get(User, leaver_id)) is True
    db.expire_all()
    assert await db.get(Workspace, diary_id) is None


@pytest.mark.asyncio
async def test_the_heir_is_the_longest_standing_admin_then_editor(db, tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    leaver = await _user(db, "leaver")
    viewer = await _user(db, "viewer")
    old_editor = await _user(db, "oldeditor")
    new_editor = await _user(db, "neweditor")
    ws_admin = await _user(db, "wsadmin")
    only_viewers = await _user(db, "watcher")
    # Joined in this order: viewer, old editor, new editor, workspace admin.
    team = await _ws(db, leaver, "Team", [(viewer, "viewer"), (old_editor, "editor"),
                                          (new_editor, "editor"), (ws_admin, "admin")])
    editors = await _ws(db, leaver, "Editors", [(new_editor, "editor"), (old_editor, "editor")])
    readers = await _ws(db, leaver, "Readers", [(only_viewers, "viewer")])
    team_id, editors_id, readers_id = team.id, editors.id, readers.id
    ws_admin_id, new_editor_id = ws_admin.id, new_editor.id

    assert await purge_user(db, leaver) is True

    db.expire_all()
    assert (await db.get(Workspace, team_id)).user_id == ws_admin_id
    assert (await db.get(Workspace, editors_id)).user_id == new_editor_id  # joined first there
    # Nobody else in it can edit: it goes with the account.
    assert await db.get(Workspace, readers_id) is None


@pytest.mark.asyncio
async def test_the_admin_may_pick_another_member_who_can_edit(db, tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    leaver = await _user(db, "leaver")
    first = await _user(db, "first")
    second = await _user(db, "second")
    viewer = await _user(db, "viewer")
    ws = await _ws(db, leaver, "Team", [(first, "editor"), (second, "editor"), (viewer, "viewer")])
    ws_id, second_id, viewer_id, leaver_id = ws.id, second.id, viewer.id, leaver.id

    with pytest.raises(DeletionRefused, match="members who can edit"):
        await purge_user(db, leaver, transfers={ws_id: viewer_id})
    await db.rollback()

    leaver = await db.get(User, leaver_id)
    assert await purge_user(db, leaver, transfers={ws_id: second_id}) is True
    db.expire_all()
    assert (await db.get(Workspace, ws_id)).user_id == second_id


@pytest.mark.asyncio
async def test_the_preview_counts_private_workspaces_and_names_only_ones_the_admin_is_in(db, tmp_path, monkeypatch):
    from app.admin.router import user_deletion_preview

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    leaver = await _user(db, "leaver")
    admin = await _user(db, "boss", role="admin")
    colleague = await _user(db, "colleague")
    await _ws(db, leaver, "Biopsy results")
    await _ws(db, leaver, "Private plans")
    await _ws(db, leaver, "Their team", [(colleague, "editor")])
    await _ws(db, leaver, "Ops", [(admin, "editor"), (colleague, "viewer")])

    out = await user_deletion_preview(leaver.id, db=db, actor=admin)

    assert out.private_workspace_count == 2
    body = out.model_dump_json()
    for secret in ("Biopsy results", "Private plans", "Their team"):
        assert secret not in body
    by_title = {w.title: w for w in out.workspaces}
    assert set(by_title) == {None, "Ops"}
    assert [h.username for h in by_title[None].heirs] == [colleague.username]
    assert by_title["Ops"].member_count == 2
    assert [h.username for h in by_title["Ops"].heirs] == [admin.username]
