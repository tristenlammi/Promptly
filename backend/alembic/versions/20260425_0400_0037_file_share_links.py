"""Files — signed share links.

Creates ``file_share_links`` for Promptly Drive stage 1's "Get link"
feature. Parallel to ``conversation_shares`` / ``project_shares``,
which are user-to-user invite rows and don't carry tokens, expiries,
or passwords.

Schema notes:

- ``resource_type`` + ``resource_id`` form a polymorphic pointer at
  a file or folder. No FK because Postgres doesn't do polymorphic
  FKs; the router validates the target exists on create and the
  orphan links get filtered by a nightly sweep (or just start
  returning 404 until someone revokes them, which is fine).
- ``token`` is 43 chars of URL-safe base64 (``secrets.token_urlsafe(
  32)``). ``UNIQUE`` guarantees collision-free IDs; we keep a
  partial index on the live rows for fast lookup.
- ``access_mode`` = ``public`` means anyone with the URL can view
  (subject to password / expiry). ``invite`` means the visitor has
  to authenticate as a Promptly user; first visit records their id
  as a grant so subsequent visits skip re-authing. Grants are
  attached via ``file_share_grants`` which we add here alongside.
- ``password_hash`` uses the same passlib bcrypt context the auth
  router uses. NULL = no password.
- ``expires_at`` NULL = never expires.
- ``revoked_at`` is a soft-delete so we can tell users "this link
  was revoked on X" instead of a bare 404.

Revision ID: 0037_file_share_links
Revises: 0036_files_fts
Create Date: 2026-04-25 04:00:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0037_file_share_links"
down_revision: Union[str, Sequence[str], None] = "0036_files_fts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "file_share_links",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("resource_type", sa.String(length=16), nullable=False),
        sa.Column("resource_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("token", sa.String(length=64), nullable=False, unique=True),
        sa.Column("access_mode", sa.String(length=16), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "access_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("last_accessed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "resource_type IN ('file','folder')",
            name="file_share_links_resource_type_check",
        ),
        sa.CheckConstraint(
            "access_mode IN ('public','invite')",
            name="file_share_links_access_mode_check",
        ),
    )
    op.create_index(
        "ix_file_share_links_resource",
        "file_share_links",
        ["resource_type", "resource_id"],
    )
    # Partial unique over live tokens (not revoked) — belt + suspenders
    # for the UNIQUE token column; also makes "lookup by token AND
    # not revoked" hit an index.
    op.create_index(
        "ix_file_share_links_token_live",
        "file_share_links",
        ["token"],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )

    # ``invite`` mode grants. One row per (link, user) recording that
    # the user has claimed the invite; subsequent visits skip the
    # auth nudge.
    op.create_table(
        "file_share_grants",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "link_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("file_share_links.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("link_id", "user_id", name="uq_file_share_grants_link_user"),
    )


def downgrade() -> None:
    op.drop_table("file_share_grants")
    op.drop_index(
        "ix_file_share_links_token_live", table_name="file_share_links"
    )
    op.drop_index("ix_file_share_links_resource", table_name="file_share_links")
    op.drop_table("file_share_links")
