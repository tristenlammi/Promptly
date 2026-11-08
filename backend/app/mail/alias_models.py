"""Tables for aliases on your own domain (``app/mail/aliases.py``).

Plaintext on purpose: the alias address is needed to route mail. The login's site
and name are never here; ``item_id`` is the vault item's opaque id.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class PwAliasDomain(UUIDPKMixin, CreatedAtMixin, Base):
    """A domain you own, with a catch-all into one of your connected mailboxes."""

    __tablename__ = "pw_alias_domains"
    __table_args__ = (UniqueConstraint("user_id", "domain", name="uq_pw_alias_domain"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    domain: Mapped[str] = mapped_column(String(253), nullable=False)
    # How a new alias is made: a word, then a separator, then a random part.
    word_style: Mapped[str] = mapped_column(String(8), nullable=False, default="word", server_default="word")  # word | site | custom | none
    random_len: Mapped[int] = mapped_column(Integer, nullable=False, default=4, server_default="4")
    separator: Mapped[str] = mapped_column(String(1), nullable=False, default=".", server_default=".")
    # Where new mail for an alias that's off goes. None: the mailbox's Trash.
    off_folder_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("mail_folders.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="new", server_default="new")  # new | checking | ok | failed
    status_detail: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    check_local: Mapped[str] = mapped_column(String(64), nullable=False, default="", server_default="")
    check_from: Mapped[str] = mapped_column(String(320), nullable=False, default="", server_default="")
    check_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    send_as: Mapped[str] = mapped_column(String(10), nullable=False, default="unknown", server_default="unknown")  # unknown | ok | rewritten | refused
    send_as_detail: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")


class PwAlias(UUIDPKMixin, CreatedAtMixin, Base):
    """One address, usually for one login. ``item_id`` is the vault item's opaque id:
    the server can't read the item, so it can't tell which site that is."""

    __tablename__ = "pw_aliases"
    __table_args__ = (UniqueConstraint("user_id", "address", name="uq_pw_alias_address"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    domain_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pw_alias_domains.id", ondelete="CASCADE"), nullable=False, index=True)
    address: Mapped[str] = mapped_column(String(320), nullable=False)
    item_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The first sender this alias heard from: who it's presumed to be for.
    baseline: Mapped[str] = mapped_column(String(253), nullable=False, default="", server_default="")
    # Sender domains you said are fine.
    allowed_senders: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    flagged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    flagged_sender: Mapped[str] = mapped_column(String(253), nullable=False, default="", server_default="")


class PwAliasMail(Base):
    """One email an alias got, once, however many folders it shows in. Kept after
    the email is deleted, so counts don't drop."""

    __tablename__ = "pw_alias_mail"
    __table_args__ = (Index("ix_pw_alias_mail_lookup", "account_id", "msg_key"),)

    alias_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pw_aliases.id", ondelete="CASCADE"), primary_key=True)
    msg_key: Mapped[str] = mapped_column(String(500), primary_key=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False)
    sender_domain: Mapped[str] = mapped_column(String(253), nullable=False, default="", server_default="")
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    unlike: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
