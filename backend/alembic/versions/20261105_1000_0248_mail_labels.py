"""Mail labels and the rules that fill them. Labels live in Promptly, not in the
mailbox, so they work the same on every provider and across mailboxes.

Revision ID: 0248_mail_labels
Revises: 0247_mail
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0248_mail_labels"
down_revision = "0247_mail"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mail_labels",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("color", sa.String(9), nullable=False, server_default="#D97757"),
        sa.UniqueConstraint("user_id", "name", name="uq_mail_label_name"),
    )
    op.create_table(
        "mail_thread_labels",
        sa.Column("label_id", UUID(as_uuid=True), sa.ForeignKey("mail_labels.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("account_id", UUID(as_uuid=True), sa.ForeignKey("mail_accounts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("thread_key", sa.String(40), primary_key=True),
    )
    op.create_index("ix_mail_thread_labels_thread", "mail_thread_labels", ["account_id", "thread_key"])
    op.create_table(
        "mail_rules",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("label_id", UUID(as_uuid=True), sa.ForeignKey("mail_labels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("value", sa.String(320), nullable=False),
        sa.Column("skip_inbox", sa.Boolean, nullable=False, server_default="true"),
        sa.UniqueConstraint("label_id", "kind", "value", name="uq_mail_rule"),
    )


def downgrade() -> None:
    op.drop_table("mail_rules")
    op.drop_table("mail_thread_labels")
    op.drop_table("mail_labels")
