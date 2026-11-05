"""A label is a place, not a tag: a conversation sits under one at a time, and every
rule takes mail out of the Inbox.

Revision ID: 0252_mail_label_folders
Revises: 0251_mail_apps
"""
import sqlalchemy as sa
from alembic import op

revision = "0252_mail_label_folders"
down_revision = "0251_mail_apps"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # If one had several, keep one so the rule below can hold.
    op.execute(
        "DELETE FROM mail_thread_labels a USING mail_thread_labels b "
        "WHERE a.account_id = b.account_id AND a.thread_key = b.thread_key AND a.label_id > b.label_id"
    )
    op.drop_index("ix_mail_thread_labels_thread", table_name="mail_thread_labels")
    op.create_index("ux_mail_thread_labels_thread", "mail_thread_labels", ["account_id", "thread_key"], unique=True)
    op.drop_column("mail_rules", "skip_inbox")


def downgrade() -> None:
    op.add_column("mail_rules", sa.Column("skip_inbox", sa.Boolean, nullable=False, server_default="true"))
    op.drop_index("ux_mail_thread_labels_thread", table_name="mail_thread_labels")
    op.create_index("ix_mail_thread_labels_thread", "mail_thread_labels", ["account_id", "thread_key"])
