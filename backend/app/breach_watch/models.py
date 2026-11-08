"""Breach alerts: the admin's key, who turned it on, their addresses, and what was found.

Per address, only the breach's name and dates. What a breach exposed is public and
the same for everyone, kept once in ``breach_watch_catalog``.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class BreachConfig(Base):
    """The admin's Have I Been Pwned key and what's known about it. One row."""

    __tablename__ = "breach_watch_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Fernet, like the SMTP password and the Maps traffic key. NULL: breach alerts are off.
    api_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    rpm: Mapped[int] = mapped_column(Integer, nullable=False, default=10, server_default="10")
    plan: Mapped[str | None] = mapped_column(String(60), nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(200), nullable=True)
    paused_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class BreachWatch(CreatedAtMixin, Base):
    """Someone who turned breach alerts on. No row: off."""

    __tablename__ = "breach_watch_people"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)


class BreachAddress(UUIDPKMixin, Base):
    """One of a watching person's addresses: their account's, or a connected Mail account's."""

    __tablename__ = "breach_watch_addresses"
    __table_args__ = (
        UniqueConstraint("user_id", "address", name="uq_breach_watch_addresses_user_address"),
        Index("ix_breach_watch_addresses_next", "next_check_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    address: Mapped[str] = mapped_column(String(320), nullable=False)
    source: Mapped[str] = mapped_column(String(10), nullable=False)  # account | mail
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_check_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class BreachHit(UUIDPKMixin, Base):
    """An address found in a breach: the breach's name and dates only."""

    __tablename__ = "breach_watch_hits"
    __table_args__ = (UniqueConstraint("user_id", "address", "name", name="uq_breach_watch_hits"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    address: Mapped[str] = mapped_column(String(320), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    breach_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    added_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    found_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class BreachCatalog(Base):
    """Public facts about a breach, as HIBP publishes them for everyone. Nothing about anyone."""

    __tablename__ = "breach_watch_catalog"

    name: Mapped[str] = mapped_column(String(200), primary_key=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    domain: Mapped[str] = mapped_column(String(200), nullable=False, default="", server_default="")
    data_classes: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


__all__ = ["BreachConfig", "BreachWatch", "BreachAddress", "BreachHit", "BreachCatalog"]
