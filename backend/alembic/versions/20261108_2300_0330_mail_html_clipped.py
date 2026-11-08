"""Mail: an email whose HTML is too big or tangled to clean quickly shows as plain text, and
says so.

Revision ID: 0330_mail_html_clipped
Revises: 0321_user_blocks
"""
import sqlalchemy as sa
from alembic import op

revision = "0330_mail_html_clipped"
down_revision = "0321_user_blocks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mail_messages", sa.Column("html_clipped", sa.Boolean, nullable=False, server_default="false"))


def downgrade() -> None:
    op.drop_column("mail_messages", "html_clipped")
