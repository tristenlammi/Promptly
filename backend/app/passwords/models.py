"""Promptly Passwords: everything in these tables is opaque to the server.

Blobs are encrypted on the client (passwords/CRYPTO_SPEC.md). The server sees
sizes (padded into buckets), timestamps, revisions and who belongs to which
vault. It can't see titles, URLs, usernames, folders, tags or item types, and
nothing here may ever hold them. ``encrypt_secret`` is deliberately not used:
the server could decrypt that.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, LargeBinary, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class PwAccount(CreatedAtMixin, Base):
    """One per user. ``id`` is chosen by the client: blobs are bound to it."""

    __tablename__ = "pw_accounts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True)
    format_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    kdf: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    salt: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    auth_salt: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    auth_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    wrapped_keyset: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    x25519_pub: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    ed25519_pub: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    failed_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    kit_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    kit_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class PwDevice(UUIDPKMixin, CreatedAtMixin, Base):
    """A client holding its own token. Not an app password: those are Basic
    auth and survive "sign out everywhere"; this doesn't (``token_version``)."""

    __tablename__ = "pw_devices"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    scopes: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    token_version: Mapped[int] = mapped_column(Integer, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PwSession(UUIDPKMixin, CreatedAtMixin, Base):
    """Issued after proving ``auth_key``; needed on top of a Promptly identity
    for anything touching ciphertext. A stolen Promptly session alone gets nothing."""

    __tablename__ = "pw_sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    device_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("pw_devices.id", ondelete="CASCADE"), nullable=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    token_version: Mapped[int] = mapped_column(Integer, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    hard_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PwConnect(UUIDPKMixin, CreatedAtMixin, Base):
    """A client (extension, desktop) asking to be tied to a Promptly account:
    it shows a code, a signed-in person approves, it collects its device token."""

    __tablename__ = "pw_connects"

    code: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    poll_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    scopes: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending", server_default="pending")
    # Who approved it, and from which sign-in. The token is minted when the client collects
    # it, and not at all if they've signed out everywhere since.
    token_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PwDeviceRequest(UUIDPKMixin, CreatedAtMixin, Base):
    """A new device asking an existing one for the Secret Key. All key material
    here is public keys or a blob sealed to the new device's ephemeral key."""

    __tablename__ = "pw_device_requests"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    code: Mapped[str] = mapped_column(String(16), nullable=False)
    poll_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    device_pub: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    approver_pub: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    payload: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending", server_default="pending")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PwVault(CreatedAtMixin, Base):
    __tablename__ = "pw_vaults"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)  # personal | shared
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    encrypted_name: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # Someone who could read it has gone, and a manager hasn't changed the key yet.
    rotate_needed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class PwVaultMember(CreatedAtMixin, Base):
    __tablename__ = "pw_vault_members"

    vault_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pw_vaults.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(10), nullable=False)  # manage | edit | view | fill
    wrapped_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    signature: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    granted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PwItem(CreatedAtMixin, Base):
    """``blob`` is NULL for a purged item: the row stays as a tombstone for sync."""

    __tablename__ = "pw_items"
    __table_args__ = (Index("ix_pw_items_vault_revision", "vault_id", "revision"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    vault_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pw_vaults.id", ondelete="CASCADE"), nullable=False)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    blob: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    size_bucket: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class PwItemVersion(CreatedAtMixin, Base):
    """Earlier blobs of an item, newest 20 kept."""

    __tablename__ = "pw_item_versions"

    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pw_items.id", ondelete="CASCADE"), primary_key=True)
    revision: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    blob: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)


class PwAttachment(CreatedAtMixin, Base):
    __tablename__ = "pw_attachments"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pw_items.id", ondelete="CASCADE"), nullable=False, index=True)
    vault_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pw_vaults.id", ondelete="CASCADE"), nullable=False, index=True)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    complete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Chunks already on disk, so an upload can resume.
    received: Mapped[list[int]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")


class PwSend(CreatedAtMixin, Base):
    """Secure Send. The key is in the link's fragment and never comes here."""

    __tablename__ = "pw_sends"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    blob: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    views_left: Mapped[int | None] = mapped_column(Integer, nullable=True)
    password_salt: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    password_verifier: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PwEmergency(UUIDPKMixin, CreatedAtMixin, Base):
    """Trusted contact. ``wrapped`` is the grantor's vault keys sealed to the
    grantee in advance; it's only handed over once the wait has run out."""

    __tablename__ = "pw_emergency"
    __table_args__ = (UniqueConstraint("grantor_id", "grantee_id", name="uq_pw_emergency_pair"),)

    grantor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    grantee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    wrapped: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    wait_days: Mapped[int] = mapped_column(Integer, nullable=False)
    # invited | accepted | ready | requested | refused | opened
    state: Mapped[str] = mapped_column(String(12), nullable=False, default="invited", server_default="invited")
    requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PwActivity(UUIDPKMixin, Base):
    """What happened to the account, for its owner. Never item names."""

    __tablename__ = "pw_activity"
    __table_args__ = (Index("ix_pw_activity_user_at", "user_id", "at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    event: Mapped[str] = mapped_column(String(40), nullable=False)
    device_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("pw_devices.id", ondelete="SET NULL"), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class PwHealth(Base):
    """Coarse counts the owner chose to post, for the Today card. Never names."""

    __tablename__ = "pw_health"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    counts: Mapped[dict[str, int]] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class PwSettings(Base):
    """Admin policy, one row. No access to data: the admin can't reach a vault."""

    __tablename__ = "pw_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    preview_badge: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    min_kdf_m: Mapped[int] = mapped_column(Integer, nullable=False, default=65536, server_default="65536")
    min_kdf_t: Mapped[int] = mapped_column(Integer, nullable=False, default=3, server_default="3")
    max_attachment_mb: Mapped[int] = mapped_column(Integer, nullable=False, default=500, server_default="500")
    # A password-breach check through this server, on by default.
    breach_check: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
