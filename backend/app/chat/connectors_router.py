"""Which outside services a chat can use (R-161).

Lists the connectors reachable from a conversation — global ones, ones
granted to the user, ones attached to its workspace — and lets the chat's
owner switch any of them off for that chat. Shown in the composer's More
menu, which is also the only place a user can see what's connected.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Conversation
from app.database import get_db

router = APIRouter()


class ChatConnector(BaseModel):
    id: uuid.UUID
    name: str
    tool_count: int
    on: bool


class ChatConnectorsUpdate(BaseModel):
    disabled_connector_ids: list[uuid.UUID]


async def _own_conversation(db: AsyncSession, conversation_id: uuid.UUID, user: User) -> Conversation:
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@router.get("/conversations/{conversation_id}/connectors", response_model=list[ChatConnector])
async def list_chat_connectors(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ChatConnector]:
    from app.mcp.service import connectors_for_turn

    conv = await _own_conversation(db, conversation_id, user)
    off = set(conv.disabled_connector_ids or [])
    reachable = await connectors_for_turn(db, user_id=user.id, workspace_id=conv.workspace_id)
    return sorted(
        (
            ChatConnector(id=c.id, name=c.name, tool_count=len(c.tool_catalog or []), on=str(c.id) not in off)
            for c in reachable
        ),
        key=lambda c: c.name.lower(),
    )


@router.put("/conversations/{conversation_id}/connectors", status_code=204)
async def set_chat_connectors(
    conversation_id: uuid.UUID,
    payload: ChatConnectorsUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    conv = await _own_conversation(db, conversation_id, user)
    conv.disabled_connector_ids = sorted({str(i) for i in payload.disabled_connector_ids}) or None
    await db.commit()
