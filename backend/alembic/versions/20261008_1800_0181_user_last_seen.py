"""Users remember when they were last active (R-192).

Revision ID: 0181_user_last_seen
Revises: 0180_auth_events_created_idx
"""
from alembic import op
import sqlalchemy as sa

revision = "0181_user_last_seen"
down_revision = "0180_auth_events_created_idx"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "last_seen_at")
