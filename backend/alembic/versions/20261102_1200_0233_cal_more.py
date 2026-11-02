"""Calendar, joined up: events linked to a task or a Photos album, room
reminders, and guests invited by email who aren't on this Promptly.

* ``cal_events.source`` — what an event was made from, e.g. a task planned
  into a time slot: ``{"kind": "task", "file_id", "task_id"}``.
* ``cal_events.album_id`` — the album made from the event's photos.
* ``cal_event_rooms.remind_minutes`` — post "starting in 1 hour" in the room
  (NULL = don't); ``cal_room_reminders_sent`` keeps it to once.
* ``cal_external_guests`` — someone invited by email, who answers from a
  link in the email (``token``).

Revision ID: 0233_cal_more
Revises: 0232_cal_links
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0233_cal_more"
down_revision = "0232_cal_links"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.add_column("cal_events", sa.Column("source", postgresql.JSONB(), nullable=True))
    op.add_column("cal_events", sa.Column("album_id", _UUID, sa.ForeignKey("albums.id", ondelete="SET NULL"), nullable=True))
    op.add_column("cal_event_rooms", sa.Column("remind_minutes", sa.Integer(), nullable=True, server_default="60"))
    op.create_table(
        "cal_room_reminders_sent",
        sa.Column("event_id", _UUID, sa.ForeignKey("cal_events.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("room_id", _UUID, sa.ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("occurrence", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "cal_external_guests",
        sa.Column("id", _UUID, primary_key=True),
        sa.Column("event_id", _UUID, sa.ForeignKey("cal_events.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("name", sa.String(120), nullable=False, server_default=""),
        sa.Column("status", sa.String(10), nullable=False, server_default="invited"),
        sa.Column("token", sa.String(64), nullable=False, unique=True),
        sa.Column("invited_by", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("event_id", "email", name="uq_cal_external_guests_event_email"),
    )


def downgrade() -> None:
    op.drop_table("cal_external_guests")
    op.drop_table("cal_room_reminders_sent")
    op.drop_column("cal_event_rooms", "remind_minutes")
    op.drop_column("cal_events", "album_id")
    op.drop_column("cal_events", "source")
