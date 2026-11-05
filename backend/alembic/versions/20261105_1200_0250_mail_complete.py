"""Mail, the rest of it: older mail coming in over time, sorting by AI, snoozing,
trusting a mail server on your own network, and a notification setting.

Revision ID: 0250_mail_complete
Revises: 0249_mail_search
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0250_mail_complete"
down_revision = "0249_mail_search"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # How far back we've copied. 0: not started; 1: nothing older left.
    op.add_column("mail_folders", sa.Column("oldest_uid", sa.BigInteger, nullable=False, server_default="0"))
    # Proton Bridge and the like use their own certificate: you agreed to this one.
    op.add_column("mail_accounts", sa.Column("cert_pin", sa.String(95), nullable=False, server_default=""))
    op.add_column("mail_messages", sa.Column("reply_to", sa.String(320), nullable=False, server_default=""))
    op.add_column("mail_messages", sa.Column("triaged", sa.Boolean, nullable=False, server_default="false"))
    op.add_column("mail_messages", sa.Column("needs_reply", sa.Boolean, nullable=True))
    op.add_column("mail_messages", sa.Column("summary", sa.String(240), nullable=False, server_default=""))
    op.create_table(
        "mail_snoozes",
        sa.Column("account_id", UUID(as_uuid=True), sa.ForeignKey("mail_accounts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("thread_key", sa.String(40), primary_key=True),
        sa.Column("until", sa.DateTime(timezone=True), nullable=False, index=True),
    )
    op.add_column("push_preferences", sa.Column("mail", sa.Boolean, nullable=False, server_default="true"))


def downgrade() -> None:
    op.drop_column("push_preferences", "mail")
    op.drop_table("mail_snoozes")
    op.drop_column("mail_messages", "summary")
    op.drop_column("mail_messages", "needs_reply")
    op.drop_column("mail_messages", "triaged")
    op.drop_column("mail_messages", "reply_to")
    op.drop_column("mail_accounts", "cert_pin")
    op.drop_column("mail_folders", "oldest_uid")
