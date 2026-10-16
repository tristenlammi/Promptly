"""File hashes and blob state (WP-7.1, Part C §5.2).

``files.content_sha256`` and ``sha1`` are recorded as canonical bytes are
written (uploads, a document's pictures, chat-made files); older rows are
filled in by a throttled backfill. ``blob_state`` is ready / ingesting /
missing / damaged — what the integrity scrubber (WP-7.2) found — and
``verified_at`` when the bytes were last checked against the hash.

Revision ID: 0199_file_hashes
Revises: 0198_link_roles
"""
from alembic import op
import sqlalchemy as sa

revision = "0199_file_hashes"
down_revision = "0198_link_roles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("files", sa.Column("content_sha256", sa.String(64), nullable=True))
    op.add_column("files", sa.Column("sha1", sa.String(40), nullable=True))
    op.add_column(
        "files", sa.Column("blob_state", sa.String(16), nullable=False, server_default="ready")
    )
    op.add_column("files", sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        "ck_files_blob_state", "files", "blob_state IN ('ready','ingesting','missing','damaged')"
    )
    # Per-user lookups by content (dedup, sync clients' "do you have this?").
    op.create_index(
        "ix_files_user_sha256",
        "files",
        ["user_id", "content_sha256"],
        postgresql_where=sa.text("content_sha256 IS NOT NULL"),
    )
    # The backfill's queue.
    op.create_index(
        "ix_files_unhashed",
        "files",
        ["created_at"],
        postgresql_where=sa.text("content_sha256 IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_files_unhashed", table_name="files")
    op.drop_index("ix_files_user_sha256", table_name="files")
    op.drop_constraint("ck_files_blob_state", "files", type_="check")
    op.drop_column("files", "verified_at")
    op.drop_column("files", "blob_state")
    op.drop_column("files", "sha1")
    op.drop_column("files", "content_sha256")
