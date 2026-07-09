"""Drop workspace folders — Notebooks are now the single grouping primitive.

Deletes every ``workspace_items`` row of ``kind='folder'``. The self-
referential ``parent_id`` FK (``ON DELETE CASCADE``) removes their
descendants too, so anything filed inside a folder goes with it — which is
what we want: no users had folders, so this is a clean removal rather than a
folder→notebook conversion. Irreversible; downgrade is a no-op.
"""
from __future__ import annotations

from alembic import op

revision = "0149_drop_ws_folders"
down_revision = "0148_chat_folders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Cascade (parent_id ON DELETE CASCADE) reaps each folder's whole subtree.
    op.execute("DELETE FROM workspace_items WHERE kind = 'folder'")


def downgrade() -> None:
    # Folders are gone for good; there's nothing to restore.
    pass
