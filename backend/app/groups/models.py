"""ORM models for user groups (Phase 10 — Groups)."""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import TimestampMixin, UUIDPKMixin


class UserGroup(UUIDPKMixin, TimestampMixin, Base):
    """A named set of users an admin manages — e.g. "Network Engineers".

    Acts as a *role bundle*: it scopes which connectors a member can reach
    (identity-based) AND grants a set of models (``allowed_models``) that is
    UNIONed into each member's own model access. (Inviting a whole team to a
    workspace in one action is a later use of the same group.)
    """

    __tablename__ = "user_groups"

    name: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Model ids this group grants every member (provider model ids like
    # "gpt-4o" and/or "custom:<uuid>"). Additive — UNIONed with the member's
    # own ``allowed_models``. Empty list = grants no models (connectors only).
    allowed_models: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )

    def __repr__(self) -> str:
        return f"<UserGroup name={self.name!r}>"


class UserGroupMember(Base):
    """Membership join: a user belongs to a group."""

    __tablename__ = "user_group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_groups.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
