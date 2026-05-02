"""Promptly Drive — add ``can_edit`` to resource_grants.

Stage 5.1 extends the share grant model with a third permission
mode: **Editor**. Grantees flagged ``can_edit=true`` get write
access to the resource, which in v1 is scoped to Drive Documents
only — for documents this means a real-time collaborative editing
session via Hocuspocus (the collab JWT is minted with
``perm=write``) and an authorised path through the manual-save +
asset-upload endpoints.

The new column is a sibling boolean next to ``can_copy``. Storing
it as two independent booleans (rather than a single
``permission`` enum) matches the API the Pydantic schemas already
expose — ``can_copy`` and ``can_edit`` are independently meaningful
even though the share modal's UI presents them as mutually
exclusive radio options ("Viewer + copy" vs "Editor"). This way a
future "Editor + copy" tier doesn't require another migration.

Backfill: existing rows default to ``can_edit=false`` — every
already-issued grant stays read-only, matching the prior behaviour.

Downgrade is straightforward; no on-disk side effects.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0043_grant_can_edit"
down_revision: Union[str, None] = "0042_resource_grants"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "resource_grants",
        sa.Column(
            "can_edit",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("resource_grants", "can_edit")
