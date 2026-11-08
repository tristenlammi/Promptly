"""Forms (WP-F1.7): an event's RSVP form.

``cal_events.form_file_id`` — the RSVP form made from the event ("Add an
RSVP form" on the event page). The form points back with
``forms.event_id`` (``0290_forms_core``). Either side going away just
unlinks the other (SET NULL). Porch adds ``porch_post_id`` to the same
table: order the two migrations at merge.

Revision ID: 0292_forms_cal
Revises: 0297_forms_uploads
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0292_forms_cal"
down_revision = "0297_forms_uploads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cal_events",
        sa.Column(
            "form_file_id",
            UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="SET NULL", name="fk_cal_events_form_file_id"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_constraint("fk_cal_events_form_file_id", "cal_events", type_="foreignkey")
    op.drop_column("cal_events", "form_file_id")
