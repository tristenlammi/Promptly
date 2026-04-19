"""ORM models for the Files feature.

Two tables that mirror each other on ownership: `FileFolder` and `UserFile`.
`user_id IS NULL` means the row lives in the admin-managed shared pool — any
authenticated user can read + attach from it, but only admins can write.

Folders form a tree via `parent_id`. Files live either at a folder's root
(when `folder_id` is set) or at the scope root (when `folder_id IS NULL`).
"""
from __future__ import annotations

import uuid

from sqlalchemy import BigInteger, ForeignKey, String
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

    def __repr__(self) -> str:
        return f"<UserFile id={self.id} name={self.filename!r} owner={self.user_id}>"
