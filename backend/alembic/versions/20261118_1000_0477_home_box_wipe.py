"""Promptly Home: a box that has left a home and still has to forget it.

``home_boxes.wipe_pending``: set when a box is taken out of a home (moved,
given away, or its home deleted). The server asks the box to remove that
home's brands, sign-ins, linked music and rooms; a box that's offline does it
when it next connects, and nothing it says is shown to anyone until it has
(``app/home/manage.py``). Co-owners need no column: ``home_members.role``
already holds a short word ("owner", "coowner", "member").

Revision ID: 0477_home_box_wipe
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0477_home_box_wipe"
down_revision = "0490_room_att_removed"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("home_boxes", sa.Column("wipe_pending", sa.Boolean(), nullable=False, server_default="false"))


def downgrade() -> None:
    op.drop_column("home_boxes", "wipe_pending")
