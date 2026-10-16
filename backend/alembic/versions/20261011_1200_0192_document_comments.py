"""Comments on documents and notes, anchored in the text (WP-4.5, R-227).

Drive documents had no comments at all; workspace notes had a flat list
whose "anchor" was a copied string with no position. ``document_comments``
holds threads (a root plus replies) per document file, each root anchored
by two Yjs relative positions so the highlight moves with the text. The
existing note comments are copied in (unanchored, quote kept), so nothing
disappears from notes; the old rows are left as they were.

Revision ID: 0192_document_comments
Revises: 0191_file_activity
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0192_document_comments"
down_revision = "0191_file_activity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "document_comments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("file_id", sa.Uuid(), sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("parent_id", sa.Uuid(), sa.ForeignKey("document_comments.id", ondelete="CASCADE"), nullable=True),
        sa.Column("author_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("quote", sa.Text(), nullable=True),
        sa.Column("anchor", JSONB(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_document_comments_file_id", "document_comments", ["file_id"])
    op.create_index("ix_document_comments_parent_id", "document_comments", ["parent_id"])
    # Notes' existing comments, so their history stays visible.
    op.execute(
        """
        INSERT INTO document_comments (id, file_id, parent_id, author_user_id, body, quote,
                                       anchor, resolved_at, edited_at, created_at)
        SELECT c.id, f.id, NULL, c.author_user_id, c.body, c.quote, NULL,
               c.resolved_at, c.edited_at, c.created_at
        FROM workspace_item_comments c
        JOIN workspace_items i ON i.id = c.item_id AND i.kind = 'note'
        JOIN files f ON f.id = i.ref_id
        """
    )


def downgrade() -> None:
    op.drop_index("ix_document_comments_parent_id", table_name="document_comments")
    op.drop_index("ix_document_comments_file_id", table_name="document_comments")
    op.drop_table("document_comments")
