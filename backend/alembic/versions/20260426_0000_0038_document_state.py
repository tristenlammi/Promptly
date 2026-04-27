"""Drive documents — per-document CRDT state.

Adds the ``document_state`` table that the Hocuspocus collab service
persists Y.js binary updates to. One row per document, keyed by the
owning ``files.id``. The ``UserFile`` row itself continues to hold
metadata, the rendered HTML snapshot on disk, and the FTS
``content_text`` — so ordinary Drive listings, previews, downloads,
and search keep working without knowing anything about Y.js.

Schema notes:

- ``file_id`` is a 1:1 FK onto ``files.id`` with ``ON DELETE CASCADE``
  so deleting the document (trash-empty, admin purge) also drops the
  CRDT state. Primary key means we never accidentally keep two
  competing Y.Docs for the same file.
- ``yjs_update`` is the binary blob the Hocuspocus Database extension
  hands us — the full Y.Doc state (not a delta). We intentionally
  overwrite on every store rather than append because Y.js already
  merges history inside that blob; maintaining an append-only log is
  a separate Stage-2 "version history" feature.
- ``version`` is a monotonic counter the collab server bumps on each
  store. Used by the backend snapshot endpoint to ignore out-of-order
  stragglers if two Hocuspocus replicas ever race.
- ``updated_at`` gives the UI a cheap "last edited" indicator without
  touching the Y.Doc.

Revision ID: 0038_document_state
Revises: 0037_file_share_links
Create Date: 2026-04-26 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0038_document_state"
down_revision: Union[str, None] = "0037_file_share_links"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "document_state",
        sa.Column(
            "file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("yjs_update", sa.LargeBinary(), nullable=False),
        sa.Column(
            "version",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    op.drop_table("document_state")
