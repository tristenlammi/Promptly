"""The command library — one table behind three tabs.

A saved prompt and a voice command are the same object with different
action types. Keeping them in one table is the whole point: one matcher,
one ``/`` menu, one confirmation path, and a phrase you defined by
typing works when you say it out loud without being re-entered anywhere.

``action_type`` is what the UI tabs filter on:

* ``prompt``     → Prompts tab. Inserts text. No side effects.
* ``automation`` → Commands tab. Runs an existing flow.
* ``mcp_tool``   → Commands tab. Calls a connector tool.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import Boolean, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import TimestampMixin, UUIDPKMixin


class Command(UUIDPKMixin, TimestampMixin, Base):
    """One thing the user can say or type, and what it does."""

    __tablename__ = "commands"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Human label — what the ``/`` menu and the library list show. For
    # rows carried over from saved prompts this is the old ``title``.
    name: Mapped[str] = mapped_column(String(120), nullable=False)

    # Every way of saying it. Matched after normalisation, so casing and
    # punctuation don't need duplicating here. May contain ``{slot}``
    # placeholders. Empty for prompt rows that are only ever picked from
    # the menu rather than spoken.
    phrases: Mapped[list[str]] = mapped_column(
        ARRAY(String(120)), nullable=False, default=list, server_default="{}"
    )

    action_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default="prompt", server_default="prompt"
    )

    # What the action points at, by type:
    #   prompt     → unused (see ``body``)
    #   automation → the task id, as text
    #   mcp_tool   → "<connector_id>:<tool name>"
    # Stringly-typed on purpose: a real FK per type would mean three
    # nullable columns and a CHECK constraint to keep them exclusive,
    # and the target is re-validated on execute anyway.
    action_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Fixed arguments for the action, merged with any slot captures at
    # match time (slots win).
    action_args: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )

    # The template text for ``prompt`` rows — the old saved-prompt body.
    body: Mapped[str | None] = mapped_column(Text, nullable=True)

    # What to say back when this runs by voice. Null means "let the model
    # phrase it"; a template keeps the fast path model-free end to end.
    response_template: Mapped[str | None] = mapped_column(
        String(280), nullable=True
    )

    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    # "Ask before running this one." Off by default, and it governs BOTH
    # entry points — typed and spoken — so a command can't be the kind
    # that asks in one place and not the other.
    #
    # Off is the right default because the risk isn't uniform: picking
    # "Kitchen lights" from a menu, or saying a phrase you wrote
    # yourself, doesn't warrant a dialog every time. Turn it on for the
    # garage door.
    confirm_before_run: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    __table_args__ = (
        Index("ix_commands_user_action", "user_id", "action_type"),
    )

    @property
    def is_side_effecting(self) -> bool:
        from app.commands.constants import SIDE_EFFECTING

        return self.action_type in SIDE_EFFECTING

    def __repr__(self) -> str:
        return f"<Command id={self.id} name={self.name!r} {self.action_type}>"
