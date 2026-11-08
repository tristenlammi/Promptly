"""Porch core: groups (with the built-in Everyone), posts, the groups each
post went to, its photos and videos, and people's Porch profiles. Plus the
admin's switches in ``app_settings``.

Revision ID: 0270_porch_core
Revises: 0321_user_blocks
"""
import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0270_porch_core"
down_revision = "0321_user_blocks"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()


def upgrade() -> None:
    op.create_table(
        "porch_groups",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("kind", sa.String(10), nullable=False, server_default="custom"),
        sa.Column("visibility", sa.String(8), nullable=False, server_default="private"),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("emoji", sa.String(16), nullable=False, server_default=""),
        sa.Column("cover_file_id", UUID, sa.ForeignKey("files.id", ondelete="SET NULL"), nullable=True),
        sa.Column("about", sa.String(500), nullable=False, server_default=""),
        sa.Column("members_can_invite", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('everyone', 'custom')", name="ck_porch_groups_kind"),
        sa.CheckConstraint("visibility IN ('public', 'private')", name="ck_porch_groups_visibility"),
        sa.CheckConstraint("kind <> 'everyone' OR visibility = 'public'", name="ck_porch_groups_everyone_public"),
    )
    # Exactly one Everyone.
    op.create_index("uq_porch_groups_everyone", "porch_groups", ["kind"], unique=True, postgresql_where=sa.text("kind = 'everyone'"))

    op.create_table(
        "porch_group_members",
        sa.Column("group_id", UUID, sa.ForeignKey("porch_groups.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(8), nullable=False, server_default="member"),
        sa.Column("status", sa.String(8), nullable=False, server_default="member"),
        sa.Column("invited_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("in_feed", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("notify", sa.String(8), nullable=False, server_default="none"),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("role IN ('owner', 'admin', 'member')", name="ck_porch_members_role"),
        sa.CheckConstraint("status IN ('invited', 'member', 'removed')", name="ck_porch_members_status"),
        sa.CheckConstraint("notify IN ('all', 'none')", name="ck_porch_members_notify"),
    )
    op.create_index("ix_porch_group_members_user", "porch_group_members", ["user_id", "status"])

    op.create_table(
        "porch_posts",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("author_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("body", sa.String(5000), nullable=False, server_default=""),
        sa.Column("place", JSONB, nullable=True),
        sa.Column("life_event", JSONB, nullable=True),
        sa.Column("link", JSONB, nullable=True),
        sa.Column("mentions", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("from_memory_id", UUID, nullable=True),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        # Phase 4 (following other servers): NULL = this server.
        sa.Column("origin", sa.String(255), nullable=True),
        sa.Column("uri", sa.String(512), nullable=True),
        sa.CheckConstraint("kind IN ('photo', 'video', 'text', 'poll', 'life_event')", name="ck_porch_posts_kind"),
    )
    op.execute(
        """
        ALTER TABLE porch_posts
        ADD COLUMN body_tsv tsvector
        GENERATED ALWAYS AS (
            to_tsvector('simple', coalesce(body, '') || ' ' || coalesce(place->>'name', '')) ||
            to_tsvector('english', coalesce(body, '') || ' ' || coalesce(place->>'name', ''))
        ) STORED
        """
    )
    op.execute("CREATE INDEX ix_porch_posts_body_tsv ON porch_posts USING GIN (body_tsv)")
    op.execute("CREATE INDEX ix_porch_posts_created ON porch_posts (created_at DESC, id DESC)")
    op.create_index("ix_porch_posts_author_created", "porch_posts", ["author_id", "created_at"])

    op.create_table(
        "porch_post_groups",
        sa.Column("post_id", UUID, sa.ForeignKey("porch_posts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("group_id", UUID, sa.ForeignKey("porch_groups.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_porch_post_groups_group", "porch_post_groups", ["group_id", "post_id"])

    op.create_table(
        "porch_post_media",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("post_id", UUID, sa.ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        # The poster's own library file. Purged → it leaves the post.
        sa.Column("file_id", UUID, sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("alt_text", sa.String(1000), nullable=False, server_default=""),
        sa.Column("edit", JSONB, nullable=True),
        sa.UniqueConstraint("post_id", "position", name="uq_porch_post_media_position", deferrable=True, initially="DEFERRED"),
    )
    op.create_index("ix_porch_post_media_file", "porch_post_media", ["file_id"])

    op.create_table(
        "porch_profiles",
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("bio", sa.String(300), nullable=False, server_default=""),
        sa.Column("show_birthday", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("birthday", sa.Date(), nullable=True),
        sa.Column("save_stories_to_photos", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("face_suggestions", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("feed_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("activity_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("welcomed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_groups", JSONB, nullable=True),
        sa.Column("push", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.add_column("app_settings", sa.Column("porch_enabled", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("app_settings", sa.Column("porch_user_group_ids", JSONB, nullable=True))
    op.add_column("app_settings", sa.Column("porch_video_max_seconds", sa.Integer(), nullable=False, server_default="300"))
    op.add_column("app_settings", sa.Column("porch_video_max_mb", sa.Integer(), nullable=False, server_default="1024"))

    # The built-in Everyone group, with the fixed id app/porch/core.py uses
    # (which also makes it on first need).
    op.execute(
        sa.text(
            "INSERT INTO porch_groups (id, kind, visibility, name, emoji) "
            "VALUES (:id, 'everyone', 'public', 'Everyone', :emoji) ON CONFLICT DO NOTHING"
        ).bindparams(id=uuid.uuid5(uuid.NAMESPACE_URL, "promptly:porch:everyone"), emoji="\U0001F30F")
    )


def downgrade() -> None:
    for col in ("porch_video_max_mb", "porch_video_max_seconds", "porch_user_group_ids", "porch_enabled"):
        op.drop_column("app_settings", col)
    op.drop_table("porch_profiles")
    op.drop_index("ix_porch_post_media_file", table_name="porch_post_media")
    op.drop_table("porch_post_media")
    op.drop_index("ix_porch_post_groups_group", table_name="porch_post_groups")
    op.drop_table("porch_post_groups")
    op.execute("DROP INDEX IF EXISTS ix_porch_posts_created")
    op.execute("DROP INDEX IF EXISTS ix_porch_posts_body_tsv")
    op.drop_index("ix_porch_posts_author_created", table_name="porch_posts")
    op.drop_table("porch_posts")
    op.drop_index("ix_porch_group_members_user", table_name="porch_group_members")
    op.drop_table("porch_group_members")
    op.drop_index("uq_porch_groups_everyone", table_name="porch_groups")
    op.drop_table("porch_groups")
