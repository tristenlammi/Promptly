"""Share-link roles: signed-in people with the link can comment or edit (WP-6.6).

``file_share_links.role`` — ``view`` (what every link did), ``comment`` or
``edit``. A comment / edit link is always "signed-in users" (editing is never
anonymous): when someone opens it, they get a ``resource_grants`` row marked
with ``via_link_id``, so every existing access check — the editors, comments,
downloads, AI search, Shared with me — treats them like anyone the file was
shared with. Revoking or deleting the link takes those grants with it; an
expired link stops counting at once (the access checks look at the link).

``resource_grants.can_comment`` is the new middle role between view and edit
(the ``comment`` access level the office files already knew about); a person
can be given it directly too.

Revision ID: 0198_link_roles
Revises: 0197_pdf_versions
"""
from alembic import op
import sqlalchemy as sa

revision = "0198_link_roles"
down_revision = "0197_pdf_versions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "file_share_links",
        sa.Column("role", sa.String(16), nullable=False, server_default="view"),
    )
    op.create_check_constraint(
        "ck_file_share_links_role", "file_share_links", "role IN ('view','comment','edit')"
    )
    op.add_column(
        "resource_grants",
        sa.Column("can_comment", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "resource_grants",
        sa.Column(
            "via_link_id",
            sa.Uuid(),
            sa.ForeignKey("file_share_links.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_resource_grants_via_link",
        "resource_grants",
        ["via_link_id"],
        postgresql_where=sa.text("via_link_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.execute("DELETE FROM resource_grants WHERE via_link_id IS NOT NULL")
    op.drop_index("ix_resource_grants_via_link", table_name="resource_grants")
    op.drop_column("resource_grants", "via_link_id")
    op.drop_column("resource_grants", "can_comment")
    op.drop_constraint("ck_file_share_links_role", "file_share_links", type_="check")
    op.drop_column("file_share_links", "role")
