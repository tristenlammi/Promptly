"""Which connectors a workspace's chats can use.

Mounted under ``/api/workspaces``. Global connectors work everywhere;
restricted ones work in a workspace once attached — by an admin (Admin →
Connectors) or by the workspace's owner or admins, who can only attach
connectors they can reach themselves. Attaching shares that connector, with
its credential, with everyone in the workspace. Members can read the list.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.mcp.models import McpConnector, WorkspaceMcpConnector
from app.mcp.service import connectors_for_turn
from app.workspaces.shares import get_accessible_workspace

router = APIRouter()


class WorkspaceConnector(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    enabled: bool
    tool_count: int
    attached: bool
    # "global" connectors work in every chat; "restricted" ones only where
    # attached (or for people granted them directly).
    availability: str
    attached_by_admin: bool = False
    # Whether *this* viewer can switch it, and if not, why — the tab used
    # to show the viewer's own grants, not what the workspace has (R-156).
    can_change: bool = False
    reason: str | None = None


class SetConnectorsRequest(BaseModel):
    connector_ids: list[uuid.UUID]


async def _can_manage(db: AsyncSession, workspace_id: uuid.UUID, user: User) -> bool:
    from app.workspaces.shares import workspace_role

    return (await workspace_role(db, workspace_id, user)) in ("owner", "admin")


@router.get(
    "/{workspace_id}/connectors", response_model=list[WorkspaceConnector]
)
async def list_workspace_connectors(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceConnector]:
    """What this workspace's chats can reach: global connectors, the
    restricted ones attached here, and — for its owner and admins — the
    restricted ones they could attach."""
    await get_accessible_workspace(workspace_id, user, db)
    manager = await _can_manage(db, workspace_id, user)

    rows = (
        await db.execute(
            select(WorkspaceMcpConnector).where(
                WorkspaceMcpConnector.workspace_id == workspace_id
            )
        )
    ).scalars().all()
    attached = {r.connector_id: r for r in rows}
    # Attaching shares a restricted connector with the whole workspace, so
    # only connectors the manager can personally reach may be attached.
    reachable = {c.id for c in await connectors_for_turn(db, user_id=user.id)}

    connectors = (
        await db.execute(
            select(McpConnector).where(
                (McpConnector.availability == "global")
                | McpConnector.id.in_(set(attached) | reachable)
            )
        )
    ).scalars().all()

    out: list[WorkspaceConnector] = []
    for c in connectors:
        if c.availability == "global":
            if not c.enabled:
                continue
            out.append(
                WorkspaceConnector(
                    id=c.id, name=c.name, slug=c.slug, enabled=c.enabled,
                    tool_count=len(c.tool_catalog or []), attached=True,
                    availability="global", can_change=False,
                    reason="Available in every chat — set by an admin.",
                )
            )
            continue
        row = attached.get(c.id)
        if row is None and not (manager and c.id in reachable):
            continue
        if row is not None and row.attached_by_admin:
            can_change, reason = False, "Attached by an admin."
        elif not manager:
            can_change, reason = False, "Only the workspace's owner and admins can change this."
        elif c.id not in reachable:
            can_change, reason = False, "Attached by someone with access you don't have."
        else:
            can_change, reason = True, None
        out.append(
            WorkspaceConnector(
                id=c.id, name=c.name, slug=c.slug, enabled=c.enabled,
                tool_count=len(c.tool_catalog or []), attached=row is not None,
                availability="restricted",
                attached_by_admin=bool(row and row.attached_by_admin),
                can_change=can_change, reason=reason,
            )
        )
    out.sort(key=lambda x: (x.availability != "global", x.name.lower()))
    return out


@router.put("/{workspace_id}/connectors", status_code=204)
async def set_workspace_connectors(
    workspace_id: uuid.UUID,
    payload: SetConnectorsRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Attach and detach the restricted connectors the caller is allowed
    to manage. Everything else — rows an admin attached, rows for
    connectors the caller can't reach — is left exactly as it was."""
    await get_accessible_workspace(workspace_id, user, db)
    if not await _can_manage(db, workspace_id, user):
        raise HTTPException(
            status_code=403,
            detail="Only the workspace's owner and admins can change its connectors.",
        )
    manageable = {
        c.id
        for c in await connectors_for_turn(db, user_id=user.id)
        if c.availability == "restricted"
    }
    rows = (
        await db.execute(
            select(WorkspaceMcpConnector).where(
                WorkspaceMcpConnector.workspace_id == workspace_id
            )
        )
    ).scalars().all()
    attached = {r.connector_id: r for r in rows}
    wanted = set(payload.connector_ids or []) & manageable

    for cid, row in attached.items():
        if cid in manageable and cid not in wanted and not row.attached_by_admin:
            await db.delete(row)
    for cid in wanted - set(attached):
        db.add(WorkspaceMcpConnector(workspace_id=workspace_id, connector_id=cid))
    await db.commit()
