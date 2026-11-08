"""Porch talking: comments (one level of replies), reactions, polls, photo
tags (shown after a yes), saved posts, "notify me when they post", and
reports.

Revision ID: 0271_porch_talk
Revises: 0270_porch_core
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0271_porch_talk"
down_revision = "0270_porch_core"
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB()


def _now() -> sa.Column:
    return sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)


def upgrade() -> None:
    op.add_column("porch_posts", sa.Column("poll_closes_at", sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "porch_comments",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("post_id", UUID, sa.ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("parent_id", UUID, sa.ForeignKey("porch_comments.id", ondelete="CASCADE"), nullable=True),
        sa.Column("body", sa.String(2000), nullable=False),
        sa.Column("mentions", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        _now(),
    )
    op.create_index("ix_porch_comments_post", "porch_comments", ["post_id", "created_at"])
    op.create_index("ix_porch_comments_author", "porch_comments", ["author_id", "created_at"])
    op.create_index("ix_porch_comments_parent", "porch_comments", ["parent_id"])
    op.execute("CREATE INDEX ix_porch_comments_mentions ON porch_comments USING GIN (mentions)")
    op.execute("CREATE INDEX ix_porch_posts_mentions ON porch_posts USING GIN (mentions)")

    op.create_table(
        "porch_reactions",
        sa.Column("target_type", sa.String(8), primary_key=True),
        sa.Column("target_id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("post_id", UUID, sa.ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("emoji", sa.String(16), nullable=False),
        _now(),
        sa.CheckConstraint("target_type IN ('post', 'comment')", name="ck_porch_reactions_target"),
    )
    op.create_index("ix_porch_reactions_post", "porch_reactions", ["post_id"])

    op.create_table(
        "porch_poll_options",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("post_id", UUID, sa.ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("label", sa.String(80), nullable=False),
        sa.UniqueConstraint("post_id", "position", name="uq_porch_poll_options_position"),
    )
    op.create_table(
        "porch_poll_votes",
        sa.Column("post_id", UUID, sa.ForeignKey("porch_posts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("option_id", UUID, sa.ForeignKey("porch_poll_options.id", ondelete="CASCADE"), nullable=False),
        _now(),
    )

    op.create_table(
        "porch_tags",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("post_id", UUID, sa.ForeignKey("porch_posts.id", ondelete="CASCADE"), nullable=False),
        # The photo it's on (not its position: photos can be put in another order).
        sa.Column("media_id", UUID, sa.ForeignKey("porch_post_media.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tagged_user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tagged_by", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("box", JSONB, nullable=True),
        sa.Column("status", sa.String(8), nullable=False, server_default="pending"),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        _now(),
        sa.UniqueConstraint("media_id", "tagged_user_id", name="uq_porch_tags_media_user"),
        sa.CheckConstraint("status IN ('pending', 'approved', 'declined')", name="ck_porch_tags_status"),
    )
    op.create_index("ix_porch_tags_post", "porch_tags", ["post_id"])
    op.create_index("ix_porch_tags_tagged", "porch_tags", ["tagged_user_id", "status"])

    op.create_table(
        "porch_saves",
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("post_id", UUID, sa.ForeignKey("porch_posts.id", ondelete="CASCADE"), primary_key=True),
        _now(),
    )
    op.create_table(
        "porch_alerts",
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("author_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        _now(),
    )
    op.create_index("ix_porch_alerts_author", "porch_alerts", ["author_id"])
    op.create_table(
        "porch_reports",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("reporter_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("target_type", sa.String(8), nullable=False),
        sa.Column("target_id", UUID, nullable=False),
        sa.Column("reason", sa.String(500), nullable=False, server_default=""),
        sa.Column("status", sa.String(8), nullable=False, server_default="open"),
        sa.Column("handled_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
        _now(),
        sa.CheckConstraint("target_type IN ('post', 'comment')", name="ck_porch_reports_target"),
        sa.CheckConstraint("status IN ('open', 'removed', 'kept')", name="ck_porch_reports_status"),
    )
    op.create_index("ix_porch_reports_status", "porch_reports", ["status", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_porch_reports_status", table_name="porch_reports")
    op.drop_table("porch_reports")
    op.drop_index("ix_porch_alerts_author", table_name="porch_alerts")
    op.drop_table("porch_alerts")
    op.drop_table("porch_saves")
    op.drop_index("ix_porch_tags_tagged", table_name="porch_tags")
    op.drop_index("ix_porch_tags_post", table_name="porch_tags")
    op.drop_table("porch_tags")
    op.drop_table("porch_poll_votes")
    op.drop_table("porch_poll_options")
    op.drop_index("ix_porch_reactions_post", table_name="porch_reactions")
    op.drop_table("porch_reactions")
    op.execute("DROP INDEX IF EXISTS ix_porch_posts_mentions")
    op.execute("DROP INDEX IF EXISTS ix_porch_comments_mentions")
    op.drop_index("ix_porch_comments_parent", table_name="porch_comments")
    op.drop_index("ix_porch_comments_author", table_name="porch_comments")
    op.drop_index("ix_porch_comments_post", table_name="porch_comments")
    op.drop_table("porch_comments")
    op.drop_column("porch_posts", "poll_closes_at")
