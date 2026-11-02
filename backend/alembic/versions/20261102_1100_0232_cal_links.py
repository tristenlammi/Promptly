"""Calendar ↔ Rooms, and Photos people ↔ Contacts.

* ``cal_event_rooms`` — an event planned in, or shared to, a room. People in
  that room can add themselves to it from the card.
* ``photo_people.contact_file_id`` / ``contact_id`` — a person in Photos is
  this contact (their face shows in Contacts, their birthday on the
  calendar, their details on the person's page).

Revision ID: 0232_cal_links
Revises: 0231_calendar
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0232_cal_links"
down_revision = "0231_calendar"
branch_labels = None
depends_on = None

_UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "cal_event_rooms",
        sa.Column("event_id", _UUID, sa.ForeignKey("cal_events.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("room_id", _UUID, sa.ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("message_id", _UUID, sa.ForeignKey("room_messages.id", ondelete="SET NULL"), nullable=True),
        sa.Column("shared_by", _UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_cal_event_rooms_room_id", "cal_event_rooms", ["room_id"])
    op.add_column("photo_people", sa.Column("contact_file_id", _UUID, sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True))
    op.add_column("photo_people", sa.Column("contact_id", sa.String(40), nullable=True))


def downgrade() -> None:
    op.drop_column("photo_people", "contact_id")
    op.drop_column("photo_people", "contact_file_id")
    op.drop_index("ix_cal_event_rooms_room_id", table_name="cal_event_rooms")
    op.drop_table("cal_event_rooms")
