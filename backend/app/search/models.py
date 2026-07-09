"""Search provider ORM model."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class SearchProvider(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "search_providers"

    # NULL user_id = system default.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )

    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # searxng | brave | tavily | google_pse
    type: Mapped[str] = mapped_column(String(32), nullable=False)

    # {url, api_key (encrypted), result_count, ...}
    config: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )

    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    # Admin-arranged failover order — lower is tried first (0153). Ties break
    # on created_at so the chain is deterministic.
    position: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Auto-backoff: when a provider fails with a hard error (auth/quota) the
    # failover layer sets this to now + a week and records ``last_error``;
    # the provider is skipped until then. Admin can clear it early ("Resume").
    cooldown_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)

    def __repr__(self) -> str:
        return f"<SearchProvider id={self.id} name={self.name!r} type={self.type}>"
