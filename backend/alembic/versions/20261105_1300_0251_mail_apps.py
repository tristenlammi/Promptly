"""Mail with the rest of Promptly: invites read from email, and what you answered.

Revision ID: 0251_mail_apps
Revises: 0250_mail_complete
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0251_mail_apps"
down_revision = "0250_mail_complete"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mail_messages", sa.Column("invite", JSONB, nullable=True))
    op.create_table(
        "mail_invites",
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("uid", sa.String(300), primary_key=True),
        sa.Column("event_id", UUID(as_uuid=True), sa.ForeignKey("cal_events.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("sequence", sa.Integer, nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("mail_invites")
    op.drop_column("mail_messages", "invite")
