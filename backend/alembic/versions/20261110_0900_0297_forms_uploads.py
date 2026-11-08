"""Forms (WP-F1.6): files sent with answers — each form's daily allowance.

* ``app_settings.forms_upload_cap_mb`` — how much a form for people on
  this server may take in files in 24 hours (default 500 MB).
* ``app_settings.forms_link_upload_cap_mb`` — the same for a link form
  ("Anyone with the link"; default 100 MB).

The files themselves are ``files`` rows of the hidden ``form_upload`` kind
and ``form_uploads`` rows (both from ``0290_forms_core``).

Revision ID: 0297_forms_uploads
Revises: 0291_forms_sheet
"""
import sqlalchemy as sa
from alembic import op

revision = "0297_forms_uploads"
down_revision = "0291_forms_sheet"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "app_settings",
        sa.Column("forms_upload_cap_mb", sa.Integer(), nullable=False, server_default="500"),
    )
    op.add_column(
        "app_settings",
        sa.Column("forms_link_upload_cap_mb", sa.Integer(), nullable=False, server_default="100"),
    )


def downgrade() -> None:
    op.drop_column("app_settings", "forms_link_upload_cap_mb")
    op.drop_column("app_settings", "forms_upload_cap_mb")
