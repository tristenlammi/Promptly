"""ORM models for the email integration (Phase 12 — E.1)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class EmailAccount(Base):
    """One connected mailbox per user per provider."""

    __tablename__ = "email_accounts"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)  # google | microsoft
    email_address: Mapped[str] = mapped_column(String(320), nullable=False)
    # Fernet-encrypted JSON: {access_token, refresh_token, expiry_iso}
    oauth_tokens_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    scopes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Gmail incremental sync cursor (historyId). NULL forces a full resync.
    history_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sync_cursor_expired: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Indexed — claimed by the email scheduler
    next_sync_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    # Google Calendar incremental sync cursor (nextSyncToken)
    calendar_sync_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    messages: Mapped[list[EmailMessage]] = relationship(
        "EmailMessage", back_populates="account", passive_deletes=True
    )
    calendar_events: Mapped[list[CalendarEvent]] = relationship(
        "CalendarEvent", back_populates="account", passive_deletes=True
    )

    @property
    def needs_full_resync(self) -> bool:
        return self.history_id is None or self.sync_cursor_expired


class EmailMessage(Base):
    """A single mirrored email message with AI triage fields."""

    __tablename__ = "email_messages"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Denormalised for fast per-user queries without joining through accounts
    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider_message_id: Mapped[str] = mapped_column(String(256), nullable=False)
    thread_id: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    subject: Mapped[str | None] = mapped_column(Text, nullable=True)
    from_address: Mapped[str | None] = mapped_column(String(320), nullable=True)
    from_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    to_addresses: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )
    cc_addresses: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )
    date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    snippet: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Bodies pruned to NULL after retention_days; metadata + embeddings kept.
    body_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_html: Mapped[str | None] = mapped_column(Text, nullable=True)
    has_attachments: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # UUIDs of UserFile rows in the Email Attachments system folder
    attachment_file_ids: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )
    provider_labels: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )
    # Two-way sync state (mirrors Gmail)
    read: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Pending writeback flags set when user acts in Promptly; picked up next sync
    writeback_read: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    writeback_archived: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    # AI triage (populated by triage.py)
    ai_category: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ai_priority: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    needs_reply: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    triaged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    triage_skipped_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    account: Mapped[EmailAccount] = relationship("EmailAccount", back_populates="messages")
    chunks: Mapped[list[EmailChunk]] = relationship(
        "EmailChunk", back_populates="email", passive_deletes=True
    )

    @property
    def needs_triage(self) -> bool:
        return self.triaged_at is None and self.triage_skipped_reason is None


class EmailContact(Base):
    """Derived contact list — one row per unique (user, address) pair."""

    __tablename__ = "email_contacts"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    email_address: Mapped[str] = mapped_column(String(320), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    is_vip: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    message_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class EmailChunk(Base):
    """pgvector RAG chunk for an email message.

    Mirrors the knowledge_chunks pattern (dual 768/1536 columns, HNSW cosine
    indexes). Vector columns are not declared here because SQLAlchemy doesn't
    know the pgvector type natively — they're written via raw SQL in the
    indexer and migration.
    """

    __tablename__ = "email_chunks"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    tokens: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    embedding_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    embed_dim: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Provenance injected into retrieved context blocks
    chunk_metadata: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="'{}'::jsonb"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    email: Mapped[EmailMessage] = relationship("EmailMessage", back_populates="chunks")


class CalendarEvent(Base):
    """A mirrored Google Calendar event (read-only sync)."""

    __tablename__ = "calendar_events"

    id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("email_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider_event_id: Mapped[str] = mapped_column(String(256), nullable=False)
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    all_day: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    attendees: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="'[]'::jsonb"
    )
    meet_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    account: Mapped[EmailAccount] = relationship("EmailAccount", back_populates="calendar_events")
