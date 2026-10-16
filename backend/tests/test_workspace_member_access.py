"""Removed and demoted members lose workspace access everywhere (R-032).

Before: a member's old workspace chats kept the workspace tools, so after
being removed they could still read notes and boards by title and file
proposals; and applying a proposal never re-checked access. Also, chat
dispatch ran any registered tool the model named, even one it was never
offered — so category gating was advisory.
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.auth.models import User
from app.chat.models import (
    Conversation,
    Workspace,
    WorkspaceProposal,
    WorkspaceShare,
)
from app.chat.proposals_router import apply_proposal
from app.chat.router import _dispatch_tools
from app.chat.tools.base import ToolContext
from app.workspaces.shares import workspace_role


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


async def _workspace_with_member(db, owner, member, role):
    ws = Workspace(user_id=owner.id, title="Family")
    db.add(ws)
    await db.flush()
    share = WorkspaceShare(
        workspace_id=ws.id,
        inviter_user_id=owner.id,
        invitee_user_id=member.id,
        status="accepted",
        role=role,
    )
    db.add(share)
    await db.commit()
    return ws, share


@pytest.mark.asyncio
async def test_workspace_role_tracks_current_membership(db, user):
    member = await _user(db, "member")
    ws, share = await _workspace_with_member(db, user, member, "editor")

    assert await workspace_role(db, ws.id, user) == "owner"
    assert await workspace_role(db, ws.id, member) == "editor"

    share.role = "viewer"
    await db.commit()
    assert await workspace_role(db, ws.id, member) == "viewer"

    await db.delete(share)
    await db.commit()
    assert await workspace_role(db, ws.id, member) is None


async def _pending_proposal(db, ws, member, provider):
    conv = Conversation(
        user_id=member.id, title="c", provider_id=provider.id, model_id="m",
        workspace_id=ws.id,
    )
    db.add(conv)
    await db.flush()
    p = WorkspaceProposal(
        conversation_id=conv.id,
        workspace_id=ws.id,
        user_id=member.id,
        kind="create_note",
        payload={"title": "Planted", "content": "x"},
        status="pending",
    )
    db.add(p)
    await db.commit()
    return p


@pytest.mark.asyncio
async def test_a_removed_member_cannot_apply_a_pending_proposal(
    db, user, provider
):
    member = await _user(db, "member")
    ws, share = await _workspace_with_member(db, user, member, "editor")
    p = await _pending_proposal(db, ws, member, provider)
    await db.delete(share)
    await db.commit()

    with pytest.raises(HTTPException) as e:
        await apply_proposal(p.id, BackgroundTasks(), db=db, user=member)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_a_member_demoted_to_viewer_cannot_apply_one(db, user, provider):
    member = await _user(db, "member")
    ws, share = await _workspace_with_member(db, user, member, "editor")
    p = await _pending_proposal(db, ws, member, provider)
    share.role = "viewer"
    await db.commit()

    with pytest.raises(HTTPException) as e:
        await apply_proposal(p.id, BackgroundTasks(), db=db, user=member)
    assert e.value.status_code == 403


@pytest.mark.asyncio
async def test_dispatch_refuses_a_tool_that_was_not_offered(db, user):
    """The model names ``propose_workspace_note`` but this turn only
    offered web search — it must not run."""
    events = []
    async for sse_event, _hist in _dispatch_tools(
        db=db,
        request=SimpleNamespace(headers={}, client=None, state=SimpleNamespace()),
        user=user,
        pending_calls={
            0: {
                "id": "call_1",
                "name": "propose_workspace_note",
                "arguments": json.dumps({"title": "x", "content": "y"}),
            }
        },
        ctx=ToolContext(
            db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=None
        ),
        sse_yield=lambda d: d,
        on_attachment=lambda _s: None,
        allowed_tool_names={"web_search"},
    ):
        events.append(sse_event)

    text = json.dumps(events, default=str)
    assert "isn't available in this chat" in text
