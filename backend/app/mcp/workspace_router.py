"""Workspace-owner API for attaching ``restricted`` MCP connectors.

Mounted under ``/api/workspaces``. Admins define connectors + mark them
``availability="restricted"``; a workspace **owner** then chooses which of
those to switch on for their workspace (writing the
``workspace_mcp_connectors`` join). Members can read the list.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.mcp.models import McpConnector, WorkspaceMcpConnector
from app.workspaces.shares import (
    get_accessible_workspace,
    is_owner_of_workspace,
)

router = APIRouter()


class WorkspaceConnector(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    enabled: bool
    tool_count: int
    attached: bool


class SetConnectorsRequest(BaseModel):
    connector_ids: list[uuid.UUID]


@router.get(
    "/{workspace_id}/connectors", response_model=list[WorkspaceConnector]
)
async def list_workspace_connectors(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceConnector]:
    await get_accessible_workspace(workspace_id, user, db)

    # Only the user's OWN org's restricted connectors are attachable/visible.
    if user.org_id is None:
        connectors = []
    else:
        connectors = (
            (
                await db.execute(
                    select(McpConnector).where(
                        McpConnector.availability == "restricted",
                        McpConnector.org_id == user.org_id,
                    )
                )
            )
            .scalars()
            .all()
        )
    attached_ids = set(
        (
            await db.execute(
                select(WorkspaceMcpConnector.connector_id).where(
                    WorkspaceMcpConnector.workspace_id == workspace_id
                )
            )
        )
        .scalars()
        .all()
    )
    return [
        WorkspaceConnector(
            id=c.id,
            name=c.name,
            slug=c.slug,
            enabled=c.enabled,
            tool_count=len(c.tool_catalog or []),
            attached=c.id in attached_ids,
        )
        for c in connectors
    ]


@router.put("/{workspace_id}/connectors", status_code=204)
async def set_workspace_connectors(
    workspace_id: uuid.UUID,
    payload: SetConnectorsRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Only the owner reshapes which connectors a workspace uses.
    await is_owner_of_workspace(workspace_id, user, db)

    # Keep only ids that exist, are restricted, AND belong to the owner's org
    # — silently drop anything stale/global/other-tenant so a bad id can't 500
    # the call or attach a connector the org doesn't own.
    valid: set[uuid.UUID] = set()
    if user.org_id is not None:
        valid = set(
            (
                await db.execute(
                    select(McpConnector.id).where(
                        McpConnector.id.in_(payload.connector_ids or []),
                        McpConnector.availability == "restricted",
                        McpConnector.org_id == user.org_id,
                    )
                )
            )
            .scalars()
            .all()
        )
    await db.execute(
        delete(WorkspaceMcpConnector).where(
            WorkspaceMcpConnector.workspace_id == workspace_id
        )
    )
    for cid in valid:
        db.add(
            WorkspaceMcpConnector(workspace_id=workspace_id, connector_id=cid)
        )
    await db.commit()
