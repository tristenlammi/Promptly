"""Notes — ORM (migration ``0261_notes_core``).

* :class:`Note` — one note, text or checklist. Title, body, colour, kind and
  list options carry ``revision`` (a stale save is refused with 409);
  ``change_seq`` moves on every change, items included (live updates, the
  "changed by Sam" dot, widget etags).
* :class:`NoteItem` — a checklist item, its own row, so ticking, adding and
  reordering never conflict. Ids are made by the client (retries are safe).
* :class:`NoteMember` — someone the owner shared the note with. The owner
  isn't a member row.
* :class:`NoteUserState` — each person's own pin, archive and order.
* :class:`NoteAttachment` — an image or recording (a Drive file of whoever
  added it); filled in by N1.3.
* :class:`NoteReminder` — a person's reminder, which is a task in their Tasks
  file (the task is the source of truth); filled in by N1.4.
* :class:`NoteVersion` — earlier versions, throttled, the last 30 kept.

Labels are #tags (``tag_assignments`` with ``entity_kind='note'``), so they
are per person on a shared note.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# The fixed palette (Keep's, renamed). "default" is the plain card.
COLORS = ("default", "coral", "peach", "sand", "mint", "sage", "fog", "storm", "dusk", "blossom", "clay", "chalk")
KINDS = ("text", "list")
SOURCES = ("web", "android", "share", "voice", "chat", "import")


def _in(col: str, values: tuple[str, ...]) -> str:
    return f"{col} IN ({', '.join(repr(v) for v in values)})"


class Note(Base):
    __tablename__ = "notes"
    __table_args__ = (
        CheckConstraint(_in("kind", KINDS), name="ck_notes_kind"),
        CheckConstraint(_in("color", COLORS), name="ck_notes_color"),
        CheckConstraint(_in("source", SOURCES), name="ck_notes_source"),
        Index("ix_notes_owner_updated", "owner_id", "updated_at"),
    )

    # Made by the client (so a retried create is the same note), else here.
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False, default="text", server_default="text")
    title: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    body_doc: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)  # the TipTap doc
    body_text: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")  # derived
    color: Mapped[str] = mapped_column(String(16), nullable=False, default="default", server_default="default")
    list_opts: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    change_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    edited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    source: Mapped[str] = mapped_column(String(8), nullable=False, default="web", server_default="web")
    import_ref: Mapped[str | None] = mapped_column(String(200), nullable=True)  # a Keep id; re-imports skip
    doc_file_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"), nullable=True)
    trashed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trashed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # Title + body + items + transcripts, kept on save; ``tsv`` (generated,
    # not mapped) indexes it for search.
    search_text: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")


class NoteItem(Base):
    __tablename__ = "note_items"
    __table_args__ = (Index("ix_note_items_note_position", "note_id", "position"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    note_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), nullable=False)
    # One level of indent. Removing a parent lifts its children.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("note_items.id", ondelete="SET NULL"), nullable=True)
    text: Mapped[str] = mapped_column(String(1000), nullable=False, default="", server_default="")
    checked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    checked_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    position: Mapped[float] = mapped_column(Float(precision=53), nullable=False, default=0.0, server_default="0")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    # 0360: the store aisle (a Meal Plan ``foods.AISLES`` key) on a list kept
    # by aisle; Meal Plan's id for an item it sent (people's own have none).
    aisle: Mapped[str | None] = mapped_column(String(16), nullable=True)
    ref: Mapped[str | None] = mapped_column(String(64), nullable=True)


class NoteMember(Base):
    __tablename__ = "note_members"

    note_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    added_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class NoteUserState(Base):
    __tablename__ = "note_user_state"

    note_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Your manual order: smaller comes first (a new note gets minus "now").
    position: Mapped[float] = mapped_column(Float(precision=53), nullable=False, default=0.0, server_default="0")
    # The note's change_seq when you last saw it ("changed by Sam" dot).
    seen_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class NoteAttachment(Base):
    __tablename__ = "note_attachments"
    __table_args__ = (
        CheckConstraint("kind IN ('image', 'audio')", name="ck_note_attachments_kind"),
        CheckConstraint(
            "transcript_state IS NULL OR transcript_state IN ('pending', 'working', 'done', 'failed', 'off')",
            name="ck_note_attachments_transcript_state",
        ),
        Index("ix_note_attachments_note", "note_id", "position"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    note_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), nullable=False)
    file_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    position: Mapped[float] = mapped_column(Float(precision=53), nullable=False, default=0.0, server_default="0")
    added_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    peaks: Mapped[list[float] | None] = mapped_column(JSONB, nullable=True)  # ≤200 levels
    transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    transcript_state: Mapped[str | None] = mapped_column(String(8), nullable=True)
    transcript_lang: Mapped[str | None] = mapped_column(String(16), nullable=True)
    transcribed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class NoteReminder(Base):
    __tablename__ = "note_reminders"

    note_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    tasks_file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class NoteVersion(Base):
    __tablename__ = "note_versions"
    __table_args__ = (
        CheckConstraint("reason IN ('edit', 'restore', 'ai', 'send')", name="ck_note_versions_reason"),
        Index("ix_note_versions_note_created", "note_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    note_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    # {title, kind, body_doc, color, list_opts, items: [{id, parent_id, text, checked, position}]}
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    reason: Mapped[str] = mapped_column(String(8), nullable=False, default="edit", server_default="edit")
    made_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


__all__ = [
    "COLORS", "KINDS", "SOURCES", "Note", "NoteAttachment", "NoteItem", "NoteMember", "NoteReminder",
    "NoteUserState", "NoteVersion",
]
