"""One answer to "may I edit this note?" (R-218) and a side door that respects
private drafts and the trash.

The collab token used to hand every workspace member the same editor; now
``can_write_document`` decides, and the token says so via ``can_edit``.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.auth.models import User
from app.chat.models import Workspace, WorkspaceItem, WorkspaceShare
from app.files.documents_router import get_collab_token
from app.files.models import UserFile
from app.files.sharing import can_write_document, file_is_accessible_via_workspace


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
async def team(db, user):
    """Owner ``user`` plus one member per collaborator role."""
    members = {r: await _user(db, r) for r in ("admin", "editor", "viewer")}
    ws = Workspace(user_id=user.id, title="Family")
    db.add(ws)
    await db.flush()
    for role, who in members.items():
        db.add(
            WorkspaceShare(
                workspace_id=ws.id, inviter_user_id=user.id,
                invitee_user_id=who.id, status="accepted", role=role,
            )
        )
    await db.commit()
    return ws, members


async def _note(db, ws, author, **kw):
    uf = UserFile(
        user_id=ws.user_id, filename="n.html", original_filename="n.html",
        mime_type="text/html", size_bytes=0, storage_path=f"x/{uuid.uuid4()}",
        source_kind="document",
    )
    db.add(uf)
    await db.flush()
    db.add(
        WorkspaceItem(
            workspace_id=ws.id, kind="note", title="n", position=1.0,
            ref_id=uf.id, created_by=author.id, **kw,
        )
    )
    await db.commit()
    return uf


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("role", "expected"),
    [("admin", True), ("editor", True), ("viewer", False)],
)
async def test_workspace_role_decides_edit(db, user, team, role, expected):
    ws, members = team
    uf = await _note(db, ws, user)

    assert await can_write_document(db, uf, members[role]) is expected


@pytest.mark.asyncio
async def test_collab_token_tells_the_editor_its_permission(db, user, team):
    ws, members = team
    uf = await _note(db, ws, user)

    viewer = await get_collab_token(uf.id, db=db, user=members["viewer"])
    editor = await get_collab_token(uf.id, db=db, user=members["editor"])
    owner = await get_collab_token(uf.id, db=db, user=user)

    assert (viewer.can_edit, editor.can_edit, owner.can_edit) == (False, True, True)


@pytest.mark.asyncio
async def test_side_door_skips_another_members_private_draft(db, team):
    ws, members = team
    uf = await _note(db, ws, members["editor"], visibility="private")

    assert await file_is_accessible_via_workspace(db, uf.id, members["admin"]) is False
    assert await can_write_document(db, uf, members["admin"]) is False
    # The author still reaches their own draft.
    assert await file_is_accessible_via_workspace(db, uf.id, members["editor"]) is True
    with pytest.raises(HTTPException) as e:
        await get_collab_token(uf.id, db=db, user=members["admin"])
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_side_door_skips_trashed_notes(db, user, team):
    ws, members = team
    uf = await _note(db, ws, user, trashed_at=datetime.now(timezone.utc))

    assert await file_is_accessible_via_workspace(db, uf.id, members["editor"]) is False
    assert await can_write_document(db, uf, members["editor"]) is False


@pytest.mark.asyncio
async def test_strangers_get_nothing(db, user, team):
    ws, _members = team
    uf = await _note(db, ws, user)
    stranger = await _user(db, "stranger")

    assert await can_write_document(db, uf, stranger) is False
    with pytest.raises(HTTPException):
        await get_collab_token(uf.id, db=db, user=stranger)
