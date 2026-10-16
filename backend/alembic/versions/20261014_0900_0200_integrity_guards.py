"""Integrity checks and the mass-delete guard (WP-7.2, Part C §5.4).

``storage_checks`` — one row per run of the nightly scrubber: how many files
it looked at, re-hashed, found missing or damaged, and how many unreferenced
blobs it moved to ``.quarantine/``.

``files`` / ``file_folders``: ``trashed_by`` and ``trashed_credential`` —
who sent something to the trash, and from which session ("session:<sid>";
an app password later). A burst from one session is what the mass-delete
guard watches for, and what "restore everything this device deleted" puts
back.

Revision ID: 0200_integrity_guards
Revises: 0199_file_hashes
"""
from alembic import op
import sqlalchemy as sa

revision = "0200_integrity_guards"
down_revision = "0199_file_hashes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "storage_checks",
        sa.Column("id", sa.Uuid(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="running"),
        sa.Column("trigger", sa.String(16), nullable=False, server_default="nightly"),
        sa.Column("checked", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("verified", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("bytes_verified", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("missing", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("damaged", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("recovered", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("quarantined", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.CheckConstraint("status IN ('running','ok','problems','failed')", name="ck_storage_checks_status"),
    )
    op.create_index("ix_storage_checks_started", "storage_checks", [sa.text("started_at DESC")])
    for table in ("files", "file_folders"):
        op.add_column(table, sa.Column("trashed_by", sa.Uuid(), nullable=True))
        op.add_column(table, sa.Column("trashed_credential", sa.String(64), nullable=True))
    op.create_index(
        "ix_files_trashed_credential",
        "files",
        ["trashed_by", "trashed_credential", "trashed_at"],
        postgresql_where=sa.text("trashed_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_files_trashed_credential", table_name="files")
    for table in ("files", "file_folders"):
        op.drop_column(table, "trashed_credential")
        op.drop_column(table, "trashed_by")
    op.drop_index("ix_storage_checks_started", table_name="storage_checks")
    op.drop_table("storage_checks")
