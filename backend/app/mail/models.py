"""Mail accounts and a local copy of what's in them.

The provider's mailbox stays the real one: what's here is a copy for speed and
search, kept in step by ``app/mail/worker.py``. Changes you make land here first,
so the screen is instant, and go to the provider through ``mail_ops``.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class MailAccount(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "mail_accounts"
    __table_args__ = (UniqueConstraint("user_id", "email", name="uq_mail_account_user_email"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False, default="", server_default="")
    color: Mapped[str] = mapped_column(String(9), nullable=False, default="#D97757", server_default="#D97757")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    provider: Mapped[str] = mapped_column(String(16), nullable=False, default="generic", server_default="generic")
    imap_host: Mapped[str] = mapped_column(String(255), nullable=False)
    imap_port: Mapped[int] = mapped_column(Integer, nullable=False)
    imap_security: Mapped[str] = mapped_column(String(8), nullable=False)  # ssl | starttls
    smtp_host: Mapped[str] = mapped_column(String(255), nullable=False)
    smtp_port: Mapped[int] = mapped_column(Integer, nullable=False)
    smtp_security: Mapped[str] = mapped_column(String(8), nullable=False)
    username: Mapped[str] = mapped_column(String(320), nullable=False)
    secret_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    # A server on your own network with its own certificate, which you agreed to.
    cert_pin: Mapped[str] = mapped_column(String(95), nullable=False, default="", server_default="")
    signature: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    notify: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="syncing", server_default="syncing")
    status_detail: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MailFolder(UUIDPKMixin, Base):
    __tablename__ = "mail_folders"
    __table_args__ = (UniqueConstraint("account_id", "path", name="uq_mail_folder_path"),)

    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    path: Mapped[str] = mapped_column(String(500), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(String(10), nullable=False, default="other", server_default="other")
    uidvalidity: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    last_uid: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    # How far back we've copied. 0: not started; 1: nothing older left.
    oldest_uid: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    # A folder of your own (one of Gmail's labels, say) shows as this label.
    label_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("mail_labels.id", ondelete="SET NULL"), nullable=True, index=True)
    label_off: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")


class MailMessage(UUIDPKMixin, Base):
    __tablename__ = "mail_messages"
    __table_args__ = (
        UniqueConstraint("folder_id", "uid", name="uq_mail_message_uid"),
        Index("ix_mail_messages_folder_date", "folder_id", "sent_at"),
        Index("ix_mail_messages_thread", "account_id", "thread_key"),
        Index("ix_mail_messages_message_id", "account_id", "message_id"),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False)
    folder_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_folders.id", ondelete="CASCADE"), nullable=False)
    # NULL once moved here by you and not yet seen from the provider.
    uid: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    thread_key: Mapped[str] = mapped_column(String(40), nullable=False)
    message_id: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    in_reply_to: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    references: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    subject: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    from_name: Mapped[str] = mapped_column(String(320), nullable=False, default="", server_default="")
    from_addr: Mapped[str] = mapped_column(String(320), nullable=False, default="", server_default="")
    to_addrs: Mapped[list[dict[str, str]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    cc_addrs: Mapped[list[dict[str, str]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    snippet: Mapped[str] = mapped_column(String(240), nullable=False, default="", server_default="")
    body_text: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    body_html: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    attachments: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    unsubscribe: Mapped[str] = mapped_column(String(1000), nullable=False, default="", server_default="")
    seen: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    flagged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    answered: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    invite: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    reply_to: Mapped[str] = mapped_column(String(320), nullable=False, default="", server_default="")
    triaged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    needs_reply: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    summary: Mapped[str] = mapped_column(String(240), nullable=False, default="", server_default="")


class MailLabel(UUIDPKMixin, CreatedAtMixin, Base):
    """Kept in Promptly rather than the mailbox, so a label works the same on any
    provider and can gather mail from several mailboxes."""

    __tablename__ = "mail_labels"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_mail_label_name"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    color: Mapped[str] = mapped_column(String(9), nullable=False, default="#D97757", server_default="#D97757")


class MailThreadLabel(Base):
    """Where a conversation lives: one label at a time, like a folder. On the
    conversation rather than the message, so replies follow it, and it survives
    a provider renumbering a folder, because the conversation's key doesn't change."""

    __tablename__ = "mail_thread_labels"
    __table_args__ = (Index("ux_mail_thread_labels_thread", "account_id", "thread_key", unique=True),)

    label_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_labels.id", ondelete="CASCADE"), primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_accounts.id", ondelete="CASCADE"), primary_key=True)
    thread_key: Mapped[str] = mapped_column(String(40), primary_key=True)


class MailRule(UUIDPKMixin, CreatedAtMixin, Base):
    """When mail in any of your mailboxes matches, it goes to this label."""

    __tablename__ = "mail_rules"
    __table_args__ = (UniqueConstraint("label_id", "kind", "value", name="uq_mail_rule"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    label_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_labels.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)  # from | domain | subject
    value: Mapped[str] = mapped_column(String(320), nullable=False)


class MailInvite(Base):
    """What you answered to an invite, and the calendar event it made."""

    __tablename__ = "mail_invites"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    uid: Mapped[str] = mapped_column(String(300), primary_key=True)
    event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("cal_events.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class MailSnooze(Base):
    """Out of your Inbox until then. It doesn't touch the mailbox itself."""

    __tablename__ = "mail_snoozes"

    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_accounts.id", ondelete="CASCADE"), primary_key=True)
    thread_key: Mapped[str] = mapped_column(String(40), primary_key=True)
    until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)


class MailOp(UUIDPKMixin, CreatedAtMixin, Base):
    """A change made here, on its way to the provider. A failed one is retried,
    and the next sync shows the truth if it never lands."""

    __tablename__ = "mail_ops"

    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)  # seen | unseen | flag | unflag | move | move_found | delete
    folder_path: Mapped[str] = mapped_column(String(500), nullable=False)
    # The server's numbers, or Message-IDs for move_found: an email moved again before
    # its first move has been synced has no number yet in the folder it's leaving.
    uids: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    target_path: Mapped[str] = mapped_column(String(500), nullable=False, default="", server_default="")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class MailOutbox(UUIDPKMixin, CreatedAtMixin, Base):
    """A message waiting to go. ``send_at`` is a few seconds off, which is what
    makes undo send possible."""

    __tablename__ = "mail_outbox"

    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    raw: Mapped[str] = mapped_column(Text, nullable=False)
    recipients: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    send_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="waiting", server_default="waiting")
    error: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
