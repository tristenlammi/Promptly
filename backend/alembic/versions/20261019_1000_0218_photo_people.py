"""People and pets (PH-3): who's in the photos.

``photo_people`` holds both — a person (from faces) or a pet (from animals) —
named or not yet (a cluster waiting for "Who is this?"). Faces and animals
point at their person/pet; ``assigned_by`` says whether a person said so
(``user`` — never undone by the machine) or the machine (``auto``).
"Not this person" is remembered so it's never suggested again.

Revision ID: 0218_photo_people
Revises: 0217_photo_captions
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0218_photo_people"
down_revision = "0217_photo_captions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "photo_people",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),  # person | pet
        sa.Column("species", sa.String(24), nullable=True),  # pets
        sa.Column("name", sa.String(120), nullable=True),
        # The face or animal shown for it (chosen, or the best one).
        sa.Column("cover_id", postgresql.UUID(as_uuid=True), nullable=True),
        # "This is me" / this is that Promptly user (people).
        sa.Column("linked_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("hidden", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("kind IN ('person', 'pet')", name="ck_photo_people_kind"),
    )
    op.create_index("ix_photo_people_user", "photo_people", ["user_id", "kind"])
    for table, col in (("photo_faces", "person_id"), ("photo_animals", "pet_id")):
        op.create_foreign_key(f"fk_{table}_{col}", table, "photo_people", [col], ["id"], ondelete="SET NULL")
        op.create_index(f"ix_{table}_{col}", table, [col])
    # When a face was last clustered (NULL = not yet), and whether it was
    # left out for now (too few like it — a stranger in the background).
    op.add_column("photo_faces", sa.Column("clustered_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("photo_faces", sa.Column("deferred", sa.Boolean, nullable=False, server_default=sa.text("false")))
    op.add_column("photo_animals", sa.Column("clustered_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "photo_rejections",
        sa.Column("person_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("photo_people.id", ondelete="CASCADE"), primary_key=True),
        # A face or an animal: "this isn't them".
        sa.Column("observation_id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("photo_rejections")
    op.drop_column("photo_animals", "clustered_at")
    op.drop_column("photo_faces", "deferred")
    op.drop_column("photo_faces", "clustered_at")
    for table, col in (("photo_faces", "person_id"), ("photo_animals", "pet_id")):
        op.drop_index(f"ix_{table}_{col}", table_name=table)
        op.drop_constraint(f"fk_{table}_{col}", table, type_="foreignkey")
    op.drop_index("ix_photo_people_user", table_name="photo_people")
    op.drop_table("photo_people")
