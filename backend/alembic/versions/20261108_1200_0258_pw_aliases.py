"""Passwords: alias domains, aliases, and the mail each alias got.

Revision ID: 0258_pw_aliases
Revises: 0256_pw_stray
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0258_pw_aliases"
down_revision = "0256_pw_stray"
branch_labels = None
depends_on = None


def _created():
    return sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)


def upgrade() -> None:
    op.create_table(
        "mail_alias_domains",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("account_id", UUID(as_uuid=True), sa.ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("domain", sa.String(253), nullable=False),
        sa.Column("word_style", sa.String(8), nullable=False, server_default="word"),
        sa.Column("random_len", sa.Integer, nullable=False, server_default="4"),
        sa.Column("separator", sa.String(1), nullable=False, server_default="."),
        sa.Column("off_folder_id", UUID(as_uuid=True), sa.ForeignKey("mail_folders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(10), nullable=False, server_default="new"),
        sa.Column("status_detail", sa.String(300), nullable=False, server_default=""),
        sa.Column("check_local", sa.String(64), nullable=False, server_default=""),
        sa.Column("check_from", sa.String(320), nullable=False, server_default=""),
        sa.Column("check_started_at", sa.DateTime(timezone=True)),
        sa.Column("checked_at", sa.DateTime(timezone=True)),
        sa.Column("send_as", sa.String(10), nullable=False, server_default="unknown"),
        sa.Column("send_as_detail", sa.String(300), nullable=False, server_default=""),
        _created(),
        sa.UniqueConstraint("user_id", "domain", name="uq_mail_alias_domain"),
    )
    op.create_table(
        "mail_aliases",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("domain_id", UUID(as_uuid=True), sa.ForeignKey("mail_alias_domains.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("address", sa.String(320), nullable=False),
        sa.Column("item_id", UUID(as_uuid=True), nullable=True),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("disabled_at", sa.DateTime(timezone=True)),
        sa.Column("baseline", sa.String(253), nullable=False, server_default=""),
        sa.Column("allowed_senders", JSONB, nullable=False, server_default="[]"),
        sa.Column("flagged_at", sa.DateTime(timezone=True)),
        sa.Column("flagged_sender", sa.String(253), nullable=False, server_default=""),
        _created(),
        sa.UniqueConstraint("user_id", "address", name="uq_mail_alias_address"),
    )
    op.create_table(
        "mail_alias_hits",
        sa.Column("alias_id", UUID(as_uuid=True), sa.ForeignKey("mail_aliases.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("msg_key", sa.String(500), primary_key=True),
        sa.Column("account_id", UUID(as_uuid=True), sa.ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sender_domain", sa.String(253), nullable=False, server_default=""),
        sa.Column("sent_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("unlike", sa.Boolean, nullable=False, server_default="false"),
    )
    op.create_index("ix_mail_alias_hits_lookup", "mail_alias_hits", ["account_id", "msg_key"])


def downgrade() -> None:
    op.drop_index("ix_mail_alias_hits_lookup", table_name="mail_alias_hits")
    op.drop_table("mail_alias_hits")
    op.drop_table("mail_aliases")
    op.drop_table("mail_alias_domains")
