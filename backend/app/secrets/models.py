"""Credentials vault (A1) — named encrypted values for automations.

A :class:`UserSecret` holds one API key / token, Fernet-encrypted at
rest with the same key-at-rest helpers the SMTP password and provider
keys use. Automations reference it as ``{{secret.NAME}}``; the value is
resolved **only** inside the HTTP-request node at execution time, is
never sent to an LLM, and is redacted from node run records before they
are persisted. No API ever returns the plaintext after creation.
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import TimestampMixin, UUIDPKMixin


class UserSecret(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "user_secrets"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_user_secrets_name"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Uppercase identifier (A-Z, 0-9, _) — what ``{{secret.NAME}}`` names.
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    value_encrypted: Mapped[str] = mapped_column(Text, nullable=False)


__all__ = ["UserSecret"]
