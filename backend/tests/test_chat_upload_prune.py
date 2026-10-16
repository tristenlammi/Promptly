"""The Chat Uploads pruner only bins uploads nothing uses (R-026, R-034).

Custom-model knowledge files and board-card attachments upload through the
chat route, so they sit in Chat Uploads — and the pruner, which only looked
at chat messages, trashed them within hours. Card attachments were also
unreadable for teammates.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.auth.models import User
from app.chat.models import Workspace, WorkspaceItem, WorkspaceShare, WorkspaceTask
from app.custom_models.models import CustomModel, CustomModelFile
from app.files.chat_upload_prune import prune_orphaned_chat_uploads
from app.files.models import UserFile
from app.files.sharing import file_is_accessible_via_workspace
from app.files.system_folders import ensure_chat_uploads

OLD = datetime.now(timezone.utc) - timedelta(days=2)


async def _upload(db, user, *, created_at=OLD, name="a.pdf"):
    folder = await ensure_chat_uploads(db, user)
    f = UserFile(
        user_id=user.id, folder_id=folder.id, filename=name, original_filename=name,
        mime_type="application/pdf", size_bytes=1, storage_path=f"x/{uuid.uuid4()}",
    )
    db.add(f)
    await db.flush()
    f.created_at = created_at
    await db.commit()
    return f


async def _trashed(db, f) -> bool:
    await db.refresh(f)
    return f.trashed_at is not None


@pytest.mark.asyncio
async def test_unreferenced_old_upload_is_trashed(db, user):
    f = await _upload(db, user)

    assert await prune_orphaned_chat_uploads(db, user.id) == 1
    assert await _trashed(db, f)


@pytest.mark.asyncio
async def test_a_just_attached_upload_is_left_alone(db, user):
    """The composer uploads on attach; the message doesn't exist yet."""
    f = await _upload(db, user, created_at=datetime.now(timezone.utc))

    assert await prune_orphaned_chat_uploads(db, user.id) == 0
    assert not await _trashed(db, f)


@pytest.mark.asyncio
async def test_custom_model_knowledge_is_kept(db, user, provider):
    f = await _upload(db, user)
    cm = CustomModel(name="kb", display_name="KB", base_provider_id=provider.id,
                     base_model_id="m", created_by=user.id)
    db.add(cm)
    await db.flush()
    db.add(CustomModelFile(custom_model_id=cm.id, user_file_id=f.id))
    await db.commit()

    assert await prune_orphaned_chat_uploads(db, user.id) == 0
    assert not await _trashed(db, f)


async def _board(db, owner, *, visibility="workspace"):
    ws = Workspace(user_id=owner.id, title="W")
    db.add(ws)
    await db.flush()
    board = WorkspaceItem(workspace_id=ws.id, kind="board", title="B", position=1.0,
                          created_by=owner.id, visibility=visibility)
    db.add(board)
    await db.flush()
    return ws, board


@pytest.mark.asyncio
async def test_card_attachments_are_kept_and_teammates_can_open_them(db, user):
    f = await _upload(db, user)
    ws, board = await _board(db, user)
    db.add(WorkspaceTask(workspace_id=ws.id, board_item_id=board.id, title="Card",
                         attachments=[{"file_id": str(f.id), "filename": "a.pdf"}]))
    mate = User(email=f"m-{uuid.uuid4().hex[:6]}@x.com", username=f"m{uuid.uuid4().hex[:6]}",
                password_hash="x", role="user")
    db.add(mate)
    await db.flush()
    db.add(WorkspaceShare(workspace_id=ws.id, inviter_user_id=user.id,
                          invitee_user_id=mate.id, status="accepted", role="viewer"))
    await db.commit()

    assert await prune_orphaned_chat_uploads(db, user.id) == 0
    assert not await _trashed(db, f)
    assert await file_is_accessible_via_workspace(db, f.id, mate) is True


@pytest.mark.asyncio
async def test_attachments_on_someone_elses_private_board_stay_private(db, user):
    f = await _upload(db, user)
    ws, board = await _board(db, user, visibility="private")
    db.add(WorkspaceTask(workspace_id=ws.id, board_item_id=board.id, title="Card",
                         attachments=[{"file_id": str(f.id)}]))
    mate = User(email=f"m-{uuid.uuid4().hex[:6]}@x.com", username=f"m{uuid.uuid4().hex[:6]}",
                password_hash="x", role="user")
    db.add(mate)
    await db.flush()
    db.add(WorkspaceShare(workspace_id=ws.id, inviter_user_id=user.id,
                          invitee_user_id=mate.id, status="accepted", role="editor"))
    await db.commit()

    assert await file_is_accessible_via_workspace(db, f.id, mate) is False
