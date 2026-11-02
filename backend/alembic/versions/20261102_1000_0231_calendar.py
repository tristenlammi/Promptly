"""Calendar: events between the people on this Promptly (app/calendars).

* ``cal_calendars`` / ``cal_members`` — someone's own calendar, or a shared one.
* ``cal_events`` — an event or a repeating series; ``cal_attendees`` — guests.
* ``cal_reminders_sent`` — reminders already sent (so each goes once).
* ``cal_feeds`` — private read-only subscribe links.
* ``push_preferences.calendar``.

Revision ID: 0231_calendar
Revises: 0230_rooms
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0231_calendar"
down_revision = "0230_rooms"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)
_JSONB = postgresql.JSONB(astext_type=sa.Text())


def _ts(name: str, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable, server_default=None if nullable else sa.func.now())


def upgrade() -> None:
    op.create_table(
        "cal_calendars",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("color", sa.String(9), nullable=False, server_default="#4F7FE0"),
        sa.Column("personal", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("owner_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        _ts("created_at"),
    )
    op.create_index("ix_cal_calendars_owner_id", "cal_calendars", ["owner_id"])
    op.create_table(
        "cal_members",
        sa.Column("calendar_id", _UUID, sa.ForeignKey("cal_calendars.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(8), nullable=False, server_default="editor"),
        sa.Column("color", sa.String(9), nullable=True),
        sa.Column("hidden", sa.Boolean, nullable=False, server_default="false"),
        _ts("joined_at"),
    )
    op.create_index("ix_cal_members_user_id", "cal_members", ["user_id"])
    op.create_table(
        "cal_events",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("calendar_id", _UUID, sa.ForeignKey("cal_calendars.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("location", sa.String(300), nullable=False, server_default=""),
        sa.Column("all_day", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tz", sa.String(64), nullable=False, server_default="UTC"),
        sa.Column("repeat", _JSONB, nullable=True),
        sa.Column("last_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("exdates", _JSONB, nullable=False, server_default="[]"),
        sa.Column("reminders", _JSONB, nullable=False, server_default="[]"),
        sa.Column("color", sa.String(9), nullable=True),
        sa.Column("guests_can_edit", sa.Boolean, nullable=False, server_default="false"),
        _ts("created_at"),
        _ts("updated_at"),
    )
    op.create_index("ix_cal_events_calendar_id", "cal_events", ["calendar_id"])
    op.create_index("ix_cal_events_start_at", "cal_events", ["start_at"])
    op.create_table(
        "cal_attendees",
        sa.Column("event_id", _UUID, sa.ForeignKey("cal_events.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("status", sa.String(10), nullable=False, server_default="invited"),
        sa.Column("hidden", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("reminders", _JSONB, nullable=True),
        sa.Column("invited_by", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        _ts("created_at"),
    )
    op.create_index("ix_cal_attendees_user_id", "cal_attendees", ["user_id"])
    op.create_table(
        "cal_reminders_sent",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("event_id", _UUID, sa.ForeignKey("cal_events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("occurrence", sa.DateTime(timezone=True), nullable=False),
        sa.Column("minutes", sa.Integer, nullable=False),
        _ts("sent_at"),
        sa.UniqueConstraint("event_id", "user_id", "occurrence", "minutes", name="uq_cal_reminders_sent"),
    )
    op.create_index("ix_cal_reminders_sent_sent_at", "cal_reminders_sent", ["sent_at"])
    op.create_table(
        "cal_feeds",
        sa.Column("user_id", _UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("token", sa.String(64), nullable=False, unique=True),
        _ts("created_at"),
    )
    op.add_column(
        "push_preferences",
        sa.Column("calendar", sa.Boolean, nullable=False, server_default="true"),
    )


def downgrade() -> None:
    op.drop_column("push_preferences", "calendar")
    for t in ("cal_feeds", "cal_reminders_sent", "cal_attendees", "cal_events", "cal_members", "cal_calendars"):
        op.drop_table(t)
