"""Proposals outside workspaces — "organise my files" (WP-5.3).

The AI's write-back proposals were workspace-only (a note, board cards), so
``workspace_proposals.workspace_id`` was required. A chat anywhere can now
propose moving, renaming and making folders in your Drive, applied from the
same preview card — those proposals belong to no workspace.

Revision ID: 0194_file_proposals
Revises: 0193_drive_index
"""
from alembic import op

revision = "0194_file_proposals"
down_revision = "0193_drive_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("workspace_proposals", "workspace_id", nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM workspace_proposals WHERE workspace_id IS NULL")
    op.alter_column("workspace_proposals", "workspace_id", nullable=False)
