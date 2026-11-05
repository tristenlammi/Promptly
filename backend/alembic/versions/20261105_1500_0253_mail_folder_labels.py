"""A mailbox's own folders (Gmail's labels, say) show as Promptly labels.

Revision ID: 0253_mail_folder_labels
Revises: 0252_mail_label_folders
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0253_mail_folder_labels"
down_revision = "0252_mail_label_folders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mail_folders", sa.Column("label_id", UUID(as_uuid=True), sa.ForeignKey("mail_labels.id", ondelete="SET NULL"), nullable=True, index=True))
    # You removed its label: don't bring it back on the next sync.
    op.add_column("mail_folders", sa.Column("label_off", sa.Boolean, nullable=False, server_default="false"))


def downgrade() -> None:
    op.drop_column("mail_folders", "label_off")
    op.drop_column("mail_folders", "label_id")
