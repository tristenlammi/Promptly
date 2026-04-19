"""Tool ABC + the value objects that flow through the dispatch loop.

Keeping this module dependency-light (no FastAPI, no SQLAlchemy except
for the typed ``AsyncSession`` field on the context) means individual
tool modules can be unit-tested by constructing a ``ToolContext`` with a
fake session and calling ``await tool.run(ctx, args)`` directly — no
need to spin up the chat router.
"""
from __future__ import annotations

import abc
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User


class ToolError(Exception):
    """Raised by a tool implementation to signal a controlled failure.

    The chat router catches this, turns it into a ``tool_finished``
    SSE event with ``ok: false`` + the exception message, and feeds a
    short error string back to the model so it can apologise / try
    something else. Exceptions that aren't :class:`ToolError` are
    treated as internal bugs: the message text is *never* shown to the
    user, only the exception class name appears in audit + logs.
    """


@dataclass
class ToolContext:
    """Per-invocation context passed to :meth:`Tool.run`.

    Tools should use ``db`` for their reads/writes (the same session the
    chat router is using, so any rows they create are visible to the
    follow-up model call) and ``conversation_id`` / ``message_id`` to
    link generated artefacts back to the turn that produced them.
    """

    db: AsyncSession
    user: User
    conversation_id: uuid.UUID
    # The triggering user message — i.e. the most recent user turn,
    # not the assistant message about to be produced (which doesn't
    # exist yet at dispatch time).
    user_message_id: uuid.UUID


@dataclass
class ToolResult:
    """Whatever a tool wants to hand back.

    ``content`` is the *string* fed back to the model in the follow-up
    call's ``tool`` message — it should be a concise human-readable
    description of what happened (the model uses this to decide what
    to say in its reply). ``attachment_ids`` is the list of files the
    tool produced; these get stamped onto the assistant message's
    ``attachments`` JSONB so the chip renders next to the reply.
    ``sources`` (Phase D1) is the list of web citations a search /
    fetch tool collected; the chat router drains them onto the
    assistant message's ``sources`` JSONB so the inline citation chips
    + the existing ``SourcesFooter`` keep working unchanged. Each entry
    is a dict with at least ``title``, ``url``, and ``snippet`` keys
    (mirrors the long-standing ``SearchResult`` shape).
    ``meta`` is opaque structured data surfaced to the UI in the
    ``tool_finished`` SSE event — useful for tool-specific affordances
    (e.g. an image-gen tool can attach the prompt + model used).
    """

    content: str
    attachment_ids: list[uuid.UUID] = field(default_factory=list)
    sources: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)


class Tool(abc.ABC):
    """Implement this once per server-side function the AI can call.

    Concrete tools must set:

    * ``name`` — the OpenAI function name. Stable across deploys; this
      is what the model includes in its ``tool_calls``. Snake_case.
    * ``description`` — sentence the model reads when deciding whether
      to call. Be specific about *when* to use the tool, not just what
      it does.
    * ``parameters`` — a JSON Schema (object) describing the arguments.
      Mirrors the OpenAI ``function.parameters`` field byte-for-byte.

    And implement :meth:`run`, which receives the parsed args dict and
    a context; returns a :class:`ToolResult` or raises
    :class:`ToolError` for a controlled failure.
    """

    name: str = ""
    description: str = ""
    parameters: dict[str, Any] = {}
    # Logical grouping (Phase D1). The chat router exposes tools to the
    # model in *categories*: ``"artefact"`` (PDF/image generators —
    # gated by the ``tools_enabled`` user toggle) and ``"search"``
    # (``web_search`` / ``fetch_url`` — gated by ``web_search_mode``).
    # Add a new category if you ship a tool family that needs its own
    # opt-in; the registry lookup will pick it up automatically.
    category: str = "artefact"
    # Optional. Used by :func:`app.chat.tools.prompt.build_tools_system_prompt`
    # to render the per-tool bullet inside the tool-aware system message.
    # When unset (the default) the system prompt falls back to
    # ``description``. Override with a punchier, more conversational
    # one-liner when the OpenAI ``description`` is heavy on schema-style
    # detail and you want the system prompt to read more naturally.
    prompt_hint: str | None = None
    # Optional per-turn invocation cap. ``None`` (the default) means
    # "as many as the model wants, up to ``MAX_TOOL_HOPS``". A positive
    # int makes the dispatch loop refuse the (cap+1)-th call in the
    # same turn and surface a tool error so the model can react. Used
    # by costly tools — image generation in particular — to protect
    # the user's budget against a runaway loop without lowering the
    # global hop limit for cheap tools (echo / attach_demo).
    max_per_turn: int | None = None

    def to_openai_schema(self) -> dict[str, Any]:
        """Render this tool as an entry in OpenAI's ``tools[]`` array."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    @abc.abstractmethod
    async def run(
        self, ctx: ToolContext, args: dict[str, Any]
    ) -> ToolResult:  # pragma: no cover — abstract
        ...
