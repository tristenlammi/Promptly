"""``backup_runs`` — one row per database dump attempt (WP-0.2)."""
from __future__ import annotations

import datetime as _dt

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class BackupRun(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "backup_runs"

    # ``pre_migrate`` (bootstrap, before applying a new schema), ``nightly``
    # (arq cron) or ``manual`` (admin "Back up now"); off-site (WP-2.3):
    # ``offsite`` (a copy sent to the target), ``check`` (weekly integrity
    # check of the copies) and ``restore_test`` (monthly trial restore).
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # ``running`` → ``ok`` | ``failed``.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")
    # File name under the backups directory (never a full host path).
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Schema revision the dump was taken at — what a restore needs to match.
    revision: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # What a successful run did, in a sentence ("1,204 files, 3.2 MB new";
    # a restore test's row counts). WP-2.3.
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    finished_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class OffsiteBackupConfig(Base):
    """Where off-site copies go (one row, id 1). WP-2.3 / D11.

    Backups that only exist on the machine they protect aren't backups: a
    failed disk takes both. restic sends encrypted, deduplicated snapshots
    of the database dumps, uploads and config to one of these targets.
    """

    __tablename__ = "offsite_backup_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # ``folder`` (USB/NAS mounted at /app/offsite), ``s3`` (incl. Backblaze
    # B2's S3 API), ``sftp`` (another box over SSH), ``rest`` (restic's
    # rest-server, ideally --append-only).
    target_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="folder", server_default="folder")
    # Kind-specific location: folder sub-path; S3 endpoint/bucket/prefix;
    # sftp user@host:/path; rest-server URL.
    location: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # Fernet-encrypted JSON of the target's credentials (S3 keys, rest-server
    # user/password, SSH private key). Never returned by the API.
    credentials_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The repository's encryption password — generated once, Fernet-encrypted
    # here, and in the recovery kit. Lose both and the copies can't be read.
    repo_password_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Hour of day (server time, UTC) the nightly copy runs.
    hour: Mapped[int] = mapped_column(Integer, nullable=False, default=3, server_default="3")
    keep_daily: Mapped[int] = mapped_column(Integer, nullable=False, default=7, server_default="7")
    keep_weekly: Mapped[int] = mapped_column(Integer, nullable=False, default=4, server_default="4")
    keep_monthly: Mapped[int] = mapped_column(Integer, nullable=False, default=12, server_default="12")
    # Monthly trial restore — on unless an admin turns it off.
    restore_test_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
