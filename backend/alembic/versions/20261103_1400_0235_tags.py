"""Shared tags across apps: one per-person set + generic assignments.

``tags`` holds each person's tags (name unique per person, ignoring case);
``tag_assignments`` puts a tag on one thing by kind + id. Tags Item Store
apps already keep in their JSON files (Tasks, Contacts, Journal, Recipes,
Budget) stay there and are mirrored in by the app on the next save / the
first visit to Tags — no data is copied or rewritten here.

Revision ID: 0235_tags
Revises: 0234_links
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0235_tags"
down_revision = "0234_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tags",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("color", sa.String(9), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_tags_user_id", "tags", ["user_id"])
    op.execute("CREATE UNIQUE INDEX uq_tags_user_name ON tags (user_id, lower(name))")

    op.create_table(
        "tag_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tag_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tags.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("entity_kind", sa.String(32), nullable=False),
        sa.Column("entity_id", sa.String(120), nullable=False),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("files.id", ondelete="CASCADE"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("tag_id", "entity_kind", "entity_id", name="uq_tag_assignments_thing"),
    )
    op.create_index("ix_tag_assignments_tag_id", "tag_assignments", ["tag_id"])
    op.create_index("ix_tag_assignments_file_id", "tag_assignments", ["file_id"])
    op.create_index("ix_tag_assignments_entity", "tag_assignments", ["user_id", "entity_kind", "entity_id"])


def downgrade() -> None:
    op.drop_index("ix_tag_assignments_entity", table_name="tag_assignments")
    op.drop_index("ix_tag_assignments_file_id", table_name="tag_assignments")
    op.drop_index("ix_tag_assignments_tag_id", table_name="tag_assignments")
    op.drop_table("tag_assignments")
    op.execute("DROP INDEX IF EXISTS uq_tags_user_name")
    op.drop_index("ix_tags_user_id", table_name="tags")
    op.drop_table("tags")
