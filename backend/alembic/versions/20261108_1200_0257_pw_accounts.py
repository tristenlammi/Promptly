"""Passwords: accounts found in your own mail, and how far each folder has been read.

Revision ID: 0257_pw_accounts
Revises: 0255_passwords_hardening
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0257_pw_accounts"
down_revision = "0255_passwords_hardening"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mail_account_sites",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("account_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("domain", sa.String(253), nullable=False),
        sa.Column("address", sa.String(320), nullable=False),
        sa.Column("name", sa.String(120), nullable=False, server_default=""),
        sa.Column("kinds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.UniqueConstraint("account_id", "domain", name="uq_pw_mail_site"),
    )
    op.create_index("ix_mail_account_sites_user_id", "mail_account_sites", ["user_id"])
    op.create_table(
        "mail_account_scans",
        sa.Column("folder_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("mail_folders.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("uidvalidity", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("hi_uid", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("lo_uid", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("scanned_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_mail_account_scans_user_id", "mail_account_scans", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_mail_account_scans_user_id", table_name="mail_account_scans")
    op.drop_table("mail_account_scans")
    op.drop_index("ix_mail_account_sites_user_id", table_name="mail_account_sites")
    op.drop_table("mail_account_sites")
