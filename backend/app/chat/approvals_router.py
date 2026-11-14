"""Approve or decline a tool call the model asked to make.

A destructive connector tool (unlock, open, delete…) isn't run when the
model calls it in chat, and on a spoken turn (Talk) nothing that changes
your data runs either: the reply carries an approval card instead, with the
exact action and arguments. This is what the card's buttons call, parity
with Commands' "Ask before running". The deciding itself is in
``approvals.py``, shared with Talk's spoken yes.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.approvals import ApprovalError, decide
from app.database import get_db

logger = logging.getLogger("promptly.chat.approvals")

router = APIRouter()


class ApprovalRequest(BaseModel):
    approve: bool


class ApprovalResponse(BaseModel):
    tool_call: dict[str, Any]
    # A spoken change's reply gains its outcome ("Added."); the new text.
    content: str | None = None


@router.post(
    "/messages/{message_id}/tool-calls/{call_id}/approval",
    response_model=ApprovalResponse,
)
async def decide_tool_call(
    message_id: uuid.UUID,
    call_id: str,
    payload: ApprovalRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApprovalResponse:
    try:
        decision = await decide(db, user, message_id, call_id, payload.approve, request=request)
    except ApprovalError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail) from None
    return ApprovalResponse(tool_call=decision.call, content=decision.content)


@router.post("/conversations/{conversation_id}/tool-calls/{call_id}/answer")
async def answer_waiting_call(
    conversation_id: uuid.UUID,
    call_id: str,
    payload: ApprovalRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, bool]:
    """Answer a card the reply is waiting on right now (``holds.py``): the
    reply isn't saved yet, so there's no message to decide. Only the person
    whose chat it is can answer. 409 once it has stopped waiting; the card on
    the finished reply still works."""
    from app.chat import holds
    from app.chat.models import Conversation

    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if not holds.answer(conversation_id, call_id, payload.approve):
        raise HTTPException(
            status_code=409,
            detail="The reply has stopped waiting for this. You can still answer on the card when it finishes.",
        )
    return {"ok": True}
