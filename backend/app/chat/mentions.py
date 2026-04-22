"""Parse and resolve ``@[title](conversation_id)`` mention tokens.

Phase C of project-memory: the composer lets the user type ``@`` to
pull another conversation into the current turn. On send, the
client embeds the selection as a Markdown-esque token:

    @[The big SRE refactor](3a7e6c9e-...-...)

We want two things to happen at send time:

1. The raw token stays in the user's message content as-is so it
   can be rendered as a clickable chip in history (see the
   ``@`` branch in ``MessageBubble.tsx``) and round-trips through
   export / import unchanged.

2. The model's context gets a **summary of each referenced chat**
   prepended as a system note, so the AI has the relevant
   background without the user having to paste it. We reuse
   :mod:`app.chat.summariser`'s cached summary path — no extra
   LLM calls if the referenced chat hasn't grown since last use.

This module deliberately does *not* live in ``router.py`` because
the router already tops 2,000 lines; isolating the regex + the
(slightly fiddly) access-control + summary-orchestration logic
keeps it reviewable and unit-testable.
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Conversation
from app.chat.shares import get_accessible_conversation
from app.chat.summariser import SummariseError, get_or_generate_summary
from app.models_config.models import ModelProvider

logger = logging.getLogger("promptly.chat.mentions")

# Matches ``@[Display title](uuid)``. Display title allows most
# printable characters except ``]`` (reserved for the token
# delimiter). UUID group is validated separately with ``uuid.UUID``
# — a loose regex keeps the pattern forgiving against any v1/v4
# dashes the frontend might produce.
_MENTION_RE: Final[re.Pattern[str]] = re.compile(
    r"@\[([^\]\n]+?)\]\(([0-9a-fA-F-]{32,})\)"
)

# Soft ceiling on references per turn. Each one costs a DB lookup
# plus potentially a summary-generation LLM call; letting the user
# fan out to 20 chats in a single turn is mostly a foot-gun. If
# they hit the cap we silently keep the first N unique ids and drop
# the rest — the tokens stay in the text, they just don't get
# expanded in context.
_MAX_MENTIONS_PER_TURN: Final[int] = 5


@dataclass(frozen=True)
class MentionToken:
    """One parsed ``@[title](id)`` occurrence."""

    title: str
    conversation_id: uuid.UUID
    raw: str  # the exact substring, useful for logging / frontend highlights


def extract_mentions(text: str | None) -> list[MentionToken]:
    """Return the deduplicated list of mentions found in ``text``.

    Deduplication is by ``conversation_id`` — a user referencing the
    same chat twice in one message shouldn't pay for two summary
    injections. Order of first appearance is preserved so the
    resolver reports them back in reading order.

    Tokens with malformed UUIDs are skipped (not errored) — the
    user will just see them render as plain text, matching the
    "graceful degrade" policy the rest of the chat pipeline uses.
    """
    if not text:
        return []
    seen: set[uuid.UUID] = set()
    out: list[MentionToken] = []
    for m in _MENTION_RE.finditer(text):
        title = m.group(1).strip()
        id_str = m.group(2)
        try:
            conv_id = uuid.UUID(id_str)
        except (ValueError, TypeError):
            continue
        if conv_id in seen:
            continue
        seen.add(conv_id)
        out.append(
            MentionToken(
                title=title,
                conversation_id=conv_id,
                raw=m.group(0),
            )
        )
        if len(out) >= _MAX_MENTIONS_PER_TURN:
            break
    return out


@dataclass
class ResolvedReference:
    """One mention expanded with its (possibly generated) summary."""

    token: MentionToken
    conversation: Conversation
    summary: str


async def resolve_mentions(
    mentions: list[MentionToken],
    *,
    caller: User,
    exclude_conversation_id: uuid.UUID | None,
    llm_provider: ModelProvider,
    llm_model_id: str,
    db: AsyncSession,
) -> list[ResolvedReference]:
    """For each ``mention`` the caller has access to, fetch or
    generate its summary and return a ``ResolvedReference``.

    * Skips the current conversation (``exclude_conversation_id``)
      so a user accidentally ``@``-mentioning the chat they're
      already in doesn't cause an infinite-loop-ish self-reference.
    * Skips any mention the caller doesn't have access to (owner
      role or collaborator on a shared chat). We silently drop
      rather than error so a malicious sender can't probe the
      existence of other users' conversation ids.
    * Skips any mention whose chat is too short to summarise. The
      raw token still renders as a chip in the history, but the
      model won't receive an empty "here's context" block.
    """
    out: list[ResolvedReference] = []
    for m in mentions:
        if (
            exclude_conversation_id is not None
            and m.conversation_id == exclude_conversation_id
        ):
            continue
        try:
            conv, _role = await get_accessible_conversation(
                m.conversation_id, caller, db
            )
        except Exception:  # includes 403/404 HTTPException
            # The mention points at a chat this user can't read —
            # either it doesn't exist or it belongs to someone else
            # without a share. Drop silently.
            logger.info(
                "Dropping mention %s — not accessible to user %s",
                m.conversation_id,
                caller.id,
            )
            continue

        try:
            summary = await get_or_generate_summary(
                conversation=conv,
                llm_provider=llm_provider,
                llm_model_id=llm_model_id,
                db=db,
            )
        except SummariseError as e:
            # Provider failure — don't block the whole send for a
            # single bad mention. Log and move on.
            logger.warning(
                "Summary generation failed for mention %s: %s",
                m.conversation_id,
                e,
            )
            continue

        if not summary:
            # Too short to summarise. Still legal to @-mention, just
            # adds nothing to context.
            continue

        out.append(
            ResolvedReference(
                token=m,
                conversation=conv,
                summary=summary,
            )
        )
    return out


def build_reference_system_block(
    references: list[ResolvedReference],
) -> str | None:
    """Render resolved references into a single system-prompt block.

    Returns ``None`` if there are no references, so callers can do
    a simple ``if block: merge_system_prompt(block, ...)`` without
    needing to case on the empty-list path.

    Format is deliberately plain-Markdown so any reasonable model
    reads the blockquote naturally. The leading notice tells the
    model *why* the block exists — without it, some models
    hallucinate that these are new user questions instead of
    reference context.
    """
    if not references:
        return None
    parts: list[str] = [
        "The user has referenced one or more earlier conversations "
        "in this message via `@[title](id)` tokens. Below is a "
        "summary of each referenced chat so you can use its "
        "context when relevant. Treat this strictly as background "
        "— do not reply *to* the referenced chats, only use them "
        "to inform your answer to the user's current message."
    ]
    for ref in references:
        title = (ref.conversation.title or "Untitled chat").strip() or "Untitled chat"
        parts.append(f"---\n### Referenced chat: {title}\n\n{ref.summary.strip()}")
    parts.append("---")
    return "\n\n".join(parts)


__all__ = [
    "MentionToken",
    "ResolvedReference",
    "build_reference_system_block",
    "extract_mentions",
    "resolve_mentions",
]
