"""Spreadsheet live collaboration: Y.Doc state columns.

Adds ``yjs_update`` (the merged Excalidraw-style Y.Doc for the sheet) and a
monotonic ``version`` to ``spreadsheets`` so the collab server can persist the
``sheet:<id>`` room's CRDT state — mirroring ``workspace_canvas``. Existing
rows are backfilled with an empty Y.Doc (the first collab session then starts
fresh and seeds from the stored ``data`` JSON).

Revision ID: 0104_spreadsheet_collab
Revises: 0103_workspace_memory_mode
Create Date: 2026-06-21 05:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0104_spreadsheet_collab"
down_revision: Union[str, Sequence[str], None] = "0103_workspace_memory_mode"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "spreadsheets",
        sa.Column(
            "yjs_update",
            sa.LargeBinary(),
            nullable=False,
            server_default=sa.text("''::bytea"),
        ),
    )
    op.add_column(
        "spreadsheets",
        sa.Column(
            "version",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
    )
    # ``yjs_update`` gets its value from the ORM (default=b""); drop the
    # backfill default. ``version`` keeps server_default="0" to match the model.
    op.alter_column("spreadsheets", "yjs_update", server_default=None)


def downgrade() -> None:
    op.drop_column("spreadsheets", "version")
    op.drop_column("spreadsheets", "yjs_update")
