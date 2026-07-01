"""Persistence + reversibility for Task flow graphs (Automations Phase 1).

Keeps the Simple (columns) and Advanced (``tasks.flow_graph`` JSONB)
representations coherent, so a task can move between them without a second
data model. See :mod:`app.tasks.flow_graph` for the graph schema.
"""
from __future__ import annotations

import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.tasks.flow_graph import (
    AIPromptData,
    FlowGraph,
    graph_to_task_fields,
    is_linear_flow,
    is_simple_graph,
    ordered_ai_nodes,
    task_to_graph,
)
from app.tasks.models import Task, TaskConnector


async def _selected_connector_ids(
    db: AsyncSession, task_id: uuid.UUID
) -> list[uuid.UUID]:
    return list(
        (
            await db.execute(
                select(TaskConnector.connector_id).where(
                    TaskConnector.task_id == task_id
                )
            )
        )
        .scalars()
        .all()
    )


async def load_or_derive_graph(db: AsyncSession, task: Task) -> FlowGraph:
    """The task's flow graph: the stored Advanced graph if present, else the
    canonical ``trigger → AI → output`` graph derived from the Simple columns."""
    if task.flow_graph:
        return FlowGraph.model_validate(task.flow_graph)
    cids = await _selected_connector_ids(db, task.id)
    return task_to_graph(task, cids)


async def _sync_task_connectors(
    db: AsyncSession, task: Task, connector_ids: set[uuid.UUID]
) -> None:
    await db.execute(
        delete(TaskConnector).where(TaskConnector.task_id == task.id)
    )
    for cid in connector_ids:
        db.add(TaskConnector(task_id=task.id, connector_id=cid))


async def apply_graph(db: AsyncSession, task: Task, graph: FlowGraph) -> None:
    """Persist an edited graph onto the task.

    * A graph in ``simple`` mode that is structurally a single-AI flow writes
      back the task columns and clears ``flow_graph`` — it stays a reversible
      Simple task.
    * Any other (still linear) graph is stored in ``flow_graph`` as the source
      of truth, while the columns are kept as a faithful *projection* of the
      first AI node so column-only consumers (list view, scheduler labels)
      still show a sensible model + prompt.

    Raises ``ValueError`` if the graph isn't an executable linear flow.
    """
    if not is_linear_flow(graph):
        raise ValueError(
            "Only linear flows (trigger → one or more AI steps → output) are "
            "supported for now."
        )

    if graph.mode == "simple" and is_simple_graph(graph):
        f = graph_to_task_fields(graph)
        task.frequency = f.frequency
        task.hour = f.hour
        task.minute = f.minute
        task.weekday = f.weekday
        task.day_of_month = f.day_of_month
        task.timezone = f.timezone
        task.prompt = f.prompt
        task.provider_id = f.provider_id
        task.model_id = f.model_id
        task.reasoning_effort = f.reasoning_effort
        task.use_web_search = f.use_web_search
        task.notify = f.notify
        task.flow_graph = None
        await _sync_task_connectors(db, task, set(f.connector_ids))
        return

    # Advanced flow. Store the graph; project the first AI node onto the
    # columns so column-only consumers stay sane, and grant the union of every
    # AI step's connectors so the whole chain can reach its tools.
    ai_nodes = ordered_ai_nodes(graph)
    first = AIPromptData.model_validate(ai_nodes[0].data)
    task.prompt = first.prompt
    task.provider_id = uuid.UUID(first.provider_id) if first.provider_id else None
    task.model_id = first.model_id
    task.reasoning_effort = first.reasoning_effort
    task.use_web_search = first.use_web_search
    task.flow_graph = graph.model_dump(mode="json")

    union: set[uuid.UUID] = set()
    for n in ai_nodes:
        for c in AIPromptData.model_validate(n.data).connector_ids:
            union.add(uuid.UUID(c))
    await _sync_task_connectors(db, task, union)


async def promote_task(db: AsyncSession, task: Task) -> FlowGraph:
    """Materialise the derived graph as a stored Advanced graph (``mode`` flips
    to ``advanced``) so the editor has an explicit graph to edit. Idempotent:
    returns the existing graph if the task is already advanced."""
    graph = await load_or_derive_graph(db, task)
    graph.mode = "advanced"
    task.flow_graph = graph.model_dump(mode="json")
    return graph


__all__ = ["load_or_derive_graph", "apply_graph", "promote_task"]
