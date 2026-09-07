"""Executing a command, and the capability rule that guards it.

> **A command never grants new capability.** It is a shortcut to
> something you could already do.

Everything in this file follows from that. Creating a command is not
privileged — automations are owner-scoped today, so gating command
creation behind an admin role would make the shortcut *stricter* than
the thing it invokes, and a user who can run a flow by clicking it
couldn't make a phrase for it. Instead the **target** is re-checked at
execute time, every time: you own the automation, or the connector is
enabled. A command row that outlives its target fails loudly rather
than silently doing nothing.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.commands.constants import SIDE_EFFECTING
from app.commands.matcher import (
    MatchCandidate,
    match,
    near_matches,
    slot_names,
)
from app.commands.models import Command

logger = logging.getLogger("promptly.commands")


class CommandError(Exception):
    """Anything the user needs told about. Always surfaced, never swallowed."""


async def load_commands(
    db: AsyncSession, user_id, *, action_type: str | None = None
) -> list[Command]:
    """Everything this user can say: their own, plus anything shared.

    Shared rows are included here rather than in a separate list so the
    matcher, the ``/`` menu and the library all see the same set. A
    shared command that matched by voice but was missing from the menu
    would be the worst of both.
    """
    stmt = select(Command).where(
        or_(Command.user_id == user_id, Command.shared.is_(True))
    )
    if action_type:
        stmt = stmt.where(Command.action_type == action_type)
    rows = (
        (await db.execute(stmt.order_by(Command.name.asc()))).scalars().all()
    )
    return list(rows)


async def resolve(db: AsyncSession, user_id, utterance: str):
    """Find the single command ``utterance`` means, with its slots.

    Returns ``(Command, slots)`` or ``(None, {})``. Only rows with
    phrases participate — a prompt that's only ever picked from the menu
    has none, and shouldn't be reachable by an unlucky turn of phrase.
    """
    rows = await load_commands(db, user_id)
    candidates = [
        MatchCandidate(
            command_id=r.id, phrases=list(r.phrases or []), enabled=r.enabled
        )
        for r in rows
        if r.phrases
    ]
    result = match(utterance, candidates)
    if result is None:
        return None, {}
    by_id = {r.id: r for r in rows}
    return by_id.get(result.command_id), result.slots


async def nearest(db: AsyncSession, user_id, utterance: str, limit: int = 1):
    """Commands that nearly matched — for asking, never for acting.

    The matcher's refusal to guess is only defensible if a miss can be
    explained. This turns "nothing happened" into "did you mean Kitchen
    Lamp Off?", which is the difference between a system you can learn
    and one you can only be surprised by.
    """
    rows = await load_commands(db, user_id)
    candidates = [
        MatchCandidate(
            command_id=r.id, phrases=list(r.phrases or []), enabled=r.enabled
        )
        for r in rows
        # Slotted commands are excluded on purpose. A suggestion is only
        # useful if saying "yes" can run it, and we have no slot values
        # from an utterance that didn't match — "did you mean turn off
        # the {room} lights?" could only ever run with no room.
        if r.phrases and not any(slot_names(p) for p in r.phrases)
    ]
    by_id = {r.id: r for r in rows}
    return [
        by_id[cid]
        for cid, _score in near_matches(utterance, candidates)[:limit]
        if cid in by_id
    ]


async def assert_runnable(db: AsyncSession, command: Command, user) -> None:
    """The capability rule, enforced at the moment of execution.

    Re-checked on every run rather than trusted from creation time: an
    automation can be deleted, a connector disabled, ownership can move.
    A stale command must fail with a reason rather than appearing to
    work.
    """
    if not command.enabled:
        raise CommandError(f'"{command.name}" is turned off.')

    if command.action_type == "prompt":
        return  # No side effects; nothing to check.

    if command.action_type == "automation":
        from app.tasks.models import Task

        if not command.action_ref:
            raise CommandError(f'"{command.name}" has no automation set.')
        try:
            task_id = uuid.UUID(command.action_ref)
        except ValueError as exc:
            raise CommandError(
                f'"{command.name}" points at an automation that no longer exists.'
            ) from exc
        task = await db.get(Task, task_id)
        # Owner-scoped exactly like the automations API. Someone else's
        # automation is indistinguishable from a deleted one, so this
        # can't be used to probe for what exists.
        if task is None or task.user_id != user.id:
            raise CommandError(
                f'"{command.name}" points at an automation that no longer exists.'
            )
        return

    if command.action_type == "mcp_tool":
        from app.mcp.models import McpConnector

        connector_id, _, tool = (command.action_ref or "").partition(":")
        if not connector_id or not tool:
            raise CommandError(f'"{command.name}" has no tool set.')
        try:
            connector = await db.get(McpConnector, uuid.UUID(connector_id))
        except ValueError as exc:
            raise CommandError(f'"{command.name}" has no tool set.') from exc
        if connector is None or not connector.enabled:
            raise CommandError(
                f'"{command.name}" uses a connector that is switched off.'
            )
        return

    raise CommandError(f"Don't know how to run {command.action_type}.")


def needs_confirmation(command: Command) -> bool:
    """Whether the caller must confirm before this runs.

    Per-command and off by default. An earlier version confirmed every
    side-effecting command, which is the wrong shape: the risk isn't
    uniform, so the friction shouldn't be either. Saying a phrase you
    wrote yourself, or picking a named row out of a menu, is already a
    deliberate act — a dialog on every light toggle just teaches people
    to dismiss dialogs.

    It governs typed and spoken runs identically, so a command can't be
    the kind that asks in one place and not the other.
    """
    return bool(command.confirm_before_run)


async def execute(
    db: AsyncSession,
    command: Command,
    user,
    *,
    slots: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run the command. Returns a result the client can render.

    ``prompt`` commands are not executed here — they're text for the
    composer, and the client inserts them. Saying otherwise would mean
    the server deciding to send a chat message on the user's behalf.
    """
    await assert_runnable(db, command, user)
    args = {**(command.action_args or {}), **(slots or {})}

    if command.action_type == "prompt":
        return {
            "kind": "prompt",
            "text": _fill_slots(command.body or "", args),
        }

    if command.action_type == "automation":
        from app.tasks.models import TaskRun
        from app.tasks.queue import enqueue_run

        run = TaskRun(
            task_id=uuid.UUID(command.action_ref),
            status="pending",
            # Distinct from "manual" so a run's history says how it was
            # started — clicking Run and saying it out loud are different
            # events when you're working out what fired at 3am.
            trigger="command",
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
        await enqueue_run(run.id)
        logger.info(
            "command run: automation task=%s run=%s user=%s",
            command.action_ref,
            run.id,
            user.id,
        )
        return {"kind": "automation", "run_id": str(run.id), "status": run.status}

    if command.action_type == "mcp_tool":
        from app.mcp.service import McpError, call_connector_tool

        connector_id, _, tool = (command.action_ref or "").partition(":")
        try:
            output = await call_connector_tool(
                db,
                connector_id=uuid.UUID(connector_id),
                real_tool=tool,
                arguments=args,
            )
        except McpError as exc:
            # The connector's own failure, reported as-is. "I couldn't
            # reach Home Assistant" is a useful thing to hear; a generic
            # 500 is not.
            raise CommandError(str(exc)) from exc
        logger.info(
            "command run: mcp tool=%s user=%s", command.action_ref, user.id
        )
        return {"kind": "mcp_tool", "output": output}

    raise CommandError(f"Don't know how to run {command.action_type}.")


def _fill_slots(template: str, args: dict[str, Any]) -> str:
    """Substitute ``{slot}`` in a prompt body.

    Unknown placeholders are left verbatim — a template that mentions
    ``{customer}`` with nothing captured should read as an obvious blank
    to fill in, not silently become an empty string.
    """
    out = template
    for key, value in (args or {}).items():
        out = out.replace("{" + str(key) + "}", str(value))
    return out
