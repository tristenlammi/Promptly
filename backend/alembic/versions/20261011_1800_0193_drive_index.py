"""Ask your Drive — a per-user Drive scope in the search index (WP-5.1).

Chats could search a workspace's files, an assistant's library or a chat's
attachments, but not "my files". ``knowledge_chunks`` gets a fourth owner,
``drive_user_id`` (the file's owner — indexing is their opt-in, because
the embedder may be a cloud API), and ``drive_index_state`` remembers what
was indexed from which version of each file, so a background pass only
re-embeds what changed.

Revision ID: 0193_drive_index
Revises: 0192_document_comments
"""
from alembic import op
import sqlalchemy as sa

revision = "0193_drive_index"
down_revision = "0192_document_comments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "knowledge_chunks",
        sa.Column("drive_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
    )
    op.create_index("ix_knowledge_chunks_drive_user_id", "knowledge_chunks", ["drive_user_id"])
    op.execute(
        "CREATE UNIQUE INDEX uq_knowledge_chunks_drive_chunk "
        "ON knowledge_chunks (drive_user_id, user_file_id, chunk_index) "
        "WHERE drive_user_id IS NOT NULL"
    )
    op.drop_constraint("ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check")
    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int"
        " + (workspace_id IS NOT NULL)::int"
        " + (conversation_id IS NOT NULL)::int"
        " + (drive_user_id IS NOT NULL)::int) = 1",
    )
    op.create_table(
        "drive_index_state",
        sa.Column("file_id", sa.Uuid(), sa.ForeignKey("files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=True),
        sa.Column("embedding_model", sa.String(128), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("chunks", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('ready','failed','skipped')", name="ck_drive_index_state_status"),
    )
    op.create_index("ix_drive_index_state_user_id", "drive_index_state", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_drive_index_state_user_id", table_name="drive_index_state")
    op.drop_table("drive_index_state")
    op.drop_constraint("ck_knowledge_chunks_one_scope", "knowledge_chunks", type_="check")
    op.execute("DELETE FROM knowledge_chunks WHERE drive_user_id IS NOT NULL")
    op.create_check_constraint(
        "ck_knowledge_chunks_one_scope",
        "knowledge_chunks",
        "((custom_model_id IS NOT NULL)::int"
        " + (workspace_id IS NOT NULL)::int"
        " + (conversation_id IS NOT NULL)::int) = 1",
    )
    op.execute("DROP INDEX IF EXISTS uq_knowledge_chunks_drive_chunk")
    op.drop_index("ix_knowledge_chunks_drive_user_id", table_name="knowledge_chunks")
    op.drop_column("knowledge_chunks", "drive_user_id")
