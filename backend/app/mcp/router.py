"""Admin API for MCP connectors (Phase 10a). Mounted under /api/admin/mcp.

All endpoints require ``role == "admin"``. Auth secrets are Fernet-encrypted
on write and **never** returned (responses expose only ``has_auth``). Every
connector URL passes the SSRF guard (inside the client) before we connect.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.database import get_db
from app.mcp.client import McpError, fetch_tools
from app.mcp.models import (
    ConnectorGroup,
    McpConnector,
    WorkspaceMcpConnector,
)
from app.mcp.service import refresh_catalog, slugify

logger = logging.getLogger("promptly.mcp.router")

router = APIRouter()


# ----- Schemas -----------------------------------------------------------
class ConnectorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=2000)
    kind: str = "mcp"  # 'mcp' | 'unifi'
    auth_header_name: str | None = Field(default=None, max_length=64)
    auth_value: str | None = Field(default=None, max_length=4000)
    availability: str = "global"  # 'global' | 'restricted'
    allowed_tools: list[str] | None = None
    # When restricted: which groups (identity) and workspaces (context) it
    # reaches. Ignored when availability == 'global'.
    group_ids: list[uuid.UUID] = []
    workspace_ids: list[uuid.UUID] = []


class ConnectorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    url: str | None = Field(default=None, min_length=1, max_length=2000)
    auth_header_name: str | None = Field(default=None, max_length=64)
    # Send a new value to replace; omit to keep; empty string clears.
    auth_value: str | None = Field(default=None, max_length=4000)
    enabled: bool | None = None
    availability: str | None = None
    allowed_tools: list[str] | None = None
    # Omit to leave scoping unchanged; send (possibly empty) lists to replace.
    group_ids: list[uuid.UUID] | None = None
    workspace_ids: list[uuid.UUID] | None = None


class ToolInfo(BaseModel):
    name: str
    description: str = ""
    annotations: dict[str, Any] = {}


class ConnectorResponse(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    kind: str
    url: str
    has_auth: bool
    auth_header_name: str | None
    enabled: bool
    availability: str
    allowed_tools: list[str] | None
    group_ids: list[uuid.UUID]
    workspace_ids: list[uuid.UUID]
    tools: list[ToolInfo]
    tools_refreshed_at: datetime | None
    created_at: datetime


async def _scope_ids(
    db: AsyncSession, connector_id: uuid.UUID
) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
    groups = (
        (
            await db.execute(
                select(ConnectorGroup.group_id).where(
                    ConnectorGroup.connector_id == connector_id
                )
            )
        )
        .scalars()
        .all()
    )
    workspaces = (
        (
            await db.execute(
                select(WorkspaceMcpConnector.workspace_id).where(
                    WorkspaceMcpConnector.connector_id == connector_id
                )
            )
        )
        .scalars()
        .all()
    )
    return list(groups), list(workspaces)


async def _set_groups(
    db: AsyncSession, connector_id: uuid.UUID, group_ids: list[uuid.UUID]
) -> None:
    await db.execute(
        delete(ConnectorGroup).where(
            ConnectorGroup.connector_id == connector_id
        )
    )
    for gid in dict.fromkeys(group_ids):
        db.add(ConnectorGroup(connector_id=connector_id, group_id=gid))


async def _set_workspaces(
    db: AsyncSession, connector_id: uuid.UUID, workspace_ids: list[uuid.UUID]
) -> None:
    await db.execute(
        delete(WorkspaceMcpConnector).where(
            WorkspaceMcpConnector.connector_id == connector_id
        )
    )
    for wid in dict.fromkeys(workspace_ids):
        db.add(
            WorkspaceMcpConnector(connector_id=connector_id, workspace_id=wid)
        )


async def _to_response(
    db: AsyncSession, c: McpConnector
) -> ConnectorResponse:
    group_ids, workspace_ids = await _scope_ids(db, c.id)
    return ConnectorResponse(
        id=c.id,
        name=c.name,
        slug=c.slug,
        kind=c.kind,
        url=c.url,
        has_auth=bool(c.auth_value_encrypted),
        auth_header_name=c.auth_header_name,
        enabled=c.enabled,
        availability=c.availability,
        allowed_tools=c.allowed_tools,
        group_ids=group_ids,
        workspace_ids=workspace_ids,
        tools=[
            ToolInfo(
                name=t.get("name", ""),
                description=t.get("description", "") or "",
                annotations=t.get("annotations") or {},
            )
            for t in (c.tool_catalog or [])
        ],
        tools_refreshed_at=c.tools_refreshed_at,
        created_at=c.created_at,
    )


async def _unique_slug(db: AsyncSession, name: str) -> str:
    base = slugify(name)
    slug = base
    i = 2
    while (
        await db.execute(select(McpConnector.id).where(McpConnector.slug == slug))
    ).first() is not None:
        slug = f"{base[:36]}-{i}"
        i += 1
    return slug


def _valid_availability(v: str) -> str:
    if v not in ("global", "restricted"):
        raise HTTPException(status_code=400, detail="availability must be 'global' or 'restricted'")
    return v


# ----- Endpoints ---------------------------------------------------------
class WorkspaceOption(BaseModel):
    id: uuid.UUID
    title: str
    owner: str | None = None


@router.get("/workspaces", response_model=list[WorkspaceOption])
async def list_all_workspaces(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[WorkspaceOption]:
    """Every workspace (id + title + owner) — feeds the connector scoping
    selector so an admin can attach a restricted connector to specific
    workspaces."""
    from app.chat.models import Workspace

    rows = (
        await db.execute(
            select(Workspace.id, Workspace.title, User.username)
            .join(User, User.id == Workspace.user_id, isouter=True)
            .order_by(Workspace.title.asc())
        )
    ).all()
    return [
        WorkspaceOption(id=r[0], title=r[1], owner=r[2]) for r in rows
    ]


@router.get("/connectors", response_model=list[ConnectorResponse])
async def list_connectors(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[ConnectorResponse]:
    rows = (
        (await db.execute(select(McpConnector).order_by(McpConnector.created_at.asc())))
        .scalars()
        .all()
    )
    return [await _to_response(db, c) for c in rows]


@router.post(
    "/connectors",
    response_model=ConnectorResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_connector(
    payload: ConnectorCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> ConnectorResponse:
    _valid_availability(payload.availability)
    if payload.kind not in ("mcp", "unifi"):
        raise HTTPException(status_code=400, detail="Unsupported connector kind")
    connector = McpConnector(
        name=payload.name.strip(),
        slug=await _unique_slug(db, payload.name),
        kind=payload.kind,
        url=payload.url.strip(),
        auth_header_name=(payload.auth_header_name or None),
        auth_value_encrypted=(
            encrypt_secret(payload.auth_value)
            if payload.auth_value
            else None
        ),
        availability=payload.availability,
        allowed_tools=payload.allowed_tools,
        created_by=admin.id,
    )
    db.add(connector)
    try:
        await db.commit()
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A connector with that name exists") from e
    await db.refresh(connector)

    if payload.availability == "restricted":
        await _set_groups(db, connector.id, payload.group_ids)
        await _set_workspaces(db, connector.id, payload.workspace_ids)
        await db.commit()

    # Best-effort initial tool discovery so the admin sees what they got.
    try:
        await refresh_catalog(db, connector)
        await db.refresh(connector)
    except McpError as e:
        logger.info("mcp create: catalog refresh failed for %s: %s", connector.slug, e)
    return await _to_response(db, connector)


@router.patch("/connectors/{connector_id}", response_model=ConnectorResponse)
async def update_connector(
    connector_id: uuid.UUID,
    payload: ConnectorUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> ConnectorResponse:
    c = await db.get(McpConnector, connector_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Connector not found")
    if payload.name is not None:
        c.name = payload.name.strip()
    if payload.url is not None:
        c.url = payload.url.strip()
    if payload.auth_header_name is not None:
        c.auth_header_name = payload.auth_header_name or None
    if payload.auth_value is not None:
        # Empty string clears the secret; a value replaces it.
        c.auth_value_encrypted = (
            encrypt_secret(payload.auth_value) if payload.auth_value else None
        )
    if payload.enabled is not None:
        c.enabled = payload.enabled
    if payload.availability is not None:
        c.availability = _valid_availability(payload.availability)
    if payload.allowed_tools is not None:
        c.allowed_tools = payload.allowed_tools
    if payload.group_ids is not None:
        await _set_groups(db, c.id, payload.group_ids)
    if payload.workspace_ids is not None:
        await _set_workspaces(db, c.id, payload.workspace_ids)
    # Going back to global drops any restricted scoping so it can't linger.
    if c.availability == "global":
        await _set_groups(db, c.id, [])
        await _set_workspaces(db, c.id, [])
    await db.commit()
    await db.refresh(c)
    return await _to_response(db, c)


@router.delete(
    "/connectors/{connector_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_connector(
    connector_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    c = await db.get(McpConnector, connector_id)
    if c is not None:
        await db.delete(c)
        await db.commit()


@router.post("/connectors/{connector_id}/refresh", response_model=ConnectorResponse)
async def refresh_connector(
    connector_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> ConnectorResponse:
    c = await db.get(McpConnector, connector_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Connector not found")
    try:
        await refresh_catalog(db, c)
    except McpError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    await db.refresh(c)
    return _to_response(c)


class TestRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    kind: str = "mcp"
    auth_header_name: str | None = Field(default=None, max_length=64)
    auth_value: str | None = Field(default=None, max_length=4000)


@router.post("/test")
async def test_connection(
    payload: TestRequest,
    _: User = Depends(require_admin),
) -> dict:
    """Probe a connector without saving — returns the tools (or a clean
    error) so the admin can validate before creating it."""
    if payload.kind == "unifi":
        from app.mcp.unifi import UNIFI_TOOLS, UniFiError, probe

        try:
            count = await probe(payload.url.strip(), payload.auth_value or "")
        except UniFiError as e:
            return {"ok": False, "error": str(e), "tools": []}
        return {
            "ok": True,
            "detail": f"Connected — {count} site(s).",
            "tools": [
                {
                    "name": t["name"],
                    "description": t["description"],
                    "annotations": t["annotations"],
                }
                for t in UNIFI_TOOLS
            ],
        }

    headers: dict[str, str] = {}
    if payload.auth_header_name and payload.auth_value:
        headers[payload.auth_header_name] = payload.auth_value
    try:
        tools = await fetch_tools(payload.url.strip(), headers=headers)
    except McpError as e:
        return {"ok": False, "error": str(e), "tools": []}
    return {
        "ok": True,
        "tools": [
            {
                "name": t.get("name", ""),
                "description": t.get("description", "") or "",
                "annotations": t.get("annotations") or {},
            }
            for t in tools
        ],
    }
