"""Approve or decline a connector action the model asked to take.

A destructive connector tool (unlock, open, delete…) isn't run when the
model calls it in chat; the reply carries an approval card instead, with
the exact action and arguments. This is what the card's buttons call —
parity with Commands' "Ask before running". Access is checked again now,
not trusted from when the model asked.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import EVENT_TOOL_FAILED, EVENT_TOOL_INVOKED, record_event, safe_dict
from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Conversation, Message
from app.database import get_db

logger = logging.getLogger("promptly.chat.approvals")

router = APIRouter()

_RESULT_PREVIEW_CHARS = 600


class ApprovalRequest(BaseModel):
    approve: bool


class ApprovalResponse(BaseModel):
    tool_call: dict[str, Any]


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
    from app.mcp.client import McpError
    from app.mcp.service import call_connector_tool, connectors_for_turn

    message = await db.get(Message, message_id)
    conv = await db.get(Conversation, message.conversation_id) if message else None
    # Only the person whose chat it is decides — not workspace members who
    # can read the conversation.
    if message is None or conv is None or conv.user_id != user.id:
        raise HTTPException(status_code=404, detail="Message not found")
    calls = list(message.tool_calls or [])
    index = next((i for i, c in enumerate(calls) if c.get("id") == call_id), None)
    if index is None:
        raise HTTPException(status_code=404, detail="Action not found")
    call = dict(calls[index])
    meta = dict(call.get("meta") or {})
    if meta.get("approval") != "pending":
        raise HTTPException(status_code=409, detail="This action was already decided.")

    if not payload.approve:
        meta["approval"] = "declined"
    else:
        try:
            connector_id = uuid.UUID(str(meta.get("connector_id")))
        except ValueError as e:
            raise HTTPException(status_code=400, detail="Malformed action") from e
        reachable = {
            c.id
            for c in await connectors_for_turn(db, user_id=user.id, workspace_id=conv.workspace_id)
        }
        if connector_id not in reachable:
            raise HTTPException(status_code=403, detail="That connector isn't available to you any more.")
        try:
            output = await call_connector_tool(
                db,
                connector_id=connector_id,
                real_tool=str(meta.get("tool") or ""),
                arguments=meta.get("arguments") or {},
                allow_destructive=True,
            )
        except McpError as e:
            meta["approval"] = "failed"
            call["ok"] = False
            call["error"] = str(e)
            await _audit(db, request, user, EVENT_TOOL_FAILED, call, meta)
        else:
            meta["approval"] = "approved"
            meta["result"] = (output or "")[:_RESULT_PREVIEW_CHARS]
            call["ok"] = True
            await _audit(db, request, user, EVENT_TOOL_INVOKED, call, meta)

    call["meta"] = meta
    calls[index] = call
    message.tool_calls = calls  # reassigned so the JSONB change is saved
    await db.commit()
    return ApprovalResponse(tool_call=call)


async def _audit(db, request, user, event_type, call, meta) -> None:
    try:
        await record_event(
            db,
            request=request,
            event_type=event_type,
            user_id=user.id,
            identifier=user.username,
            detail=safe_dict(
                {"tool": call.get("name"), "mcp": True, "approved_by_user": True,
                 "connector": meta.get("connector")}
            ),
        )
    except Exception:  # noqa: BLE001 — the audit row must not undo the action's record
        logger.exception("approval audit failed")
