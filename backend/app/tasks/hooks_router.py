"""Inbound webhooks for automations (Batch 5.2).

    POST /api/hooks/{task_id}/{secret}

The one unauthenticated door into the automations engine: CI pipelines,
form providers, monitoring alerts, Zapier — anything that can POST a URL
can start a flow. Safety model:

* The 64-char random ``secret`` (minted when a webhook trigger is saved,
  stored per task) is the credential. Wrong secret → 404, same as a
  wrong task id, so neither is probeable.
* Only fires for enabled tasks whose *stored* graph actually contains a
  ``trigger.webhook`` node — a leaked URL for a schedule-only task does
  nothing.
* Body is captured (capped) as the run's ``trigger_payload`` and reaches
  the flow as ``{{trigger.payload}}`` (JSON bodies additionally as
  ``{{trigger.json.<path>}}``).
* Flood guard: more than ``_MAX_QUEUED`` unfinished runs → 429. The
  retention sweep bounds history either way.
"""
from __future__ import annotations

import hmac
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.tasks.flow_graph import NodeType
from app.tasks.models import Task, TaskRun
from app.tasks.queue import enqueue_run

logger = logging.getLogger("promptly.tasks.hooks")

router = APIRouter()

_MAX_PAYLOAD_BYTES = 64 * 1024
_MAX_QUEUED = 10


class HookAccepted(BaseModel):
    ok: bool = True
    run_id: uuid.UUID


@router.post(
    "/{task_id}/{secret}",
    response_model=HookAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def fire_webhook(
    task_id: uuid.UUID,
    secret: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> HookAccepted:
    task = await db.get(Task, task_id)
    if (
        task is None
        or not task.webhook_secret
        # compare_digest so the secret can't be timing-probed.
        or not hmac.compare_digest(task.webhook_secret, secret)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if not task.enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This automation is paused.",
        )
    graph = task.flow_graph or {}
    if not any(
        n.get("type") == NodeType.TRIGGER_WEBHOOK
        for n in graph.get("nodes", [])
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    queued = await db.scalar(
        select(func.count())
        .select_from(TaskRun)
        .where(
            TaskRun.task_id == task.id,
            TaskRun.status.in_(("pending", "running")),
        )
    )
    if int(queued or 0) >= _MAX_QUEUED:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many runs already queued for this automation.",
        )

    raw = await request.body()
    payload = raw[:_MAX_PAYLOAD_BYTES].decode("utf-8", errors="replace")

    run = TaskRun(
        task_id=task.id,
        status="pending",
        trigger="webhook",
        trigger_payload=payload or None,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    await enqueue_run(run.id)
    logger.info("webhook fired task=%s run=%s", task.id, run.id)
    return HookAccepted(run_id=run.id)


__all__ = ["router"]
