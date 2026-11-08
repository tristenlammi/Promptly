"""Passwords: where stray passwords were found in Mail, Files and Photos.

Locations and kinds only. No secret, no hash of one and no preview is stored: those are
worked out again from the source each time someone looks.

Revision ID: 0256_pw_stray
Revises: 0257_pw_accounts
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0256_pw_stray"
down_revision = "0257_pw_accounts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pw_stray_findings",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("source", sa.String(8), nullable=False),
        sa.Column("source_id", UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("hits", sa.Integer, nullable=False, server_default="1"),
        sa.Column("found_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("ignored_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("user_id", "source", "source_id", "kind", name="uq_pw_stray_finding"),
    )
    op.create_table(
        "pw_stray_state",
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("cursors", JSONB, nullable=False, server_default="{}"),
        sa.Column("requested_at", sa.DateTime(timezone=True)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    op.drop_table("pw_stray_state")
    op.drop_table("pw_stray_findings")
