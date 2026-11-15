"""Promptly Home (``app/home``): homes, who lives in them, and their boxes.

A **home** is a household: its members see and control its devices. A **box**
is the small computer in that home which runs Home Assistant (out of sight)
and our connector; the connector dials out to this server
(``relay.py``). A box is prepared by an admin, handed over, and **claimed**
into a home with the code on its card.

Everything about a home's devices is the home's own: an admin can prepare,
revoke and list boxes, and never sees which home one went to or what's in it.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin

ROLES = ("owner", "adult", "guest")


class Home(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "homes"

    name: Mapped[str] = mapped_column(String(80), nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)


class HomeMember(Base):
    """owner: everything. adult: devices, and adding a box. guest: devices only."""

    __tablename__ = "home_members"

    home_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("homes.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(8), nullable=False, default="adult", server_default="adult")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class HomeBox(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "home_boxes"

    # The admin's own note when preparing it ("Sam's box"). Never shown to the home.
    label: Mapped[str] = mapped_column(String(80), nullable=False, default="", server_default="")
    # What the home calls it ("Hallway cupboard").
    name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # sha256 of the key baked into the box when it was prepared: how the box
    # proves itself each time it dials in. Replaced by "new setup".
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # sha256 of the code on the card. NULL once claimed (single use).
    claim_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    home_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("homes.id", ondelete="SET NULL"), nullable=True, index=True)
    claimed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # The home's devices as last heard, so the page can show them greyed
    # while the box is offline. The home's own; cleared when it leaves a home.
    snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
