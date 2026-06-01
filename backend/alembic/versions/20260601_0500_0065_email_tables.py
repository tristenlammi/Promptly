"""Phase 12 (E.1) — Email integration core tables.

Creates:
  email_accounts  — one row per connected Gmail/Outlook account per user
  email_messages  — mirrored messages with AI triage fields
  email_contacts  — derived contact list (powers @person mentions + VIP)
  email_chunks    — pgvector RAG chunks (dual 768/1536 columns like knowledge_chunks)
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID

revision = "0065_email_tables"
down_revision = "0064_app_settings_research_model"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------ #
    # email_accounts                                                       #
    # ------------------------------------------------------------------ #
    op.create_table(
        "email_accounts",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", PG_UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),   # 'google' | 'microsoft'
        sa.Column("email_address", sa.String(320), nullable=False),
        # Fernet-encrypted JSON blob: {access_token, refresh_token, expiry_iso}
        sa.Column("oauth_tokens_encrypted", sa.Text, nullable=True),
        sa.Column("scopes", sa.Text, nullable=True),            # space-separated
        # Gmail incremental sync cursor (historyId). NULL = full resync needed.
        sa.Column("history_id", sa.String(64), nullable=True),
        sa.Column("sync_cursor_expired", sa.Boolean, nullable=False,
                  server_default="false"),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sync_error", sa.Text, nullable=True),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="true"),
        # Indexed so the scheduler can efficiently poll due accounts.
        sa.Column("next_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_email_accounts_user_id", "email_accounts", ["user_id"])
    op.create_index("ix_email_accounts_next_sync_at", "email_accounts", ["next_sync_at"])
    op.create_index(
        "ix_email_accounts_user_provider",
        "email_accounts",
        ["user_id", "provider", "email_address"],
        unique=True,
    )

    # ------------------------------------------------------------------ #
    # email_messages                                                       #
    # ------------------------------------------------------------------ #
    op.create_table(
        "email_messages",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("account_id", PG_UUID(as_uuid=True),
                  sa.ForeignKey("email_accounts.id", ondelete="CASCADE"),
                  nullable=False),
        # user_id denormalised for fast per-user queries without joining accounts
        sa.Column("user_id", PG_UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("provider_message_id", sa.String(256), nullable=False),
        sa.Column("thread_id", sa.String(256), nullable=True),
        sa.Column("subject", sa.Text, nullable=True),
        sa.Column("from_address", sa.String(320), nullable=True),
        sa.Column("from_name", sa.String(256), nullable=True),
        sa.Column("to_addresses", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("cc_addresses", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("date", sa.DateTime(timezone=True), nullable=True),
        # Short preview shown in list view (≤200 chars, no HTML)
        sa.Column("snippet", sa.Text, nullable=True),
        # Full body. Pruned to NULL after retention_days; metadata kept.
        sa.Column("body_text", sa.Text, nullable=True),
        sa.Column("body_html", sa.Text, nullable=True),
        sa.Column("has_attachments", sa.Boolean, nullable=False, server_default="false"),
        # UUIDs of UserFile rows created in the Email Attachments system folder
        sa.Column("attachment_file_ids", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        # Original provider labels (Gmail label IDs) — reference only, not used for UI
        sa.Column("provider_labels", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        # Two-way sync state (mirrors Gmail)
        sa.Column("read", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("archived", sa.Boolean, nullable=False, server_default="false"),
        # Pending writeback flags: these are set when user acts in Promptly but the
        # Gmail API call hasn't run yet (picked up next sync loop)
        sa.Column("writeback_read", sa.Boolean, nullable=True),
        sa.Column("writeback_archived", sa.Boolean, nullable=True),
        # AI triage fields (populated by triage.py)
        # category: action_required | fyi | newsletter | promotional | social | spam
        sa.Column("ai_category", sa.String(32), nullable=True),
        sa.Column("ai_priority", sa.Integer, nullable=True),       # 0–10
        sa.Column("ai_summary", sa.Text, nullable=True),
        sa.Column("needs_reply", sa.Boolean, nullable=True),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("triaged_at", sa.DateTime(timezone=True), nullable=True),
        # 'bulk_heuristic' | 'triage_disabled' | etc.
        sa.Column("triage_skipped_reason", sa.String(64), nullable=True),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_email_messages_account_id", "email_messages", ["account_id"])
    op.create_index("ix_email_messages_user_id", "email_messages", ["user_id"])
    op.create_index("ix_email_messages_date", "email_messages", ["date"])
    op.create_index("ix_email_messages_thread_id", "email_messages", ["thread_id"])
    op.create_index(
        "ix_email_messages_needs_triage",
        "email_messages",
        ["account_id", "triaged_at"],
    )
    op.create_index(
        "ix_email_messages_provider_unique",
        "email_messages",
        ["account_id", "provider_message_id"],
        unique=True,
    )

    # ------------------------------------------------------------------ #
    # email_contacts                                                       #
    # ------------------------------------------------------------------ #
    op.create_table(
        "email_contacts",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", PG_UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("email_address", sa.String(320), nullable=False),
        sa.Column("display_name", sa.String(256), nullable=True),
        sa.Column("is_vip", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("message_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_email_contacts_user_id", "email_contacts", ["user_id"])
    op.create_index(
        "ix_email_contacts_user_address",
        "email_contacts",
        ["user_id", "email_address"],
        unique=True,
    )

    # ------------------------------------------------------------------ #
    # email_chunks  (pgvector RAG, mirrors knowledge_chunks pattern)      #
    # ------------------------------------------------------------------ #
    # Note: vector columns are added as raw SQL because SQLAlchemy's
    # Column() doesn't know the pgvector type natively — the same pattern
    # used by message_embeddings (migration 0058).
    op.create_table(
        "email_chunks",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("email_id", PG_UUID(as_uuid=True),
                  sa.ForeignKey("email_messages.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("user_id", PG_UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("chunk_index", sa.Integer, nullable=False),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("embedding_model", sa.String(128), nullable=True),
        sa.Column("embed_dim", sa.Integer, nullable=True),
        sa.Column("content_hash", sa.String(64), nullable=True),
        # Metadata: sender, date, subject for injection into retrieved context
        sa.Column("chunk_metadata", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_email_chunks_email_id", "email_chunks", ["email_id"])
    op.create_index("ix_email_chunks_user_id", "email_chunks", ["user_id"])
    op.create_index(
        "ix_email_chunks_user_email_idx",
        "email_chunks",
        ["user_id", "email_id", "chunk_index"],
        unique=True,
    )

    # Add pgvector columns and HNSW indexes (raw SQL, same as 0058)
    op.execute("ALTER TABLE email_chunks ADD COLUMN embedding_768 vector(768)")
    op.execute("ALTER TABLE email_chunks ADD COLUMN embedding_1536 vector(1536)")
    op.execute(
        "CREATE INDEX ix_email_chunks_embedding_768_hnsw ON email_chunks "
        "USING hnsw (embedding_768 vector_cosine_ops) "
        "WHERE embedding_768 IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX ix_email_chunks_embedding_1536_hnsw ON email_chunks "
        "USING hnsw (embedding_1536 vector_cosine_ops) "
        "WHERE embedding_1536 IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_table("email_chunks")
    op.drop_table("email_contacts")
    op.drop_table("email_messages")
    op.drop_table("email_accounts")
