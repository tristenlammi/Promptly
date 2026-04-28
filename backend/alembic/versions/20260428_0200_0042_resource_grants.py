"""Promptly Drive — peer-to-peer share grants + retire admin-managed pool.

Replaces the original "shared pool" semantics (folders/files where
``user_id IS NULL`` were globally readable, admin-writable) with a
proper per-user ACL: any user can grant 1..10 specific Promptly
users access to one of their own folders or files, with a per-grantee
``can_copy`` permission flag.

This migration does three things:

1. **Creates** ``resource_grants`` (polymorphic via ``resource_type``
   ``+`` ``resource_id``, mirroring ``file_share_links``). Indexes
   match every common query: by resource (modal listing), by grantee
   (Shared tab), by owner (audit / cleanup).

2. **Wipes** every legacy ``user_id IS NULL`` row in ``file_folders``
   and ``files``. Per the product decision, the admin-managed global
   pool is retired entirely; new sharing all routes through
   ``resource_grants``. We delete files first (cascade on ``folder_id``
   is SET NULL, so deleting the folder first would just orphan them
   at root), then folders.

3. **Cleans up the on-disk blobs** for those wiped files. Storage paths
   are stored relative to ``PROMPTLY_UPLOAD_ROOT`` (default
   ``/app/uploads``); we unlink each one inside a try/except so a
   missing-on-disk row never blocks the schema migration.

Downgrade can't restore the deleted rows or blobs — it only drops
``resource_grants``. That's fine for our environment (single ops
operator, fresh-start spec) and called out in the docstring so
nobody reaches for the downgrade expecting a rollback to actually
roll anything back.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0042_resource_grants"
down_revision: Union[str, None] = "0041_message_edited_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_LOG = logging.getLogger("alembic.0042_resource_grants")


def _upload_root() -> Path:
    """Resolve the same upload root the runtime router uses."""
    return Path(os.environ.get("PROMPTLY_UPLOAD_ROOT", "/app/uploads")).resolve()


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1) New resource_grants table.
    # ------------------------------------------------------------------
    op.create_table(
        "resource_grants",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "resource_type",
            sa.String(length=16),
            nullable=False,
        ),
        sa.Column(
            "resource_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "grantee_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "granted_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "can_copy",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "resource_type IN ('file', 'folder')",
            name="resource_grants_resource_type_check",
        ),
        sa.CheckConstraint(
            "grantee_user_id <> granted_by_user_id",
            name="resource_grants_no_self_grant",
        ),
        sa.UniqueConstraint(
            "resource_type",
            "resource_id",
            "grantee_user_id",
            name="resource_grants_unique",
        ),
    )
    # Composite lookup index for the modal "list grants on resource X"
    # query — the unique constraint above gives us most of it but a
    # dedicated 2-col index keeps EXPLAIN tidy.
    op.create_index(
        "ix_resource_grants_resource",
        "resource_grants",
        ["resource_type", "resource_id"],
    )

    # ------------------------------------------------------------------
    # 2 + 3) Wipe legacy admin-pool rows + their blobs.
    # ------------------------------------------------------------------
    bind = op.get_bind()
    upload_root = _upload_root()

    legacy_files = bind.execute(
        sa.text(
            "SELECT id, storage_path FROM files WHERE user_id IS NULL"
        )
    ).fetchall()
    blob_failures = 0
    for _row_id, storage_path in legacy_files:
        if not storage_path:
            continue
        try:
            full = (upload_root / storage_path).resolve()
            # Defensive: never unlink anything outside the upload root,
            # even if a row's path happens to be malicious.
            full.relative_to(upload_root)
            full.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001 — best-effort cleanup
            blob_failures += 1
    if blob_failures:
        _LOG.warning(
            "0042: failed to unlink %d legacy shared-pool blob(s); "
            "rows will be deleted regardless",
            blob_failures,
        )

    # Drop the rows. Files first (cascade on folder_id is SET NULL,
    # so doing folders first would orphan files at root and leave
    # them visible). file_share_links / resource_grants on those
    # rows have no FK back into files (polymorphic), but a
    # standalone cleanup of the share-link rows is good hygiene.
    bind.execute(
        sa.text(
            "DELETE FROM file_share_links "
            "WHERE resource_type = 'file' "
            "AND resource_id IN (SELECT id FROM files WHERE user_id IS NULL)"
        )
    )
    bind.execute(sa.text("DELETE FROM files WHERE user_id IS NULL"))

    bind.execute(
        sa.text(
            "DELETE FROM file_share_links "
            "WHERE resource_type = 'folder' "
            "AND resource_id IN ("
            "SELECT id FROM file_folders WHERE user_id IS NULL"
            ")"
        )
    )
    # Folder delete cascades to subfolders via ondelete=CASCADE on
    # parent_id, so a single statement is enough.
    bind.execute(sa.text("DELETE FROM file_folders WHERE user_id IS NULL"))


def downgrade() -> None:
    # We can't restore the wiped legacy pool; downgrade is schema-only.
    op.drop_index("ix_resource_grants_resource", table_name="resource_grants")
    op.drop_table("resource_grants")
