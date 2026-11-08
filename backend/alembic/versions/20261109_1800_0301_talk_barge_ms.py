"""Talk (WP-T6): how quickly it went quiet when someone talked over it.

* ``talk_metrics.barge_in_ms``: from the moment the speech service heard you
  start talking over an answer to the moment the answer's audio was stopped.
  NULL on turns nobody talked over. A timing, like the rest of the table.

Revision ID: 0301_talk_barge_ms
Revises: 0300_talk_core
"""
import sqlalchemy as sa
from alembic import op

revision = "0301_talk_barge_ms"
down_revision = "0300_talk_core"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("talk_metrics", sa.Column("barge_in_ms", sa.Integer, nullable=True))


def downgrade() -> None:
    op.drop_column("talk_metrics", "barge_in_ms")
