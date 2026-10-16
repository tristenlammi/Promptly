"""Roster save revision for optimistic concurrency (R-035).

Saves replaced ``rosters.data`` wholesale with no check, so a client that
had failed to load (and fell back to an empty roster) or a second editor
silently overwrote the real schedule. Saves now carry the revision they
were based on and are refused when it's stale.

Revision ID: 0169_roster_revision
Revises: 0168_blob_tombstones
"""
from alembic import op
import sqlalchemy as sa

revision = "0169_roster_revision"
down_revision = "0168_blob_tombstones"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rosters",
        sa.Column("revision", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )


def downgrade() -> None:
    op.drop_column("rosters", "revision")
