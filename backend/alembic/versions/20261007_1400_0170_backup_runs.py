"""``backup_runs``: a record of every database dump (WP-0.2).

Backs the admin Backups card ("Last backup: today") and the failure alert.

Revision ID: 0170_backup_runs
Revises: 0169_roster_revision
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0170_backup_runs"
down_revision = "0169_roster_revision"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "backup_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("filename", sa.String(255), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("revision", sa.String(64), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_backup_runs_created_at", "backup_runs", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_backup_runs_created_at", table_name="backup_runs")
    op.drop_table("backup_runs")
