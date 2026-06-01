"""Phase 12 (E.1) — Backfill Email Attachments system folder for existing users.

The folder is lazily seeded on first email account connection (not at registration)
so users without email integration never see it. This migration only adds the
system_kind enum value; the ensure_email_attachments() helper handles creation.

No data changes needed — the SystemKind.EMAIL_ATTACHMENTS value is purely in
Python enum space. This migration exists to document the schema addition and
provide a rollback anchor.
"""
from __future__ import annotations

from alembic import op

revision = "0067_email_attachments_folder"
down_revision = "0066_app_settings_email"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # No schema change needed — system_kind is a free-form String(64) column
    # (see migration 0010). The new value 'email_attachments' is a Python-land
    # enum addition; Postgres accepts any string that fits in 64 chars.
    pass


def downgrade() -> None:
    # Remove any email_attachments system folders if rolling back.
    op.execute(
        "DELETE FROM file_folders WHERE system_kind = 'email_attachments'"
    )
