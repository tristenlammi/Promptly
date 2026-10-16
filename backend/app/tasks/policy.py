"""What an automation may do, decided for its owner — at save and at run time.

Chat checks the person every turn: which models they may use, whether
they're still in the workspace, which connector tools they may call. The
automation path checked none of it, so an automation kept every capability
its owner ever had, whatever happened since (R-006, R-007, R-008/R-015,
R-011). :func:`problems` is the one list of checks; saving refuses with it
(422), and a run started without them fails with it.
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.tasks.flow_graph import FlowGraph, NodeType
from app.tasks.models import Task

WRITE_ROLES = ("owner", "admin", "editor")


class FlowPolicyError(ValueError):
    """``str(e)`` lists what's wrong, in words fit for the editor."""


def _node_name(node) -> str:
    label = str((node.data or {}).get("label") or "").strip()
    return f"“{label}”" if label else f"the {node.type} step"


async def _model_problem(db: AsyncSession, user: User, model_id: str | None) -> str | None:
    if not model_id:
        return None
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model
    from app.models_config.access import is_model_allowed

    base = model_id
    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        if resolved is None:
            return f"The assistant {model_id!r} no longer exists."
        base = resolved.base_model_id
    if not await is_model_allowed(user, db, model_id=model_id, base_model_id=base):
        return f"You don't have access to the model {model_id!r}."
    return None


async def problems(
    db: AsyncSession, *, user: User, task: Task, graph: FlowGraph | None
) -> list[str]:
    """Every reason ``user`` can't save or run ``task`` (with ``graph``)."""
    from app.mcp.service import McpError, authorize_connector_tool
    from app.net.internal_hosts import may_reach_private_network
    from app.workspaces.shares import workspace_role

    out: list[str] = []

    # Workspace: the owner must still be a member who can change content —
    # automations write cards, notes and messages into it (R-007).
    if task.workspace_id is not None:
        role = await workspace_role(db, task.workspace_id, user)
        if role is None:
            out.append("You're no longer a member of this automation's workspace.")
        elif role not in WRITE_ROLES:
            out.append(
                "Viewers can't run automations in a workspace — ask an owner "
                "or admin to make you an editor."
            )

    # Models: the task's own, and any a step picks (R-011).
    seen: set[str] = set()
    for model_id in [task.model_id] + [
        str((n.data or {}).get("model_id") or "") for n in (graph.nodes if graph else [])
    ]:
        if model_id and model_id not in seen:
            seen.add(model_id)
            p = await _model_problem(db, user, model_id)
            if p:
                out.append(p)

    for node in graph.nodes if graph else []:
        data = node.data or {}
        if node.type == NodeType.HTTP_REQUEST and data.get("allow_private_network"):
            if not may_reach_private_network(user):
                out.append(
                    f"{_node_name(node)} is set to reach your own network, which "
                    "needs an admin to allow it for your account."
                )
        elif node.type == NodeType.MCP_ACTION and data.get("connector_id") and data.get("tool_name"):
            try:
                cid = uuid.UUID(str(data["connector_id"]))
            except ValueError:
                out.append(f"{_node_name(node)} points at an invalid connector.")
                continue
            try:
                await authorize_connector_tool(
                    db, user_id=user.id, workspace_id=task.workspace_id,
                    connector_id=cid, real_tool=str(data["tool_name"]),
                )
            except McpError as e:
                out.append(f"{_node_name(node)}: {e}")
    return out


async def check(db: AsyncSession, *, user: User, task: Task, graph: FlowGraph | None) -> None:
    """Raise :class:`FlowPolicyError` listing every problem, if any."""
    found = await problems(db, user=user, task=task, graph=graph)
    if found:
        raise FlowPolicyError(" ".join(found))


__all__ = ["FlowPolicyError", "WRITE_ROLES", "check", "problems"]
