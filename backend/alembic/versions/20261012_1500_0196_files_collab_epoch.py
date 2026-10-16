"""Edit generations for office files (WP-6.2).

Restoring a version replaces a document's, sheet's or whiteboard's whole
shared-editing state. A browser that still holds the newer state would
merge it straight back in when it reconnects, so each office file now has
``collab_epoch``: bumped by a restore, stamped into every collab token, and
checked by the collab server and the editors — an editor from an older
generation reloads instead of merging.

Versions also start counting toward storage (Part C §3.9) — from
``app_settings.versions_quota_from``, 30 days after this upgrade, so nobody
is pushed over their cap overnight.

Revision ID: 0196_files_collab_epoch
Revises: 0195_files_tsv_simple
"""
from alembic import op
import sqlalchemy as sa

revision = "0196_files_collab_epoch"
down_revision = "0195_files_tsv_simple"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("files", sa.Column("collab_epoch", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("app_settings", sa.Column("versions_quota_from", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE app_settings SET versions_quota_from = now() + interval '30 days'")


def downgrade() -> None:
    op.drop_column("app_settings", "versions_quota_from")
    op.drop_column("files", "collab_epoch")
