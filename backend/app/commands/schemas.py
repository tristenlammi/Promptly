"""Pydantic schemas for the command library."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.commands.constants import (
    ACTION_TYPES,
    MAX_BODY_CHARS,
    MAX_NAME_CHARS,
    MAX_PHRASE_CHARS,
    MAX_PHRASES_PER_COMMAND,
)


def _clean_phrases(v: list[str] | None) -> list[str]:
    """Trim, drop blanks, de-duplicate — preserving the author's order.

    Two identical phrases on one command are harmless but make the
    library look broken; two on *different* commands is an ambiguity the
    matcher refuses, so the editor should not manufacture them here.
    """
    seen: set[str] = set()
    out: list[str] = []
    for raw in v or []:
        phrase = (raw or "").strip()
        if not phrase:
            continue
        key = phrase.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(phrase[:MAX_PHRASE_CHARS])
    return out[:MAX_PHRASES_PER_COMMAND]


class CommandBase(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME_CHARS)
    phrases: list[str] = Field(default_factory=list)
    action_type: str = "prompt"
    action_ref: str | None = Field(default=None, max_length=255)
    action_args: dict[str, Any] = Field(default_factory=dict)
    body: str | None = Field(default=None, max_length=MAX_BODY_CHARS)
    response_template: str | None = Field(default=None, max_length=280)
    enabled: bool = True
    confirm_before_run: bool = False
    # Visible to everyone on the instance, read-only. Sharing a command
    # shares the phrasing, not the access behind it.
    shared: bool = False

    @field_validator("phrases")
    @classmethod
    def _phrases(cls, v: list[str] | None) -> list[str]:
        return _clean_phrases(v)

    @field_validator("action_type")
    @classmethod
    def _action_type(cls, v: str) -> str:
        if v not in ACTION_TYPES:
            raise ValueError(f"Unknown action type: {v}")
        return v


class CommandCreate(CommandBase):
    pass


class CommandUpdate(BaseModel):
    """Partial edit. Every field optional so the editor can PATCH one."""

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME_CHARS)
    phrases: list[str] | None = None
    action_type: str | None = None
    action_ref: str | None = Field(default=None, max_length=255)
    action_args: dict[str, Any] | None = None
    body: str | None = Field(default=None, max_length=MAX_BODY_CHARS)
    response_template: str | None = Field(default=None, max_length=280)
    enabled: bool | None = None
    confirm_before_run: bool | None = None
    shared: bool | None = None

    @field_validator("phrases")
    @classmethod
    def _phrases(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else _clean_phrases(v)

    @field_validator("action_type")
    @classmethod
    def _action_type(cls, v: str | None) -> str | None:
        if v is not None and v not in ACTION_TYPES:
            raise ValueError(f"Unknown action type: {v}")
        return v


class CommandResponse(CommandBase):
    model_config = ConfigDict(from_attributes=True)

    # False when this row belongs to someone else and reached you by
    # being shared. The client renders those read-only; the server
    # enforces it regardless.
    owned: bool = True
    # Who shared it, for the "from Ana" line. Empty for your own.
    owner_name: str | None = None

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class CommandMatchRequest(BaseModel):
    """What the user said or typed, before we know if it means anything."""

    utterance: str = Field(min_length=1, max_length=500)


class CommandMatchResponse(BaseModel):
    """The match, deliberately without running anything.

    Separating match from run is what lets the client confirm a
    side-effecting command *before* it happens, and lets the `/` menu
    preview what a phrase would do.
    """

    matched: bool
    command: CommandResponse | None = None
    slots: dict[str, str] = Field(default_factory=dict)
    needs_confirmation: bool = False
    # Populated only on a miss: something close enough to be worth
    # ASKING about. Never acted on automatically — the point is to turn
    # a silent miss into a question.
    did_you_mean: CommandResponse | None = None


class CommandRunRequest(BaseModel):
    slots: dict[str, str] = Field(default_factory=dict)
    # Set by the client once the user has agreed to a side-effecting
    # action. The server refuses without it rather than assuming.
    confirmed: bool = False
    # When the command was run from inside a chat, the run is recorded
    # there as a message so the transcript shows what happened. Optional
    # because commands also run from the library, where there's no
    # conversation to write to.
    conversation_id: uuid.UUID | None = None
    # Where the run came from, for the history tab. "works when typed,
    # never when spoken" is the commonest way this feature fails, and
    # that's invisible unless the entry point is recorded.
    source: str = "chat"
    # What was actually said or typed. The other half of a mis-match
    # report — without it, history says a command ran but not why.
    utterance: str | None = None


class CommandRunResponse(BaseModel):
    kind: str
    # prompt → the filled-in text; automation → run id; mcp_tool → output.
    text: str | None = None
    run_id: str | None = None
    status: str | None = None
    output: str | None = None
    # What to say out loud, when a template made that possible without a
    # model. Null means "let the model phrase it".
    spoken: str | None = None
    # The transcript message this run was recorded as, when it ran from
    # a chat. The client appends it rather than refetching the thread.
    message: dict | None = None


class CommandRunLogEntry(BaseModel):
    """One past run, as history shows it."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    # Null once the command itself is deleted; the name is kept either
    # way so old rows stay readable.
    command_id: uuid.UUID | None = None
    command_name: str
    source: str
    ok: bool
    utterance: str | None = None
    slots: dict[str, Any] = Field(default_factory=dict)
    detail: str | None = None
    created_at: datetime
