"""Private drafts and private chats stay private in every list (R-039, R-040).

Each test puts something private in the workspace and checks a specific
surface — overview tasks and recents, chat list, trash, chat indexing,
memory rewrite — doesn't hand it to another member.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.auth.models import User
from app.chat.models import (
    Conversation,
    Workspace,
    WorkspaceItem,
    WorkspaceShare,
)
from app.files import storage
from app.files.models import UserFile
from app.workspaces.items_router import (
    list_workspace_trash,
    regenerate_workspace_memory_endpoint,
    set_chat_context,
)
from app.workspaces.overview_router import workspace_overview
from app.workspaces.router import list_workspace_conversations
from app.workspaces.schemas import WorkspaceFileContext


async def _user(db, name):
    u = User(
        email=f"{name}-{uuid.uuid4().hex[:8]}@example.com",
        username=f"{name}-{uuid.uuid4().hex[:8]}",
        password_hash="x",
        role="user",
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


@pytest.fixture
async def team(db, user, tmp_path, monkeypatch):
    """Owner ``user`` + an editor ``member`` + a viewer, one workspace."""
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    member = await _user(db, "member")
    viewer = await _user(db, "viewer")
    ws = Workspace(user_id=user.id, title="Family")
    db.add(ws)
    await db.flush()
    for who, role in ((member, "editor"), (viewer, "viewer")):
        db.add(
            WorkspaceShare(
                workspace_id=ws.id, inviter_user_id=user.id,
                invitee_user_id=who.id, status="accepted", role=role,
            )
        )
    await db.commit()
    return ws, member, viewer


async def _note(db, ws, author, title, html, tmp_root, **kw):
    rel = f"u_{ws.user_id}/{uuid.uuid4()}.html"
    p = Path(tmp_root) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(html, encoding="utf-8")
    uf = UserFile(
        user_id=ws.user_id, filename=f"{title}.html", original_filename=f"{title}.html",
        mime_type="text/html", size_bytes=len(html), storage_path=rel,
        source_kind="document",
    )
    db.add(uf)
    await db.flush()
    it = WorkspaceItem(
        workspace_id=ws.id, kind="note", title=title, position=1.0,
        ref_id=uf.id, created_by=author.id, **kw,
    )
    db.add(it)
    await db.commit()
    return it


CHECKLIST = '<ul data-type="taskList"><li data-checked="false"><p>{}</p></li></ul>'


@pytest.mark.asyncio
async def test_overview_hides_another_members_private_draft(db, user, team):
    ws, member, _viewer = team
    root = storage.UPLOAD_ROOT
    await _note(db, ws, member, "Surprise party plan",
                CHECKLIST.format("Book the venue secretly"), root,
                visibility="private")
    await _note(db, ws, member, "Groceries", CHECKLIST.format("Milk"), root)

    ov = await workspace_overview(ws.id, db=db, user=user)

    task_texts = " ".join(t.text for t in ov.tasks)
    recent_titles = {r.title for r in ov.recent}
    assert "Milk" in task_texts
    assert "venue" not in task_texts
    assert "Surprise party plan" not in recent_titles
    assert ov.counts.notes == 1


@pytest.mark.asyncio
async def test_the_creator_still_sees_their_own_draft(db, team):
    ws, member, _viewer = team
    await _note(db, ws, member, "My draft", CHECKLIST.format("Mine"),
                storage.UPLOAD_ROOT, visibility="private")

    ov = await workspace_overview(ws.id, db=db, user=member)

    assert "Mine" in " ".join(t.text for t in ov.tasks)


@pytest.mark.asyncio
async def test_chat_list_hides_other_members_private_chats(db, user, team, provider):
    ws, member, _viewer = team
    db.add_all(
        [
            Conversation(user_id=member.id, title="Private worries",
                         provider_id=provider.id, model_id="m",
                         workspace_id=ws.id, visibility="private"),
            Conversation(user_id=member.id, title="Shared plan",
                         provider_id=provider.id, model_id="m",
                         workspace_id=ws.id, visibility="workspace"),
        ]
    )
    await db.commit()

    titles = {c.title for c in await list_workspace_conversations(ws.id, db=db, user=user)}

    assert "Shared plan" in titles and "Private worries" not in titles


@pytest.mark.asyncio
async def test_trash_hides_another_members_private_draft(db, user, team):
    ws, member, _viewer = team
    now = datetime.now(timezone.utc)
    await _note(db, ws, member, "Deleted private thing", "<p>x</p>",
                storage.UPLOAD_ROOT, visibility="private", trashed_at=now)
    await _note(db, ws, member, "Deleted shared thing", "<p>y</p>",
                storage.UPLOAD_ROOT, trashed_at=now)

    from types import SimpleNamespace
    entries = await list_workspace_trash(
        ws.id, request=SimpleNamespace(headers={}, client=None), db=db, user=user
    )

    titles = {e.title for e in entries}
    assert "Deleted shared thing" in titles
    assert "Deleted private thing" not in titles


@pytest.mark.asyncio
async def test_only_a_chats_creator_can_index_it(db, user, team, provider):
    ws, member, _viewer = team
    conv = Conversation(user_id=member.id, title="c", provider_id=provider.id,
                        model_id="m", workspace_id=ws.id, visibility="workspace")
    db.add(conv)
    await db.commit()

    with pytest.raises(HTTPException) as e:
        await set_chat_context(ws.id, conv.id, WorkspaceFileContext(enabled=True),
                               BackgroundTasks(), db=db, user=user)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_a_private_chat_cannot_be_indexed_into_the_shared_pool(
    db, team, provider
):
    ws, member, _viewer = team
    conv = Conversation(user_id=member.id, title="c", provider_id=provider.id,
                        model_id="m", workspace_id=ws.id, visibility="private")
    db.add(conv)
    await db.commit()

    with pytest.raises(HTTPException) as e:
        await set_chat_context(ws.id, conv.id, WorkspaceFileContext(enabled=True),
                               BackgroundTasks(), db=db, user=member)
    assert e.value.status_code == 409


@pytest.mark.asyncio
async def test_an_editor_cannot_rewrite_workspace_memory(db, team):
    ws, member, _viewer = team

    with pytest.raises(HTTPException) as e:
        await regenerate_workspace_memory_endpoint(ws.id, db=db, user=member)
    assert e.value.status_code == 403
