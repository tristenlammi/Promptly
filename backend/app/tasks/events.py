"""Internal workspace-event dispatch for automations (E-batch).

The counterpart to the inbound webhook: instead of the outside world
POSTing a URL, the app itself fires flows when something happens in a
workspace — a file lands in the drive, a board card changes column, an
item is created.

Design:

* **Fire-and-forget.** :func:`emit_workspace_event` schedules a
  background task and returns immediately — an emit can never slow down
  or fail the request that caused the event (same contract as
  ``notify_user``). The dispatcher owns its own DB session, so it also
  never entangles with the host transaction.
* **Matching.** A task fires when it's enabled, homed in the event's
  workspace, and its stored Advanced graph contains a ``trigger.event``
  node whose ``event`` kind matches (plus optional filters: ``column``
  for card moves, ``item_kind`` for item creations).
* **Flood guard.** Mirrors the webhook rule: a task with too many
  unfinished runs is skipped rather than queued deeper — a hot board
  can't wedge the worker.
* **Payload.** The event dict is serialised into
  ``TaskRun.trigger_payload`` so flows read it via
  ``{{trigger.json.*}}`` exactly like webhook bodies.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from sqlalchemy import func, select

from app.database import SessionLocal
from app.tasks.models import Task, TaskRun
from app.tasks.queue import enqueue_run

logger = logging.getLogger("promptly.tasks.events")

# Event kinds — keep in lockstep with ``EventTriggerData`` docs and the
# frontend picker.
EVENT_FILE_ADDED = "file_added"
EVENT_CARD_MOVED = "card_moved"
EVENT_ITEM_CREATED = "item_created"

# Same ceiling as the webhook flood guard: more unfinished runs than this
# and the event is dropped for that task (logged, not queued).
_MAX_QUEUED = 10


def emit_workspace_event(
    *,
    workspace_id: uuid.UUID,
    event: str,
    payload: dict[str, Any],
) -> None:
    """Schedule event dispatch for every matching automation. Non-blocking;
    all failures are logged and swallowed — emitting an event must never
    break the request that caused it."""
    try:
        asyncio.create_task(
            _dispatch(workspace_id=workspace_id, event=event, payload=payload),
            name=f"ws-event-{event}-{workspace_id}",
        )
    except RuntimeError:  # no running loop — sync/test context
        logger.warning("emit_workspace_event: no running loop; dropped")


def _trigger_matches(
    node_data: dict[str, Any], event: str, payload: dict[str, Any]
) -> bool:
    """Does one ``trigger.event`` node's config match this event?"""
    if str(node_data.get("event") or "").strip() != event:
        return False
    if event == EVENT_CARD_MOVED:
        want = str(node_data.get("column") or "").strip().lower()
        if want:
            got = str(payload.get("column") or "").strip().lower()
            got_name = str(payload.get("column_name") or "").strip().lower()
            if want not in (got, got_name):
                return False
    if event == EVENT_ITEM_CREATED:
        want_kind = str(node_data.get("item_kind") or "").strip().lower()
        if want_kind and want_kind != str(payload.get("kind") or "").lower():
            return False
    return True


async def _dispatch(
    *, workspace_id: uuid.UUID, event: str, payload: dict[str, Any]
) -> None:
    try:
        async with SessionLocal() as db:
            tasks = (
                await db.execute(
                    select(Task).where(
                        Task.workspace_id == workspace_id,
                        Task.enabled.is_(True),
                        Task.flow_graph.is_not(None),
                    )
                )
            ).scalars().all()

            fired: list[uuid.UUID] = []
            for task in tasks:
                nodes = (task.flow_graph or {}).get("nodes", [])
                trigger = next(
                    (
                        n
                        for n in nodes
                        if n.get("type") == "trigger.event"
                        and _trigger_matches(n.get("data") or {}, event, payload)
                    ),
                    None,
                )
                if trigger is None:
                    continue
                # Flood guard — a busy workspace can't queue-bomb one task.
                queued = await db.scalar(
                    select(func.count()).where(
                        TaskRun.task_id == task.id,
                        TaskRun.status.in_(("pending", "running")),
                    )
                )
                if int(queued or 0) >= _MAX_QUEUED:
                    logger.warning(
                        "event %s skipped for task %s: %d runs already queued",
                        event,
                        task.id,
                        queued,
                    )
                    continue
                run = TaskRun(
                    task_id=task.id,
                    status="pending",
                    trigger="event",
                    trigger_payload=json.dumps(
                        {"event": event, **payload}, default=str
                    ),
                )
                db.add(run)
                await db.flush()
                fired.append(run.id)
            await db.commit()

        for run_id in fired:
            await enqueue_run(run_id)
        if fired:
            logger.info(
                "workspace event %s fired %d automation run(s)", event, len(fired)
            )
    except Exception:  # noqa: BLE001 — dispatch is always best-effort
        logger.exception("workspace event dispatch failed (%s)", event)


__all__ = [
    "emit_workspace_event",
    "EVENT_FILE_ADDED",
    "EVENT_CARD_MOVED",
    "EVENT_ITEM_CREATED",
]
