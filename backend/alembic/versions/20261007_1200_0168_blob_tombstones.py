"""Deferred blob deletion: ``blob_tombstones``; document assets leave folders.

Permanent deletes record the blob here instead of unlinking it; a daily
sweep removes it after 14 days if nothing references it again. Gives every
"Delete forever" a recovery window (roadmap WP-0.2).

Also repairs R-027: a document's inline images used to sit in the folder
the document was created in, so moving the document and trashing the old
folder trashed the images too. Existing assets of a live document move out
of the folder tree and out of the trash; new ones are created that way.

And R-026/R-034: the Chat Uploads pruner trashed custom-model knowledge
files and board-card attachments (they upload through the chat route).
Anything it trashed that a model or a card still uses comes back.

Revision ID: 0168_blob_tombstones
Revises: 0167_command_shared
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0168_blob_tombstones"
down_revision = "0167_command_shared"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "blob_tombstones",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("storage_path", sa.String(1024), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("reason", sa.String(32), nullable=False),
        sa.Column("is_dir", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("purge_after", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_blob_tombstones_purge_after", "blob_tombstones", ["purge_after"])
    op.execute(
        """
        UPDATE files a
           SET folder_id = NULL, trashed_at = NULL
          FROM files d
         WHERE a.source_kind = 'document_asset'
           AND a.source_file_id = d.id
        """
    )
    op.execute(
        """
        UPDATE files f
           SET trashed_at = NULL
         WHERE f.trashed_at IS NOT NULL
           AND f.folder_id IN (
                 SELECT id FROM file_folders WHERE system_kind = 'chat_uploads'
               )
           AND (
                 f.id IN (SELECT user_file_id FROM custom_model_files)
              OR f.id::text IN (
                   SELECT a->>'file_id'
                     FROM workspace_tasks t,
                          jsonb_array_elements(
                            CASE WHEN jsonb_typeof(t.attachments) = 'array'
                                 THEN t.attachments ELSE '[]'::jsonb END
                          ) a
                 )
           )
        """
    )


def downgrade() -> None:
    op.drop_index("ix_blob_tombstones_purge_after", table_name="blob_tombstones")
    op.drop_table("blob_tombstones")
