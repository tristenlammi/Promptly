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
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.database import get_db
from app.mcp.client import McpError, fetch_tools
from app.mcp.models import McpConnector
from app.mcp.service import refresh_catalog, slugify

logger = logging.getLogger("promptly.mcp.router")

router = APIRouter()


# ----- Schemas -----------------------------------------------------------
class ConnectorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=2000)
    auth_header_name: str | None = Field(default=None, max_length=64)
    auth_value: str | None = Field(default=None, max_length=4000)
    availability: str = "global"
    allowed_tools: list[str] | None = None


class ConnectorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    url: str | None = Field(default=None, min_length=1, max_length=2000)
    auth_header_name: str | None = Field(default=None, max_length=64)
    # Send a new value to replace; omit to keep; empty string clears.
    auth_value: str | None = Field(default=None, max_length=4000)
    enabled: bool | None = None
    availability: str | None = None
    allowed_tools: list[str] | None = None


class ToolInfo(BaseModel):
    name: str
    description: str = ""
    annotations: dict[str, Any] = {}


class ConnectorResponse(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    url: str
    has_auth: bool
    auth_header_name: str | None
    enabled: bool
    availability: str
    allowed_tools: list[str] | None
    tools: list[ToolInfo]
    tools_refreshed_at: datetime | None
    created_at: datetime


def _to_response(c: McpConnector) -> ConnectorResponse:
    return ConnectorResponse(
        id=c.id,
        name=c.name,
        slug=c.slug,
        url=c.url,
        has_auth=bool(c.auth_value_encrypted),
        auth_header_name=c.auth_header_name,
        enabled=c.enabled,
        availability=c.availability,
        allowed_tools=c.allowed_tools,
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
    if v not in ("global", "workspace"):
        raise HTTPException(status_code=400, detail="availability must be 'global' or 'workspace'")
    return v


# ----- Endpoints ---------------------------------------------------------
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
    return [_to_response(c) for c in rows]


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
    connector = McpConnector(
        name=payload.name.strip(),
        slug=await _unique_slug(db, payload.name),
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

    # Best-effort initial tool discovery so the admin sees what they got.
    try:
        await refresh_catalog(db, connector)
        await db.refresh(connector)
    except McpError as e:
        logger.info("mcp create: catalog refresh failed for %s: %s", connector.slug, e)
    return _to_response(connector)


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
    await db.commit()
    await db.refresh(c)
    return _to_response(c)


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
    auth_header_name: str | None = Field(default=None, max_length=64)
    auth_value: str | None = Field(default=None, max_length=4000)


@router.post("/test")
async def test_connection(
    payload: TestRequest,
    _: User = Depends(require_admin),
) -> dict:
    """Probe a server without saving — returns the discovered tools or a
    clean error so the admin can validate before creating the connector."""
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
