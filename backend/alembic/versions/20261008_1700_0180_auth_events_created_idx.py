"""Index the audit log by time, for date filters and retention (R-145).

Revision ID: 0180_auth_events_created_idx
Revises: 0179_sso_identity_binding
"""
from alembic import op

revision = "0180_auth_events_created_idx"
down_revision = "0179_sso_identity_binding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS ix_auth_events_created_at ON auth_events (created_at)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_error_events_created_at ON error_events (created_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_error_events_created_at")
    op.execute("DROP INDEX IF EXISTS ix_auth_events_created_at")
