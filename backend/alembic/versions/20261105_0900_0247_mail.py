"""Promptly Mail: accounts, folders, a local copy of messages, changes on their
way to the provider, and the outbox. Search is Postgres full text, on this server.

Revision ID: 0247_mail
Revises: 0246_assistant_scope
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0247_mail"
down_revision = "0246_assistant_scope"
branch_labels = None
depends_on = None


def _id() -> sa.Column:
    return sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()"))


def _created() -> sa.Column:
    return sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())


def _account_fk() -> sa.Column:
    return sa.Column("account_id", UUID(as_uuid=True), sa.ForeignKey("mail_accounts.id", ondelete="CASCADE"), nullable=False)


def upgrade() -> None:
    blank = {"nullable": False, "server_default": ""}
    op.create_table(
        "mail_accounts", _id(), _created(),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("display_name", sa.String(120), **blank),
        sa.Column("color", sa.String(9), nullable=False, server_default="#D97757"),
        sa.Column("position", sa.Integer, nullable=False, server_default="0"),
        sa.Column("provider", sa.String(16), nullable=False, server_default="generic"),
        sa.Column("imap_host", sa.String(255), nullable=False),
        sa.Column("imap_port", sa.Integer, nullable=False),
        sa.Column("imap_security", sa.String(8), nullable=False),
        sa.Column("smtp_host", sa.String(255), nullable=False),
        sa.Column("smtp_port", sa.Integer, nullable=False),
        sa.Column("smtp_security", sa.String(8), nullable=False),
        sa.Column("username", sa.String(320), nullable=False),
        sa.Column("secret_encrypted", sa.Text, nullable=False),
        sa.Column("signature", sa.Text, **blank),
        sa.Column("notify", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("status", sa.String(12), nullable=False, server_default="syncing"),
        sa.Column("status_detail", sa.String(300), **blank),
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("user_id", "email", name="uq_mail_account_user_email"),
    )
    op.create_table(
        "mail_folders", _id(), _account_fk(),
        sa.Column("path", sa.String(500), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("role", sa.String(10), nullable=False, server_default="other"),
        sa.Column("uidvalidity", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("last_uid", sa.BigInteger, nullable=False, server_default="0"),
        sa.UniqueConstraint("account_id", "path", name="uq_mail_folder_path"),
    )
    op.create_index("ix_mail_folders_account_id", "mail_folders", ["account_id"])
    op.create_table(
        "mail_messages", _id(), _account_fk(),
        sa.Column("folder_id", UUID(as_uuid=True), sa.ForeignKey("mail_folders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("uid", sa.BigInteger, nullable=True),
        sa.Column("thread_key", sa.String(40), nullable=False),
        sa.Column("message_id", sa.String(500), **blank),
        sa.Column("in_reply_to", sa.String(500), **blank),
        sa.Column("references", sa.Text, **blank),
        sa.Column("subject", sa.Text, **blank),
        sa.Column("from_name", sa.String(320), **blank),
        sa.Column("from_addr", sa.String(320), **blank),
        sa.Column("to_addrs", JSONB, nullable=False, server_default="[]"),
        sa.Column("cc_addrs", JSONB, nullable=False, server_default="[]"),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("snippet", sa.String(240), **blank),
        sa.Column("body_text", sa.Text, **blank),
        sa.Column("body_html", sa.Text, **blank),
        sa.Column("attachments", JSONB, nullable=False, server_default="[]"),
        sa.Column("unsubscribe", sa.String(1000), **blank),
        sa.Column("seen", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("flagged", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("answered", sa.Boolean, nullable=False, server_default="false"),
        sa.UniqueConstraint("folder_id", "uid", name="uq_mail_message_uid"),
    )
    op.create_index("ix_mail_messages_folder_date", "mail_messages", ["folder_id", "sent_at"])
    op.create_index("ix_mail_messages_thread", "mail_messages", ["account_id", "thread_key"])
    op.create_index("ix_mail_messages_message_id", "mail_messages", ["account_id", "message_id"])
    op.execute(
        "CREATE INDEX ix_mail_messages_search ON mail_messages USING gin (to_tsvector('simple', "
        "coalesce(subject,'') || ' ' || coalesce(from_name,'') || ' ' || coalesce(from_addr,'') || ' ' || left(coalesce(body_text,''), 200000)))"
    )
    op.create_table(
        "mail_ops", _id(), _created(), _account_fk(),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("folder_path", sa.String(500), nullable=False),
        sa.Column("uids", JSONB, nullable=False, server_default="[]"),
        sa.Column("target_path", sa.String(500), **blank),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
    )
    op.create_index("ix_mail_ops_account_id", "mail_ops", ["account_id"])
    op.create_table(
        "mail_outbox", _id(), _created(), _account_fk(),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("raw", sa.Text, nullable=False),
        sa.Column("recipients", JSONB, nullable=False, server_default="[]"),
        sa.Column("send_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("status", sa.String(8), nullable=False, server_default="waiting"),
        sa.Column("error", sa.String(300), **blank),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
    )
    op.create_index("ix_mail_outbox_account_id", "mail_outbox", ["account_id"])


def downgrade() -> None:
    for table in ("mail_outbox", "mail_ops", "mail_messages", "mail_folders", "mail_accounts"):
        op.drop_table(table)
