"""Pydantic schemas for the Files API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.files.safety import UnsafeUploadError, sanitize_filename

Scope = Literal["mine", "shared"]


class FolderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    scope: Scope
    created_at: datetime
    # NULL = ordinary folder. Non-NULL = system-managed folder (e.g.
    # "chat_uploads"); the frontend uses this to swap the icon and hide
    # rename / delete actions.
    system_kind: str | None = None


class FileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    folder_id: uuid.UUID | None
    filename: str
    mime_type: str
    size_bytes: int
    scope: Scope
    created_at: datetime


class BreadcrumbEntry(BaseModel):
    id: uuid.UUID | None  # null = scope root
    name: str


class BrowseResponse(BaseModel):
    scope: Scope
    folder: FolderResponse | None
    breadcrumbs: list[BreadcrumbEntry]
    folders: list[FolderResponse]
    files: list[FileResponse]
    writable: bool


def _clean_name(raw: str) -> str:
    """Validator helper that funnels every name field through ``sanitize_filename``."""
    try:
        return sanitize_filename(raw)
    except UnsafeUploadError as e:
        raise ValueError(str(e)) from e


class FolderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None
    scope: Scope = "mine"

    @field_validator("name")
    @classmethod
    def _check_name(cls, raw: str) -> str:
        return _clean_name(raw)


class FolderUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None
    # When True, `parent_id=None` means "move to scope root" instead of
    # "leave unchanged". Pydantic can't distinguish omitted vs. explicit
    # null on its own.
    move_to_root: bool = False

    @field_validator("name")
    @classmethod
    def _check_name(cls, raw: str | None) -> str | None:
        return _clean_name(raw) if raw is not None else None


class FileUpdateRequest(BaseModel):
    filename: str | None = Field(default=None, min_length=1, max_length=512)
    folder_id: uuid.UUID | None = None
    move_to_root: bool = False

    @field_validator("filename")
    @classmethod
    def _check_filename(cls, raw: str | None) -> str | None:
        # Renames must clear the same bar as fresh uploads — no
        # control bytes, no path separators, no reserved Windows
        # device names.
        return _clean_name(raw) if raw is not None else None


class StorageQuotaResponse(BaseModel):
    """``GET /api/files/quota`` payload.

    All three values are byte counts. ``cap_bytes`` and
    ``remaining_bytes`` are nullable to express "no limit applies".
    """

    cap_bytes: int | None
    used_bytes: int
    remaining_bytes: int | None


class AttachmentDescriptor(BaseModel):
    """Snapshot of a file at the moment it was attached to a chat message."""

    id: uuid.UUID
    filename: str
    mime_type: str
    size_bytes: int


class SourceContentResponse(BaseModel):
    """Payload for ``GET /api/files/{id}/source``.

    Returns the editable source backing a rendered artefact. For Phase
    A3 the only supported pair is ``rendered_pdf`` -> ``markdown_source``,
    but the fields are kept generic so the eventual image-source flow
    fits the same shape.
    """

    rendered_file_id: uuid.UUID
    rendered_filename: str
    source_file_id: uuid.UUID
    source_filename: str
    source_mime_type: str
    source_size_bytes: int
    content: str
    # When the rendered child or the source itself was last modified.
    # The editor uses this to display "edited X minutes ago" and (in a
    # future phase) to refuse a stale save.
    rendered_size_bytes: int


class SourceUpdateRequest(BaseModel):
    """Body for ``PUT /api/files/{id}/source``.

    Just the new Markdown content. The editor sends the entire body
    on every save (no diff) — keeps the wire protocol trivial and
    matches the user's mental model of "I saved this version."
    """

    content: str = Field(min_length=0, max_length=200_000)
