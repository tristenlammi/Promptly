"""Embedding model fingerprint on memories and message vectors (R-317).

A same-dimension embedder switch mixed two models' vector spaces in every
similarity query. Queries now keep to vectors made by the current model;
these columns record which model made each one. Existing rows are stamped
with the current model when their dimension matches it.

Also indexes messages by created_at / edited_at so the message indexer's
idle cycles look only at what changed since its watermark (R-323).

Revision ID: 0186_embed_model_fingerprint
Revises: 0185_task_notify_mode
"""
from alembic import op
import sqlalchemy as sa

revision = "0186_embed_model_fingerprint"
down_revision = "0185_task_notify_mode"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("user_memories", "message_embeddings"):
        op.add_column(table, sa.Column("embed_model", sa.String(255), nullable=True))
        op.execute(
            f"""
            UPDATE {table} t SET embed_model = s.embedding_model_id
            FROM app_settings s
            WHERE s.embedding_model_id IS NOT NULL AND t.embed_dim = s.embedding_dim
            """
        )
    op.create_index("ix_messages_created_at", "messages", ["created_at"])
    op.create_index(
        "ix_messages_edited_at",
        "messages",
        ["edited_at"],
        postgresql_where=sa.text("edited_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_messages_edited_at", table_name="messages")
    op.drop_index("ix_messages_created_at", table_name="messages")
    for table in ("user_memories", "message_embeddings"):
        op.drop_column(table, "embed_model")
