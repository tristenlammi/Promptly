"""ORM models for the Files feature.

Two tables that mirror each other on ownership: `FileFolder` and `UserFile`.
`user_id IS NULL` means the row lives in the admin-managed shared pool — any
authenticated user can read + attach from it, but only admins can write.

Folders form a tree via `parent_id`. Files live either at a folder's root
(when `folder_id` is set) or at the scope root (when `folder_id IS NULL`).
"""
from __future__ import annotations

import datetime as _dt
import uuid

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class FileFolder(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "file_folders"

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("file_folders.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # NULL = regular user-created folder. Non-NULL marks the row as a
    # system folder (e.g. "Chat Uploads"); the API blocks rename / delete /
    # move on those so the auto-routing helpers can rely on them existing.
    # See ``app.files.system_folders.SystemKind`` for the enum.
    system_kind: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    # Soft-delete pointer for the Drive "Trash" view. NULL = live, any
    # non-null timestamp means the row is in the trash and should be
    # filtered out of normal browse results. The empty-trash endpoint
    # walks rows where this is non-null and does the real DB + blob
    # delete. Added in migration ``0035_files_trash_starred``.
    trashed_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Per-user "Starred" flag; non-null = pinned in the Starred view,
    # value is when it was starred. Also used as a tiebreaker in the
    # default folder ordering.
    starred_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Drives the Recent view. Maintained by the ``files_set_updated_at``
    # trigger so we don't have to remember to bump it on every
    # mutation path.
    updated_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )

    def __repr__(self) -> str:
        return f"<FileFolder id={self.id} name={self.name!r} owner={self.user_id}>"


class UserFile(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "files"

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    folder_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("file_folders.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Relative path under /app/uploads. Resolved by the router with a safe
    # join so a caller can never escape the upload root.
    storage_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    # Provenance hint for AI-generated artefacts. NULL for ordinary user
    # uploads. Currently used values:
    #
    #   "markdown_source"  – authoritative Markdown for a renderable doc
    #                        (the editor in Phase A3 mutates this row).
    #   "rendered_pdf"     – PDF rendered from a markdown_source row;
    #                        ``source_file_id`` points at that source.
    #
    # Treat the strings as part of the schema: see
    # ``app.files.generated_kinds.GeneratedKind`` for the canonical enum.
    source_kind: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    # When this row is a *rendered* artefact (e.g. a PDF rendered from
    # Markdown), this points at the source-of-truth file. Editing the
    # source + re-running the renderer should overwrite this row's blob
    # so a download from chat always reflects the latest source. The
    # ON DELETE SET NULL keeps the rendered file alive even if the
    # source gets deleted out from under it (the user just can't
    # re-render anymore).
    source_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # --- Drive stage 1 additions (migration 0035) ---
    # See ``FileFolder`` for semantics. Same columns live on both
    # tables so the list views / filters / trigger are symmetric.
    trashed_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    starred_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )
    # Plain-text content extracted at upload time (or source-save
    # time) for the full-text search index. NULL for binary uploads
    # that carry no extractable text. Capped at ~256KB in the
    # extraction helper to keep the tsvector size reasonable; see
    # migration ``0036_files_fts`` for the generated ``content_tsv``
    # derived from this column.
    content_text: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )

    def __repr__(self) -> str:
        return f"<UserFile id={self.id} name={self.filename!r} owner={self.user_id}>"


class FileShareLink(UUIDPKMixin, CreatedAtMixin, Base):
    """A signed, optionally password-protected share link to a file or folder.

    Polymorphic pointer via ``(resource_type, resource_id)`` so the
    same table holds both. Not a FK because Postgres doesn't do
    polymorphic FKs; orphaned links 404 on resolve, which is fine.
    Added in migration ``0037_file_share_links``.
    """

    __tablename__ = "file_share_links"

    # ``'file'`` or ``'folder'``. Validated by a DB check constraint.
    resource_type: Mapped[str] = mapped_column(String(16), nullable=False)
    resource_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 43-char URL-safe base64 of 32 random bytes. Unique across the
    # table; we also have a partial UNIQUE on live rows.
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # ``'public'`` = anyone with URL (password/expiry gated).
    # ``'invite'`` = auth'd Promptly user; first visit creates a
    # ``FileShareGrant`` row for that user.
    access_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    # Optional bcrypt hash. NULL = no password required.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # NULL = never expires.
    expires_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Soft-delete; revoked links 410 Gone rather than 404 so the
    # UI can explain what happened.
    revoked_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    access_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    last_accessed_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def __repr__(self) -> str:
        return (
            f"<FileShareLink id={self.id} "
            f"{self.resource_type}={self.resource_id} mode={self.access_mode}>"
        )


class FileShareGrant(UUIDPKMixin, CreatedAtMixin, Base):
    """Recorded claim of an ``access_mode='invite'`` link by a user.

    Lets a returning authenticated user skip the "you've been invited
    to view this" nudge — we look up ``(link_id, user_id)`` and if it
    exists, go straight through to the resource.
    """

    __tablename__ = "file_share_grants"

    link_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("file_share_links.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        return f"<FileShareGrant link={self.link_id} user={self.user_id}>"
