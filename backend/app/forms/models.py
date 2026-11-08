"""Forms — ORM (migration ``0290_forms_core``).

A form is a Files document type: its identity in Drive is a ``files`` row
(``source_kind='form'``, no blob — a *shell*, see ``app.files.office``) and
the form itself is a :class:`Form` that points at it through ``file_id``.

* :class:`Form` — the definition (validated by ``app.forms.definition``),
  ``data_version`` (the save guard: a save from an older version is a 409),
  the settings, and the counters.
* :class:`FormResponse` — one person's answer. Kept when the form is
  trashed; gone when the form is permanently deleted.
* :class:`FormOptionCount` — how many have taken each limited option,
  updated under the form's row lock so the last place can't be taken twice.
* :class:`FormUpload` — a respondent's file, staged until submit.
* :class:`FormNotify` — each person's notification choice per form.
* :class:`FormReport` — "Report this form" from the answer page.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# ``forms.event_id`` points at ``cal_events``: the table must be known
# wherever forms are loaded (the arq worker doesn't import the calendar app).
import app.calendars.models  # noqa: E402,F401


class Form(Base):
    __tablename__ = "forms"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id"), nullable=False, unique=True)
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    data_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    # "server" (people on this server) or "link" (anyone with the link).
    audience: Mapped[str] = mapped_column(String(8), nullable=False, default="server", server_default="server")
    accepting: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    close_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    max_responses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    one_per_person: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    allow_edit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    collect_email: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    show_remaining: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    allow_uploads_from_link: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    confirmation: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    closed_message: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    allow_another: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("cal_events.id", ondelete="SET NULL"), nullable=True
    )
    sheet_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"), nullable=True
    )
    sheet_tab_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sheet_synced_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    sheet_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The linked tab's columns as Forms wrote them (0291, WP-F1.5).
    sheet_columns: Mapped[list[Any] | None] = mapped_column(JSONB, nullable=True)
    sheet_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    response_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_response_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # When the owner was told it closed (0296); cleared when it opens again.
    close_pushed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    # The shell helpers (app.files.office) read these off any content row.
    @property
    def workspace_id(self) -> uuid.UUID | None:  # phase 2: workspace forms
        return None

    @property
    def yjs_update(self) -> bytes:  # pragma: no cover — shell helpers probe it
        return b""

    @property
    def title(self) -> str:
        return str((self.definition or {}).get("title") or "Untitled form")

    @title.setter
    def title(self, value: str) -> None:
        # A rename in Files renames the form (the title card follows the
        # name). It's a change to the definition, so an open builder's next
        # save from the older version gets the 409 instead of undoing it.
        d = dict(self.definition or {})
        new = (value or "Untitled form")[:300]
        if d.get("title") == new:
            return
        d["title"] = new
        self.definition = d
        self.data_version = (self.data_version or 0) + 1


class FormResponse(Base):
    __tablename__ = "form_responses"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    form_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("forms.id", ondelete="CASCADE"), nullable=False)
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    respondent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Typed by the respondent, never checked.
    email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    source: Mapped[str] = mapped_column(String(8), nullable=False)
    answers: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    path: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    submit_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    edit_token_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    score: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    grading: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    seq: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("nextval('form_response_seq')")
    )
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FormOptionCount(Base):
    __tablename__ = "form_option_counts"

    form_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("forms.id", ondelete="CASCADE"), primary_key=True)
    question_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    option_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    taken: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class FormUpload(Base):
    __tablename__ = "form_uploads"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    form_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("forms.id", ondelete="CASCADE"), nullable=False)
    response_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("form_responses.id", ondelete="SET NULL"), nullable=True
    )
    question_id: Mapped[str] = mapped_column(String(40), nullable=False)
    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), nullable=False)
    draft_key_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class FormNotify(Base):
    __tablename__ = "form_notify"

    form_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("forms.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    mode: Mapped[str] = mapped_column(String(8), nullable=False, default="each", server_default="each")
    email_daily: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_push_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # The last daily email of new answers (0296).
    emailed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class FormReport(Base):
    """"Report this form" from the answer page (0295): no IP, no account."""

    __tablename__ = "form_reports"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    form_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("forms.id", ondelete="CASCADE"), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


__all__ = ["Form", "FormNotify", "FormOptionCount", "FormReport", "FormResponse", "FormUpload"]
