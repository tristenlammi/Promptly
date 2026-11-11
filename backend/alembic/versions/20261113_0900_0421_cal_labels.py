"""Calendar labels: each person's own colour-coding for events.

``cal_labels`` holds a person's labels (name + colour); ``cal_event_labels``
is the one label a person put on an event, keyed (event, person) so nobody
sees anyone else's. Both go with the person, the event and the label.

Revision ID: 0421_cal_labels
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0421_cal_labels"
down_revision = "0420_drop_code_exec"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cal_labels",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("color", sa.String(9), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("hidden", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_cal_labels_user_id", "cal_labels", ["user_id"])
    op.create_table(
        "cal_event_labels",
        sa.Column("event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("cal_events.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("label_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("cal_labels.id", ondelete="CASCADE"), nullable=False),
    )
    op.create_index("ix_cal_event_labels_user_id", "cal_event_labels", ["user_id"])
    op.create_index("ix_cal_event_labels_label_id", "cal_event_labels", ["label_id"])


def downgrade() -> None:
    op.drop_table("cal_event_labels")
    op.drop_table("cal_labels")
