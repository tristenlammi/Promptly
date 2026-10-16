"""Editor-state snapshots for office files; conditional sheet saves (WP-3.3).

``file_versions`` keeps Yjs-level snapshots of a Document, Sheet or
Whiteboard (Part C §3.4). The collab server writes them in the same
transaction as its store — automatically at most every 10 minutes of
editing and when the last person leaves, and as a **shrink guard** before
storing a state less than half the size of the current one. The backend
adds them before AI applies, imports, clears and restores. A nightly prune
keeps hourly ones for 48 hours and daily ones for 30 days; labelled and
keep-forever ones are kept.

``yjs_state`` is zlib-compressed. ``data`` carries a sheet's workbook JSON
(its structure isn't in the Y.Doc yet). ``preview`` stays NULL until the
version-history UI (P4).

``spreadsheets.data_version`` makes the workbook-JSON save conditional: a
save based on an older version gets a 409 instead of overwriting a
colleague's structure change (the interim fix for defect 12).

Revision ID: 0190_file_versions
Revises: 0189_office_file_shells
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0190_file_versions"
down_revision = "0189_office_file_shells"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "file_versions",
        sa.Column("id", sa.Uuid(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("file_id", sa.Uuid(), sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("yjs_state", sa.LargeBinary(), nullable=True),
        sa.Column("data", postgresql.JSONB(), nullable=True),
        sa.Column("preview", sa.LargeBinary(), nullable=True),
        sa.Column(
            "author_ids",
            postgresql.ARRAY(sa.Uuid()),
            nullable=False,
            server_default=sa.text("'{}'::uuid[]"),
        ),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("label", sa.String(200), nullable=True),
        sa.Column("keep_forever", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("content_hash", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint(
            "source IN ('auto','manual','restore','import','pre_ai','shrink_guard')",
            name="ck_file_versions_source",
        ),
        sa.CheckConstraint(
            "kind IN ('document','sheet','whiteboard')", name="ck_file_versions_kind"
        ),
    )
    op.create_index(
        "ix_file_versions_file_created", "file_versions", ["file_id", sa.text("created_at DESC")]
    )
    op.add_column(
        "spreadsheets",
        sa.Column("data_version", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
    )


def downgrade() -> None:
    op.drop_column("spreadsheets", "data_version")
    op.drop_index("ix_file_versions_file_created", table_name="file_versions")
    op.drop_table("file_versions")
