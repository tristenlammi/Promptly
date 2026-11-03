"""Calendar: events between the people on this Promptly.

Nobody sees anyone else's calendar. An event is seen by the people on its
calendar (your own calendar is just you; a shared one like "Family" is its
members) and by the people invited to it. Everyone gets a personal calendar
the first time they open the app."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, TimestampMixin, UUIDPKMixin


class CalCalendar(UUIDPKMixin, CreatedAtMixin, Base):
    """A calendar: someone's own (``personal``), or shared ("Family")."""

    __tablename__ = "cal_calendars"

    name: Mapped[str] = mapped_column(String(80), nullable=False)
    color: Mapped[str] = mapped_column(String(9), nullable=False, default="#4F7FE0", server_default="#4F7FE0")
    personal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    owner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)


class CalMember(Base):
    """Someone on a calendar, and their own settings for it."""

    __tablename__ = "cal_members"

    calendar_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cal_calendars.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(8), nullable=False, default="editor", server_default="editor")  # owner/editor/viewer
    color: Mapped[str | None] = mapped_column(String(9), nullable=True)  # their own colour for it
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")  # unticked in the list
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CalEvent(UUIDPKMixin, TimestampMixin, Base):
    """One event, or a repeating series of them.

    Timed: ``start_at``/``end_at`` are instants. All-day: they hold the first
    day and the day after the last, at midnight UTC (dates, not instants).
    A series repeats by ``repeat`` in ``tz`` (so 9:00 stays 9:00 across a
    clock change); ``exdates`` are the starts of occurrences deleted from it.
    """

    __tablename__ = "cal_events"

    calendar_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cal_calendars.id", ondelete="CASCADE"), nullable=False, index=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    location: Mapped[str] = mapped_column(String(300), nullable=False, default="", server_default="")
    all_day: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    tz: Mapped[str] = mapped_column(String(64), nullable=False, default="UTC", server_default="UTC")
    repeat: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    # When the last occurrence ends (NULL = repeats forever) — lets a range
    # query skip finished series without expanding them.
    last_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exdates: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    reminders: Mapped[list[int]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")  # minutes before
    color: Mapped[str | None] = mapped_column(String(9), nullable=True)
    guests_can_edit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # What it was made from — a task planned into a time slot:
    # {"kind": "task", "file_id": ..., "task_id": ...}.
    source: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    album_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("albums.id", ondelete="SET NULL"), nullable=True)  # made from its photos


class CalAttendee(Base):
    """Someone invited to an event, and their answer."""

    __tablename__ = "cal_attendees"

    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cal_events.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="invited", server_default="invited")  # invited/going/maybe/declined
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")  # removed from their calendar
    reminders: Mapped[list[int] | None] = mapped_column(JSONB, nullable=True)  # their own, else the event's
    invited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CalReminderSent(Base):
    """A reminder already sent, so it goes once."""

    __tablename__ = "cal_reminders_sent"
    __table_args__ = (UniqueConstraint("event_id", "user_id", "occurrence", "minutes", name="uq_cal_reminders_sent"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cal_events.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    occurrence: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)


class CalEventSnooze(Base):
    """A reminder snoozed from its notification ("Snooze 10 min"): send it
    again at ``until``. Saved so a restart doesn't lose it; the reminder
    loop sends it and deletes the row."""

    __tablename__ = "cal_event_snoozes"
    __table_args__ = (UniqueConstraint("user_id", "event_id", "occurrence", name="uq_cal_event_snoozes"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cal_events.id", ondelete="CASCADE"), nullable=False, index=True)
    occurrence: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CalFeed(Base):
    """A person's private subscribe link (read-only, for a phone's calendar app)."""

    __tablename__ = "cal_feeds"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CalEventRoom(Base):
    """An event planned in, or shared to, a room (its card is ``message_id``).
    Anyone in the room can add themselves to it."""

    __tablename__ = "cal_event_rooms"

    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cal_events.id", ondelete="CASCADE"), primary_key=True)
    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True, index=True)
    message_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("room_messages.id", ondelete="SET NULL"), nullable=True)
    shared_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    remind_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True, default=60, server_default="60")  # "starting in 1 hour" in the room; NULL = off
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CalRoomReminderSent(Base):
    """A room's "starting soon" post already made, so it goes once."""

    __tablename__ = "cal_room_reminders_sent"

    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cal_events.id", ondelete="CASCADE"), primary_key=True)
    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True)
    occurrence: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CalExternalGuest(UUIDPKMixin, Base):
    """Someone invited by email who isn't on this Promptly; they answer from
    the link in the email (``token``)."""

    __tablename__ = "cal_external_guests"
    __table_args__ = (UniqueConstraint("event_id", "email", name="uq_cal_external_guests_event_email"),)

    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cal_events.id", ondelete="CASCADE"), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False, default="", server_default="")
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="invited", server_default="invited")  # invited/going/maybe/declined
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
