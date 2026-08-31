"""Command library API.

Owner-scoped throughout via ``get_current_user``; a command belonging to
someone else 404s rather than 403s so its existence isn't probeable.

Note the split between ``/match`` and ``/{id}/run``. Matching tells you
what an utterance *would* do without doing it, which is what lets the
client confirm a side-effecting command before it happens and lets the
``/`` menu preview a phrase. Running requires ``confirmed`` for anything
with side effects — the server refuses rather than assuming the client
asked.
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.commands.constants import ACTION_TYPES, MAX_COMMANDS_PER_USER
from app.commands.models import Command
from app.commands.schemas import (
    CommandCreate,
    CommandMatchRequest,
    CommandMatchResponse,
    CommandResponse,
    CommandRunRequest,
    CommandRunResponse,
    CommandUpdate,
)
from app.commands.service import (
    CommandError,
    execute,
    load_commands,
    needs_confirmation,
    resolve,
)
from app.database import get_db

logger = logging.getLogger("promptly.commands")

router = APIRouter()


async def _get_owned(
    command_id: uuid.UUID, user: User, db: AsyncSession
) -> Command:
    row = await db.get(Command, command_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Command not found"
        )
    return row


@router.get("", response_model=list[CommandResponse])
async def list_commands(
    action_type: str | None = Query(
        default=None, description="Filter to one action type (tab views)"
    ),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Command]:
    if action_type is not None and action_type not in ACTION_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown action type: {action_type}",
        )
    return await load_commands(db, user.id, action_type=action_type)


@router.post(
    "", response_model=CommandResponse, status_code=status.HTTP_201_CREATED
)
async def create_command(
    body: CommandCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Command:
    count = int(
        await db.scalar(
            select(func.count())
            .select_from(Command)
            .where(Command.user_id == user.id)
        )
        or 0
    )
    if count >= MAX_COMMANDS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"That's the maximum of {MAX_COMMANDS_PER_USER} commands.",
        )
    row = Command(user_id=user.id, **body.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.patch("/{command_id}", response_model=CommandResponse)
async def update_command(
    command_id: uuid.UUID,
    body: CommandUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Command:
    row = await _get_owned(command_id, user, db)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/{command_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_command(
    command_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    row = await _get_owned(command_id, user, db)
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/tools")
async def list_available_tools(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """Connectors and tools this user could point a command at.

    Deliberately NOT the admin connector list. It resolves through
    ``connectors_for_turn`` — the same function the chat pipeline uses —
    so the picker offers exactly what this person could already call by
    asking in a chat. That's the capability rule again: building a
    shortcut must never surface a tool you couldn't otherwise reach.

    Serves the cached ``tool_catalog``. Re-pulling a catalog from the
    remote server writes to the connector, so that stays an admin action
    in Settings → Connectors; this is a read.
    """
    from app.mcp.service import connectors_for_turn

    connectors = await connectors_for_turn(db, user_id=user.id)
    out: list[dict] = []
    for connector in connectors:
        allowed = connector.allowed_tools
        tools = [
            {
                "name": t.get("name", ""),
                "description": (t.get("description") or "")[:200],
                # The connector's own hint that this tool changes
                # something in the world. Passed through so the editor
                # can default "ask before running" ON for it — the user
                # shouldn't have to know which of a hundred Home
                # Assistant services is the one that opens a door.
                "destructive": bool(
                    (t.get("annotations") or {}).get("destructiveHint")
                )
                and not (t.get("annotations") or {}).get("readOnlyHint"),
                # The tool's own JSON Schema, so the editor can ask for
                # its arguments. Without this a Home Assistant command
                # can say "turn something off" but never *which* thing —
                # HA exposes intents (HassTurnOff), and the entity is an
                # argument to them, not a tool of its own.
                "input_schema": t.get("input_schema") or {},
            }
            for t in (connector.tool_catalog or [])
            if t.get("name")
            # ``None`` means every discovered tool; ``[]`` means none.
            and (allowed is None or t.get("name") in allowed)
        ]
        out.append(
            {
                "connector_id": str(connector.id),
                "connector_name": connector.name,
                "kind": connector.kind,
                "tools": tools,
            }
        )
    return out


@router.get("/tools/{connector_id}/devices")
async def list_connector_devices(
    connector_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """The devices behind a connector, so you can pick one by name.

    Home Assistant exposes intents rather than one tool per device, so
    without this the editor can only offer "turn something off" and ask
    you to type which thing. ``GetLiveContext`` is HA's own tool for
    listing everything exposed to Assist — the device list is a tool
    call away, with nothing extra to enable.

    Returns ``raw`` alongside the parsed list whenever parsing finds
    nothing, because an empty list and an unreadable response look
    identical from the UI and need opposite fixes.
    """
    from app.commands.devices import (
        LIVE_CONTEXT_TOOL,
        actions_for,
        parse_devices,
        supports_devices,
    )
    from app.mcp.service import McpError, call_connector_tool, connectors_for_turn

    # Resolved the same way the tool list is, so this can't reach a
    # connector the caller couldn't already use.
    connectors = await connectors_for_turn(db, user_id=user.id)
    connector = next((c for c in connectors if c.id == connector_id), None)
    if connector is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Connector not found"
        )

    catalog = [t.get("name", "") for t in (connector.tool_catalog or [])]
    if not supports_devices(catalog):
        return {
            "supported": False,
            "devices": [],
            "raw": "",
            "detail": (
                "This connector doesn't publish a device list, so pick a "
                "tool instead."
            ),
        }

    try:
        raw = await call_connector_tool(
            db,
            connector_id=connector.id,
            real_tool=LIVE_CONTEXT_TOOL,
            arguments={},
        )
    except McpError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    devices = parse_devices(raw)
    return {
        "supported": True,
        "devices": [
            {**d, "actions": actions_for(d["domain"], catalog)} for d in devices
        ],
        # Only when we failed — otherwise it's a large blob nobody reads.
        "raw": "" if devices else raw[:4000],
        "detail": (
            ""
            if devices
            else "Couldn't read the device list from this connector."
        ),
    }


@router.post("/match", response_model=CommandMatchResponse)
async def match_command(
    body: CommandMatchRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommandMatchResponse:
    """What this utterance means, without doing it.

    A miss is a 200 with ``matched=false``, not a 404 — "nothing in the
    library matches" is a normal answer that the caller acts on (fall
    through to the model), not an error.
    """
    command, slots = await resolve(db, user.id, body.utterance)
    if command is None:
        return CommandMatchResponse(matched=False)
    return CommandMatchResponse(
        matched=True,
        command=CommandResponse.model_validate(command),
        slots=slots,
        needs_confirmation=needs_confirmation(command),
    )


@router.post("/{command_id}/run", response_model=CommandRunResponse)
async def run_command(
    command_id: uuid.UUID,
    body: CommandRunRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommandRunResponse:
    row = await _get_owned(command_id, user, db)

    if needs_confirmation(row) and not body.confirmed:
        # 409 rather than 400: the request is well-formed, the state
        # isn't ready. The client re-sends with confirmed=true after
        # asking.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This command needs confirmation before it runs.",
        )

    try:
        result = await execute(db, row, user, slots=body.slots)
    except CommandError as exc:
        # Record the failure in the transcript too, when there is one.
        # A command that silently did nothing is the worst outcome — the
        # user is left unsure whether it fired.
        message = await _record_in_conversation(
            db, row, user, body.conversation_id, ok=False, detail=str(exc)
        )
        if message is not None:
            await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    spoken = row.response_template
    if spoken:
        for key, value in (body.slots or {}).items():
            spoken = spoken.replace("{" + key + "}", str(value))

    summary = spoken or _default_summary(row, result)
    message = await _record_in_conversation(
        db, row, user, body.conversation_id, ok=True, detail=summary
    )
    if message is not None:
        await db.commit()
        await db.refresh(message)

    return CommandRunResponse(
        **result,
        spoken=spoken,
        message=_message_payload(message) if message is not None else None,
    )


def _default_summary(row: Command, result: dict) -> str:
    if result.get("kind") == "automation":
        return f"Started \"{row.name}\"."
    output = (result.get("output") or "").strip()
    return output[:280] if output else f"Ran \"{row.name}\"."


async def _record_in_conversation(
    db: AsyncSession,
    command: Command,
    user: User,
    conversation_id: uuid.UUID | None,
    *,
    ok: bool,
    detail: str,
):
    """Write the run into a chat transcript, if it came from one.

    Shaped as an assistant message carrying a ``tool_calls`` entry, which
    is exactly what the Tool Activity Card already renders in scrollback
    — so a command run looks like any other tool the assistant ran,
    rather than needing its own bespoke message kind.

    Returns the message, or ``None`` when there's no conversation (the
    library's Run button) or it isn't the caller's.
    """
    if conversation_id is None:
        return None

    from app.chat.models import Conversation, Message

    conversation = await db.get(Conversation, conversation_id)
    # Someone else's conversation is simply not written to — the command
    # still ran, since it's the caller's own command.
    if conversation is None or conversation.user_id != user.id:
        return None

    message = Message(
        conversation_id=conversation.id,
        role="assistant",
        content=detail if ok else "",
        tool_calls=[
            {
                "id": str(command.id),
                "name": command.name,
                "ok": ok,
                "error": None if ok else detail,
                "meta": {"action_type": command.action_type, "source": "command"},
            }
        ],
    )
    db.add(message)
    await db.flush()
    return message


def _message_payload(message) -> dict:
    return {
        "id": str(message.id),
        "conversation_id": str(message.conversation_id),
        "role": message.role,
        "content": message.content,
        "tool_calls": message.tool_calls,
        "created_at": message.created_at.isoformat()
        if message.created_at
        else None,
    }
