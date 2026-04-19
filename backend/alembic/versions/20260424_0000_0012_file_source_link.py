"""Add ``source_kind`` + ``source_file_id`` to ``files`` for AI artefacts.

Phase A2 introduces the ``generate_pdf`` chat tool, which authors a
document by persisting two rows:

* a ``markdown_source`` Markdown file (editable later via the side-panel
  editor in Phase A3); and
* a ``rendered_pdf`` PDF rendered from that Markdown.

The PDF row keeps a pointer back at its source via ``source_file_id``
so a future edit-and-re-render can find the right blob to overwrite.
Both columns are nullable — every existing user upload (and every file
generated under Phase A1) will read NULL on both, which is the correct
"unknown / not part of an artefact pair" answer.

The FK is self-referential (``files.id`` → ``files.id``) and uses
ON DELETE SET NULL so deleting a Markdown source doesn't take its
PDF down with it; the user just loses the ability to re-render.

Revision ID: 0012_file_source_link
Revises: 0011_seed_system_folders
Create Date: 2026-04-24 00:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012_file_source_link"
down_revision: Union[str, Sequence[str], None] = "0011_seed_system_folders"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "files",
        sa.Column("source_kind", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "files",
        sa.Column(
            "source_file_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    # Self-referential FK. Named explicitly so the downgrade can drop it
    # without relying on the auto-generated name (which differs across
    # postgres versions in older alembic releases).
    op.create_foreign_key(
        "fk_files_source_file_id",
        source_table="files",
        referent_table="files",
        local_cols=["source_file_id"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )
    # Indexes mirror the kind we already use for ``system_kind`` on
    # ``file_folders``: source_kind is filtered on by the editor lookup
    # path, source_file_id by "find the rendered child of this source".
    op.create_index(
        "ix_files_source_kind",
        "files",
        ["source_kind"],
    )
    op.create_index(
        "ix_files_source_file_id",
        "files",
        ["source_file_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_files_source_file_id", table_name="files")
    op.drop_index("ix_files_source_kind", table_name="files")
    op.drop_constraint(
        "fk_files_source_file_id", "files", type_="foreignkey"
    )
    op.drop_column("files", "source_file_id")
    op.drop_column("files", "source_kind")
