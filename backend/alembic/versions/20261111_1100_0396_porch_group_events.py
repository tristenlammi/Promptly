"""Porch group events (WP-P3.2): any post can carry a Calendar event.

* ``porch_posts.event_id`` → ``cal_events`` (SET NULL: deleting the event
  leaves the post, with a "Cancelled" card), indexed for a group's Events.
* ``porch_posts.event_title`` — the event's name, kept so a cancelled
  event still says what it was ("Cancelled: Family BBQ").

Anyone who can see the post can answer the event's card, which makes them a
guest (``calendars/core.shared_with_me`` and ``service.rsvp`` ask
``porch.plans``). No group calendars (decision E2).

The plan numbered this 0393; Porch's wave-2 range is 0393–0399.

Revision ID: 0396_porch_group_events
Revises: 0395_porch_highlights
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0396_porch_group_events"
down_revision = "0395_porch_highlights"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "porch_posts",
        sa.Column("event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("cal_events.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column("porch_posts", sa.Column("event_title", sa.String(200), nullable=True))
    op.create_index("ix_porch_posts_event", "porch_posts", ["event_id"], postgresql_where=sa.text("event_id IS NOT NULL"))


def downgrade() -> None:
    op.drop_index("ix_porch_posts_event", table_name="porch_posts")
    op.drop_column("porch_posts", "event_title")
    op.drop_column("porch_posts", "event_id")
