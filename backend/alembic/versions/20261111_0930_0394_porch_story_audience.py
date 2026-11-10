"""Porch stories remember their own audience (WP-P2.2).

``porch_profiles.last_story_groups``: the story maker's "who sees it"
starting choice (``"all"`` or group ids), kept apart from posts'
``last_groups`` so a story to everyone doesn't change where your next post
goes (and the other way round).

Revision ID: 0394_porch_story_audience
Revises: 0393_porch_stories
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0394_porch_story_audience"
down_revision = "0393_porch_stories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("porch_profiles", sa.Column("last_story_groups", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("porch_profiles", "last_story_groups")
