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
from app.mcp.service import connectors_for_turn
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

    # Only surface restricted connectors the caller can PERSONALLY reach
    # (granted directly or via a group). On a multi-user host, listing every
    # restricted connector to any workspace owner — and letting them attach it
    # — would defeat the admin's per-user/group scoping. The attach endpoint
    # enforces the same set.
    reachable = await connectors_for_turn(db, user_id=user.id)
    connectors = [c for c in reachable if c.availability == "restricted"]
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

    # Keep only restricted connectors the OWNER can personally reach (granted
    # directly or via a group). Anything else — stale, global, or granted to
    # someone else — is silently dropped, so attaching can't bypass the admin's
    # per-user/group scoping on a multi-user host.
    reachable_restricted = {
        c.id
        for c in await connectors_for_turn(db, user_id=user.id)
        if c.availability == "restricted"
    }
    valid: set[uuid.UUID] = {
        cid for cid in (payload.connector_ids or []) if cid in reachable_restricted
    }
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
