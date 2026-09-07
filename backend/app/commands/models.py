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

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    func,
)
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

    # Share with everyone on this instance. Read-only for them: they can
    # see it, say it and run it, but only the owner can change it.
    #
    # Safe because of the capability rule — the *target* is re-checked
    # against whoever is running, so a shared command is a shared
    # phrasing, not shared access. Someone else's "run the backup flow"
    # fails for them exactly as it would have without the shortcut.
    #
    # Instance-wide rather than a per-user share list on purpose: this is
    # a household or a small team, where "everyone can say goodnight" is
    # the actual requirement, and a share table would be a permissions
    # system nobody asked for.
    shared: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    __table_args__ = (
        Index("ix_commands_user_action", "user_id", "action_type"),
        Index("ix_commands_shared", "shared"),
    )

    @property
    def is_side_effecting(self) -> bool:
        from app.commands.constants import SIDE_EFFECTING

        return self.action_type in SIDE_EFFECTING

    def __repr__(self) -> str:
        return f"<Command id={self.id} name={self.name!r} {self.action_type}>"


class CommandRun(UUIDPKMixin, Base):
    """One time a command actually ran, kept so it can be looked back at.

    History exists because the matcher deliberately refuses to guess. A
    command that didn't fire and a command that fired and failed look
    identical from across the room, and a spoken "that didn't work" is
    gone the moment it's said. This is the record you check afterwards.

    ``command_id`` is nullable on purpose: deleting a command shouldn't
    rewrite the past, so the row survives with its name copied in.
    """

    __tablename__ = "command_runs"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    command_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("commands.id", ondelete="SET NULL"), nullable=True
    )

    # Copied rather than joined, so history reads correctly after a
    # command is renamed or deleted.
    command_name: Mapped[str] = mapped_column(String(120), nullable=False)

    # Where it came from: "voice", "chat" or "wyoming". Worth keeping
    # separate — "works when typed, never when spoken" is the single most
    # common way this feature goes wrong, and it's invisible without this.
    source: Mapped[str] = mapped_column(
        String(16), nullable=False, default="chat", server_default="chat"
    )

    ok: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # What was said or typed, when we know it, plus any slot captures.
    # The utterance is the other half of a mis-matching bug report.
    utterance: Mapped[str | None] = mapped_column(String(500), nullable=True)
    slots: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )

    # The spoken/shown summary, or the error. Capped at the same width as
    # a response template.
    detail: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[Any] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_command_runs_user_created", "user_id", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<CommandRun {self.command_name!r} ok={self.ok}>"
