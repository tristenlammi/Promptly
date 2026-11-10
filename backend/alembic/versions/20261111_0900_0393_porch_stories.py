"""Porch stories (WP-P2.1): photo, video and text stories that disappear
after 24 hours, posted to groups the same way as posts.

* ``porch_stories`` — one story. ``file_id`` is the poster's own library
  photo or video (CASCADE: a purged photo ends the story); ``edit`` its 9:16
  crop for this story only (``photos/edits.py`` ops); a text story has
  ``text`` on a ``background``. ``overlays`` are the stickers (text,
  @mention, place), ``mentions`` the people @mentioned (only people who'd
  see it). ``expires_at`` is created + 24 h: expiry is read-time (who can
  see it), so a story outlives it as a row for your archive and highlights.
* ``porch_story_groups`` — the groups it went to, fixed when posted.
* ``porch_story_views`` — who has seen it (only the poster sees the list).

The plan numbered this 0390; Porch's wave-2 range is 0393–0399.

Revision ID: 0393_porch_stories
Revises: 0402_scrub_error_routes
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0393_porch_stories"
down_revision = "0402_scrub_error_routes"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()


def upgrade() -> None:
    op.create_table(
        "porch_stories",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("author_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("file_id", UUID, sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=True),
        sa.Column("edit", JSONB, nullable=True),
        sa.Column("text", sa.String(500), nullable=False, server_default=""),
        sa.Column("background", sa.String(16), nullable=True),
        sa.Column("overlays", JSONB, nullable=False, server_default="[]"),
        sa.Column("mentions", JSONB, nullable=False, server_default="[]"),
        sa.Column("alt_text", sa.String(1000), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('photo', 'video', 'text')", name="ck_porch_stories_kind"),
        sa.CheckConstraint("kind = 'text' OR file_id IS NOT NULL", name="ck_porch_stories_file"),
    )
    op.create_index("ix_porch_stories_author", "porch_stories", ["author_id", sa.text("created_at DESC")])
    op.create_index("ix_porch_stories_expires", "porch_stories", ["expires_at"])
    op.create_index("ix_porch_stories_file", "porch_stories", ["file_id"])

    op.create_table(
        "porch_story_groups",
        sa.Column("story_id", UUID, sa.ForeignKey("porch_stories.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("group_id", UUID, sa.ForeignKey("porch_groups.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_index("ix_porch_story_groups_group", "porch_story_groups", ["group_id", "story_id"])

    op.create_table(
        "porch_story_views",
        sa.Column("story_id", UUID, sa.ForeignKey("porch_stories.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("viewer_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_porch_story_views_viewer", "porch_story_views", ["viewer_id"])

    op.drop_constraint("ck_porch_removals_target", "porch_removals", type_="check")
    op.create_check_constraint("ck_porch_removals_target", "porch_removals", "target_type IN ('post', 'comment', 'story')")


def downgrade() -> None:
    op.execute("DELETE FROM porch_removals WHERE target_type = 'story'")
    op.drop_constraint("ck_porch_removals_target", "porch_removals", type_="check")
    op.create_check_constraint("ck_porch_removals_target", "porch_removals", "target_type IN ('post', 'comment')")
    op.execute("DELETE FROM porch_reports WHERE target_type = 'story'")
    op.drop_table("porch_story_views")
    op.drop_table("porch_story_groups")
    op.drop_table("porch_stories")
