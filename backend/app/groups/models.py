"""ORM models for user groups (Phase 10 — Groups)."""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import TimestampMixin, UUIDPKMixin


class UserGroup(UUIDPKMixin, TimestampMixin, Base):
    """A named set of users an admin manages — e.g. "Network Engineers".

    Used to scope which connectors a user can reach (identity-based), and
    (later) to invite a whole team to a workspace in one action.
    """

    __tablename__ = "user_groups"

    name: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
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
