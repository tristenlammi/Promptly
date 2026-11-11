"""Notes phase 2 (N2.2, N2.3): shopping lists by aisle, and items sent from a
Meal Plan.

* ``note_items.aisle`` — a key from Meal Plan's ``foods.AISLES`` ("dairy"),
  set when an item is added to a list kept by aisle, by Sort by aisle, or by
  dragging it across an aisle line; NULL otherwise.
* ``note_items.ref`` — Meal Plan's id for an item it sent (``mp:`` + a hash of
  the plan, the week and the grocery key). Sending again finds the item by it;
  items people typed have none and are never touched. Unique per note.
* ``note_versions.reason`` learns ``send`` (the version kept before a Meal
  Plan send, so Undo restores it).

Revision ID: 0360_note_items_aisle_ref
Revises: 0263_notes_vectors
"""
import sqlalchemy as sa
from alembic import op

revision = "0360_note_items_aisle_ref"
down_revision = "0263_notes_vectors"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("note_items", sa.Column("aisle", sa.String(16), nullable=True))
    op.add_column("note_items", sa.Column("ref", sa.String(64), nullable=True))
    op.create_index(
        "ux_note_items_note_ref", "note_items", ["note_id", "ref"], unique=True, postgresql_where=sa.text("ref IS NOT NULL")
    )
    op.drop_constraint("ck_note_versions_reason", "note_versions", type_="check")
    op.create_check_constraint("ck_note_versions_reason", "note_versions", "reason IN ('edit', 'restore', 'ai', 'send')")


def downgrade() -> None:
    op.execute("DELETE FROM note_versions WHERE reason = 'send'")
    op.drop_constraint("ck_note_versions_reason", "note_versions", type_="check")
    op.create_check_constraint("ck_note_versions_reason", "note_versions", "reason IN ('edit', 'restore', 'ai')")
    op.drop_index("ux_note_items_note_ref", table_name="note_items")
    op.drop_column("note_items", "ref")
    op.drop_column("note_items", "aisle")
