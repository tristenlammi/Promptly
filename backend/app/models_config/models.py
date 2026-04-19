"""Model provider ORM model."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import Boolean, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class ModelProvider(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "model_providers"

    # NULL user_id = system-wide provider (e.g. from env vars / admin defaults).
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )

    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # openrouter | anthropic | openai | ollama | openai_compatible
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    base_url: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # Fernet-encrypted at rest. See app.auth.utils.encrypt_secret.
    api_key: Mapped[str | None] = mapped_column(Text, nullable=True)

    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")

    # [{id, display_name, context_window, ...}] — the full catalog fetched
    # from the upstream provider (e.g. all 300+ OpenRouter models).
    models: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )

    # Optional whitelist of model IDs the user has curated for the chat
    # picker. NULL means "expose every model in `models`" (default for new
    # providers). An empty list means "expose none".
    enabled_models: Mapped[list[str] | None] = mapped_column(
        JSONB, nullable=True, default=None
    )

    def __repr__(self) -> str:
        return f"<ModelProvider id={self.id} name={self.name!r} type={self.type}>"
