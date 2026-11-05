"""AI search for mail: one vector per email, and the admin's switch for all of
Promptly. No vector index on purpose: a search only ever looks at one person's
mailboxes, which an exact scan handles quickly, and an approximate index that
filters afterwards could miss their mail entirely.

Revision ID: 0249_mail_search
Revises: 0248_mail_labels
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0249_mail_search"
down_revision = "0248_mail_labels"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mail_vectors",
        sa.Column("message_id", UUID(as_uuid=True), sa.ForeignKey("mail_messages.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("account_id", UUID(as_uuid=True), sa.ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("model", sa.String(128), nullable=False),
    )
    op.execute("ALTER TABLE mail_vectors ADD COLUMN embedding_768 vector(768), ADD COLUMN embedding_1536 vector(1536)")
    # Unset means automatic: on with an indexer on this network, off with a cloud one.
    op.add_column("app_settings", sa.Column("mail_ai_search", sa.Boolean, nullable=True))
    # The cloud provider the admin agreed to send mail to. Agreeing to one isn't
    # agreeing to whichever gets chosen next.
    op.add_column("app_settings", sa.Column("mail_ai_search_provider", UUID(as_uuid=True), nullable=True))


def downgrade() -> None:
    op.drop_column("app_settings", "mail_ai_search_provider")
    op.drop_column("app_settings", "mail_ai_search")
    op.drop_table("mail_vectors")
