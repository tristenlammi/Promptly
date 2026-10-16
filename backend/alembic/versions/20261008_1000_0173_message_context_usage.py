"""Messages remember how full the context was, and with what (WP-1.4).

Revision ID: 0173_message_context_usage
Revises: 0172_share_keep_location
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0173_message_context_usage"
down_revision = "0172_share_keep_location"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("context_usage", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "context_usage")
