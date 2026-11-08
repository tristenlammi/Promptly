"""Deciding a tool call that was held for a yes.

Two kinds of call wait on the person whose chat it is:

* a **connector action** that can't be taken back (unlock, open, delete),
  held in any chat (WP-2.1); and
* a **change to your own data** asked for out loud (WP-T3): Talk holds every
  write (``app/talk/tools.py``) and reads it back from its real arguments.

Both are saved on the reply's ``tool_calls`` entry with ``meta.approval =
"pending"``, and both are decided here, whether the person taps the chat's
card (``approvals_router.py``) or answers out loud in Talk: one function, so a
tap and a spoken yes are the same action and can't drift apart.

Access is checked again now, not trusted from when the model asked. A native
change runs on a fresh turn marked ``user_approved``: the person has just
agreed to exactly these arguments. Deciding is claimed first (``running``,
committed), so a tap and a "yes" arriving together run it once.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import EVENT_TOOL_FAILED, EVENT_TOOL_INVOKED, record_event, safe_dict
from app.auth.models import User
from app.chat.models import Conversation, Message

logger = logging.getLogger("promptly.chat.approvals")

RESULT_PREVIEW_CHARS = 600
EXPIRED = "That was asked a while ago, so it wasn't done. Ask again."


class ApprovalError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass
class Decision:
    message_id: uuid.UUID
    call_id: str
    call: dict[str, Any]
    outcome: str  # approved | declined | failed | expired
    # Native changes: what's said about it ("Added."), and the phone action
    # an approved alarm carries.
    say: str | None = None
    device_action: dict[str, Any] | None = None
    content: str | None = None  # the reply's text after, when it changed


# Talk sessions waiting on a call: told when it's decided anywhere (a tap on
# the chat card while you're talking). In-process, like the sessions.
_WATCHERS: dict[tuple[str, str], Callable[[Decision], None]] = {}


def watch(message_id: uuid.UUID, call_id: str, fn: Callable[[Decision], None]) -> None:
    _WATCHERS[(str(message_id), call_id)] = fn


def unwatch(message_id: uuid.UUID, call_id: str) -> None:
    _WATCHERS.pop((str(message_id), call_id), None)


def _notify(decision: Decision) -> None:
    fn = _WATCHERS.pop((str(decision.message_id), decision.call_id), None)
    if fn is not None:
        try:
            fn(decision)
        except Exception:  # noqa: BLE001 - a watcher must not undo the decision
            logger.exception("approval watcher failed")


def is_native(meta: dict[str, Any]) -> bool:
    return bool(meta.get("native"))


def expired(meta: dict[str, Any], now: datetime | None = None) -> bool:
    raw = meta.get("expires_at")
    if not raw:
        return False
    try:
        at = datetime.fromisoformat(str(raw))
    except ValueError:
        return True
    return (now or datetime.now(timezone.utc)) >= at


async def _locked(db: AsyncSession, user: User, message_id: uuid.UUID, call_id: str):
    message = (
        await db.execute(
            select(Message)
            .where(Message.id == message_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    conv = await db.get(Conversation, message.conversation_id) if message else None
    # Only the person whose chat it is decides, not workspace members who
    # can read the conversation.
    if message is None or conv is None or conv.user_id != user.id:
        raise ApprovalError(404, "Message not found")
    calls = list(message.tool_calls or [])
    index = next((i for i, c in enumerate(calls) if c.get("id") == call_id), None)
    if index is None:
        raise ApprovalError(404, "Action not found")
    return message, conv, calls, index


def _save(message: Message, calls: list[dict[str, Any]], index: int, call: dict[str, Any]) -> None:
    calls[index] = call
    message.tool_calls = calls  # reassigned so the JSONB change is saved


def _with_line(content: str | None, line: str) -> str:
    base = (content or "").rstrip()
    return f"{base} {line}".strip() if base else line


async def decide(
    db: AsyncSession,
    user: User,
    message_id: uuid.UUID,
    call_id: str,
    approve: bool,
    *,
    request: Any = None,
    say_outcome: bool = True,
) -> Decision:
    """Approve or decline one held call. ``say_outcome=False`` declines
    without adding "Okay, I'll leave it." to the reply (the person said
    something else instead, which gets its own answer)."""
    message, conv, calls, index = await _locked(db, user, message_id, call_id)
    call = dict(calls[index])
    meta = dict(call.get("meta") or {})
    state = meta.get("approval")
    if state == "running":
        raise ApprovalError(409, "That's already being done.")
    if state != "pending":
        raise ApprovalError(409, "This action was already decided.")
    native = is_native(meta)

    if native and expired(meta):
        meta["approval"] = "expired"
        call["meta"] = meta
        _save(message, calls, index, call)
        await db.commit()
        _notify(Decision(message_id, call_id, call, "expired"))
        raise ApprovalError(409, EXPIRED)

    if not approve:
        from app.talk.readback import DECLINED

        meta["approval"] = "declined"
        call["meta"] = meta
        _save(message, calls, index, call)
        say = DECLINED if native else None
        if native and say_outcome:
            message.content = _with_line(message.content, DECLINED)
        await db.commit()
        decision = Decision(message_id, call_id, call, "declined", say=say, content=message.content if native else None)
        _notify(decision)
        return decision

    if not native:
        decision = await _run_connector(db, user, conv, message, calls, index, call, meta, request)
        _notify(decision)
        return decision

    # Claim it, then run it outside the lock (tools commit their own work).
    meta["approval"] = "running"
    call["meta"] = meta
    _save(message, calls, index, call)
    await db.commit()
    name = str(meta.get("tool") or call.get("name") or "")
    args = meta.get("arguments") if isinstance(meta.get("arguments"), dict) else {}
    ok, content, result_meta, error = await _run_native(user, conv.id, message.parent_id, name, args)

    from app.talk.readback import done_line

    message, _conv, calls, index = await _locked(db, user, message_id, call_id)
    call = dict(calls[index])
    meta = dict(call.get("meta") or {})
    action = result_meta.get("device_action") if ok and isinstance(result_meta.get("device_action"), dict) else None
    if ok:
        meta["approval"] = "approved"
        meta["result"] = (content or "")[:RESULT_PREVIEW_CHARS]
        for key in ("url", "summary"):
            if isinstance(result_meta.get(key), str):
                meta[key] = result_meta[key]
        if action:
            meta["device_action"] = action
        call["ok"] = True
        call.pop("error", None)
    else:
        meta["approval"] = "failed"
        call["ok"] = False
        call["error"] = error
    call["meta"] = meta
    _save(message, calls, index, call)
    say = done_line(name, ok=ok, error=error, said=result_meta.get("spoken") if ok else None)
    if say_outcome:
        message.content = _with_line(message.content, say)
    await _audit(db, request, user, EVENT_TOOL_INVOKED if ok else EVENT_TOOL_FAILED, call, meta)
    await db.commit()
    decision = Decision(
        message_id, call_id, call, "approved" if ok else "failed", say=say, device_action=action, content=message.content
    )
    _notify(decision)
    return decision


async def expire(db: AsyncSession, user: User, message_id: uuid.UUID, call_id: str) -> bool:
    """Talk's 20 seconds ran out: the question no longer stands. False if it
    had already been decided."""
    try:
        message, _conv, calls, index = await _locked(db, user, message_id, call_id)
    except ApprovalError:
        return False
    call = dict(calls[index])
    meta = dict(call.get("meta") or {})
    if meta.get("approval") != "pending":
        return False
    meta["approval"] = "expired"
    call["meta"] = meta
    _save(message, calls, index, call)
    await db.commit()
    _WATCHERS.pop((str(message_id), call_id), None)
    return True


async def _run_native(
    user: User, conversation_id: uuid.UUID, user_message_id: uuid.UUID | None, name: str, args: dict[str, Any]
) -> tuple[bool, str | None, dict[str, Any], str | None]:
    """``(ok, content, result meta, error)``. Its own session, like the chat
    dispatcher runs tools."""
    from app.chat.tools.base import ToolContext, ToolError, TurnState
    from app.chat.tools.registry import get_tool
    from app.chat.tools.validation import ToolArgsInvalid, validate_tool_args
    from app.database import SessionLocal
    from app.talk.tools import approvable

    tool = get_tool(name)
    if tool is None or not approvable(name):
        return False, None, {}, "That can't be done any more."
    try:
        validate_tool_args(tool.parameters, args)
    except ToolArgsInvalid as e:
        return False, None, {}, f"Invalid arguments: {e}"
    try:
        async with SessionLocal() as tdb:
            me = await tdb.get(User, user.id)
            if me is None:
                return False, None, {}, "Your account is no longer available."
            ctx = ToolContext(
                db=tdb,
                user=me,
                conversation_id=conversation_id,
                user_message_id=user_message_id or uuid.uuid4(),
                # A fresh turn: they agreed to exactly this, just now.
                turn=TurnState(user_approved=True),
            )
            async with asyncio.timeout(tool.timeout_seconds or 20.0):
                result = await tool.run(ctx, args)
            await tdb.commit()
    except ToolError as e:
        return False, None, {}, str(e)
    except TimeoutError:
        return False, None, {}, "It took too long."
    except Exception:  # noqa: BLE001 - never a raw error out loud
        logger.exception("approved tool %s failed", name)
        return False, None, {}, "Something went wrong."
    return True, result.content, dict(result.meta or {}), None


async def _run_connector(db, user, conv, message, calls, index, call, meta, request) -> Decision:  # noqa: ANN001
    from app.mcp.client import McpError
    from app.mcp.service import call_connector_tool, connectors_for_turn

    try:
        connector_id = uuid.UUID(str(meta.get("connector_id")))
    except ValueError as e:
        raise ApprovalError(400, "Malformed action") from e
    reachable = {c.id for c in await connectors_for_turn(db, user_id=user.id, workspace_id=conv.workspace_id)}
    if connector_id not in reachable:
        raise ApprovalError(403, "That connector isn't available to you any more.")
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
        outcome = "failed"
        await _audit(db, request, user, EVENT_TOOL_FAILED, call, meta)
    else:
        meta["approval"] = "approved"
        meta["result"] = (output or "")[:RESULT_PREVIEW_CHARS]
        call["ok"] = True
        outcome = "approved"
        await _audit(db, request, user, EVENT_TOOL_INVOKED, call, meta)
    call["meta"] = meta
    _save(message, calls, index, call)
    await db.commit()
    return Decision(message.id, call["id"], call, outcome)


async def _audit(db, request, user, event_type, call, meta) -> None:  # noqa: ANN001
    try:
        await record_event(
            db,
            request=request,
            event_type=event_type,
            user_id=user.id,
            identifier=user.username,
            detail=safe_dict(
                {
                    "tool": call.get("name"),
                    "mcp": not is_native(meta),
                    "approved_by_user": True,
                    "connector": meta.get("connector"),
                    "spoken": bool(meta.get("spoken")),
                }
            ),
        )
    except Exception:  # noqa: BLE001 - the audit row must not undo the action's record
        logger.exception("approval audit failed")
