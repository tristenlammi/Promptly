"""Accounts found in a person's own mail (app/passwords/accounts.py).

Nothing here comes from the vault. It's worked out from mail the server already
holds, so it says no more than the mail does. Which of these sites are in the vault
is decided on the person's device, and never comes back here.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import UUIDPKMixin


class PwMailSite(UUIDPKMixin, Base):
    """One site per mailbox that mail says you have an account with."""

    __tablename__ = "mail_account_sites"
    __table_args__ = (UniqueConstraint("account_id", "domain", name="uq_pw_mail_site"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False)
    domain: Mapped[str] = mapped_column(String(253), nullable=False)
    # The address it went to, from the latest piece of evidence.
    address: Mapped[str] = mapped_column(String(320), nullable=False)
    # The sender's display name on that latest message, shown as a hint only.
    name: Mapped[str] = mapped_column(String(120), nullable=False, default="", server_default="")
    # A bit per kind of evidence (accounts.KIND_BITS).
    kinds: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # The latest message. Not a foreign key: deleting mail mustn't wait on this table,
    # and a message that's gone just loses its link.
    message_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)


class PwMailScan(Base):
    """How far each folder has been read, so a run only reads what's new.

    ``hi_uid`` is the newest message read, ``lo_uid`` the oldest. Mail copied in later
    from further back (the mail worker fills a folder newest first) is below ``lo_uid``.
    A new ``uidvalidity`` means the folder was numbered again, and it's read again.
    """

    __tablename__ = "mail_account_scans"

    folder_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mail_folders.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    uidvalidity: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    hi_uid: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    lo_uid: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
