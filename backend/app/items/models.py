"""Items (the Item Store) — ORM.

An *item* is a small app whose whole state lives in one file: a workout
log, a budget, a deck of flashcards. The ``files`` row is its identity in
Drive (``source_kind='item'``, a shell like a Sheet: shareable, starrable,
trashable, counted against quota, downloadable as JSON); the state itself
is :class:`ItemDocument` — validated JSON with a revision number.

* :class:`ItemDocument` — the file's content (``data``), its item kind and
  schema version, and ``revision`` (bumped on every save; a save from an
  older revision is refused with the newer state so the client can replay
  its change on top).
* :class:`ItemInstall` — the items a person added from the Store. Nothing
  is on by default.
* :class:`ItemReminder` — upcoming nudges an item asked for (a habit, a
  med dose, a flight), derived from the file on every save and sent by the
  reminder loop. The file stays the source of truth: these are recomputed.
* :class:`ItemState` — server-only state an item keeps beside its file and
  never in it: sync cursors, a bank token (encrypted), the AI panel's
  thread. Keyed by file + key.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ItemDocument(Base):
    __tablename__ = "item_documents"

    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # The last time the item's background job ran for this file.
    periodic_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Office shells answer ``workspace_id`` (access checks read it); items
    # are personal files for now.
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)

    @property
    def yjs_update(self) -> bytes:  # pragma: no cover — shell helpers probe it
        return b""


class ItemInstall(Base):
    __tablename__ = "item_installs"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(48), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ItemReminder(Base):
    __tablename__ = "item_reminders"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # Stable per occurrence ("habit:abc:2026-11-02") so a recompute keeps a
    # reminder that was already sent instead of sending it again.
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ItemState(Base):
    __tablename__ = "item_state"

    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), primary_key=True
    )
    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    # ``value`` holds ``{"v": <Fernet ciphertext>}`` — read it through
    # :func:`app.items.service.get_state` with ``secret=True``.
    secret: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
