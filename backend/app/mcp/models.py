"""ORM models for MCP connectors (Phase 10a).

An ``McpConnector`` is an admin-configured remote MCP server. Its discovered
tool catalog is cached on the row; auth (if any) is a single HTTP header
whose value is Fernet-encrypted at rest (same as provider API keys). The
``availability`` field decides who can use it: ``global`` (everyone) or
``restricted`` — reachable via the user groups it's granted to (identity
scope, ``connector_groups``) and/or the workspaces it's attached to (context
scope, ``workspace_mcp_connectors``).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import TimestampMixin, UUIDPKMixin


class McpConnector(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "mcp_connectors"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # Stable slug derived from the name; used to namespace tools as
    # ``mcp__<slug>__<tool>`` so two servers can't collide. Unique.
    slug: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    # Connector kind: 'mcp' (remote MCP server) | 'unifi' | 'omada' (native
    # first-party connectors that call an appliance's official API directly).
    # For native kinds the tool catalog is fixed and dispatch routes to our
    # own client instead of the MCP protocol.
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, default="mcp", server_default="mcp"
    )
    # The endpoint URL: an MCP server URL (kind=mcp) or the appliance's
    # console URL (kind=unifi/omada).
    url: Mapped[str] = mapped_column(Text, nullable=False)

    # Optional single auth header (e.g. ``Authorization``). The value is
    # Fernet-encrypted at rest; NULL header name = no auth.
    auth_header_name: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    auth_value_encrypted: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )

    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # 'global' | 'workspace'. (Group-restricted lands with the Groups phase.)
    availability: Mapped[str] = mapped_column(
        String(16), nullable=False, default="global", server_default="global"
    )

    # Per-tool allow-list (list of tool names the model may call). NULL =
    # every discovered tool is allowed; [] = none.
    allowed_tools: Mapped[list[str] | None] = mapped_column(
        JSONB, nullable=True
    )

    # Cached ``tools/list`` catalog: [{name, description, input_schema,
    # annotations}]. Refreshed on demand / on save.
    tool_catalog: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )
    tools_refreshed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    def __repr__(self) -> str:
        return f"<McpConnector slug={self.slug!r} url={self.url!r}>"


class WorkspaceMcpConnector(Base):
    """Join: which workspaces a restricted connector is attached to
    (context-based scope — its tools appear in chats inside those
    workspaces)."""

    __tablename__ = "workspace_mcp_connectors"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        primary_key=True,
    )
    connector_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mcp_connectors.id", ondelete="CASCADE"),
        primary_key=True,
    )


class ConnectorGroup(Base):
    """Join: which user groups a restricted connector is granted to
    (identity-based scope — members can use its tools in any chat)."""

    __tablename__ = "connector_groups"

    connector_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mcp_connectors.id", ondelete="CASCADE"),
        primary_key=True,
    )
    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_groups.id", ondelete="CASCADE"),
        primary_key=True,
    )
