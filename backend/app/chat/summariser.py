"""Summarise a whole conversation as a standalone Markdown document.

This is adjacent to :mod:`app.chat.compaction` but the goals are
different:

* *Compaction* squeezes the **middle** of an active chat to free
  context space; the summary lives on as a ``role="system"`` row
  inside the same conversation and the original middle turns are
  deleted.
* *Summarisation* produces a pretty, scannable Markdown document
  that describes the **whole** chat end-to-end. Nothing inside the
  conversation is touched. The result is meant to be written to a
  file and surfaced in other contexts (pinned to a project, shared
  with a collaborator, exported, referenced via ``@chat-name``).

Phase B wires this into a new endpoint that saves the returned
Markdown as a :class:`UserFile` in the user's Generated folder and
auto-pins it to the conversation's parent project. Phase C will
reuse the same function to back the ``@chat-name`` mention feature
with a cached summary column on the ``conversations`` table.

The function is best-effort: if the LLM call fails, we raise
``SummariseError`` and the API layer surfaces a 502. We never
produce a partial file.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.models import Conversation, Message
from app.models_config.models import ModelProvider
from app.models_config.provider import (
    ChatMessage,
    ProviderError,
    model_router,
)

logger = logging.getLogger("promptly.chat.summariser")


class SummariseError(RuntimeError):
    """Raised when the LLM call fails and no file was written."""


# Hard ceiling on the summary so it stays small enough to cheaply
# prepend to future turns (Phase C). We ask the model for "under
# ~800 words" in the system prompt; this is the belt-and-braces
# max-tokens on the provider call itself.
_MAX_SUMMARY_TOKENS: Final[int] = 1500

# Minimum history to bother summarising. A two-turn chat doesn't
# need a summary — the raw transcript is already small enough to
# prepend wholesale. Below this we raise and the UI disables the
# action rather than producing a low-signal document.
_MIN_MESSAGES_TO_SUMMARISE: Final[int] = 4

_SUMMARY_SYSTEM_PROMPT: Final[str] = (
    "You are writing a concise Markdown memo that captures the "
    "essence of a chat so another instance of the model can pick up "
    "the thread later or so a teammate can skim what was discussed.\n\n"
    "Output format (Markdown, no preamble, no sign-off):\n"
    "- A one-sentence `## Overview` describing what the chat was "
    "about and what the user was trying to accomplish.\n"
    "- A `## Key decisions` bulleted list of concrete conclusions "
    "reached, preferences stated, or parameters locked in. Omit the "
    "section entirely if there are none.\n"
    "- A `## Facts & context` bulleted list of durable facts about "
    "the user's situation, data, code, or environment that the "
    "model would need to continue helping. Include specifics "
    "(versions, numbers, names) — don't paraphrase away detail.\n"
    "- A `## Open questions` bulleted list of things that were "
    "raised but not resolved. Omit if none.\n"
    "- A `## Next steps` bulleted list of actions the user said "
    "they'd take or wanted the assistant to help with next. Omit "
    "if none.\n\n"
    "Rules:\n"
    "- Write in third person: 'The user ...', 'The assistant ...'.\n"
    "- No commentary about the summary itself. No 'Here is a "
    "summary'.\n"
    "- Preserve code snippets verbatim in fenced blocks when they "
    "are the subject of a decision; skip them otherwise.\n"
    "- Hard ceiling: under 800 words total. Aim for 300-500."
)


def _format_transcript(messages: list[Message]) -> str:
    """Render ORM messages as a plain transcript for the model.

    We skip empty content (tool-only turns with no prose) so the
    model isn't distracted by blank ``ASSISTANT:`` placeholders.
    """
    lines: list[str] = []
    for m in messages:
        role = (m.role or "user").upper()
        content = (m.content or "").strip()
        if not content:
            continue
        # System-role compaction summaries (from the compaction
        # module) are already condensed — treat them as trusted
        # context rather than re-summarising them alongside raw
        # chat turns.
        if m.role == "system":
            lines.append(f"[EARLIER SUMMARY]\n{content}")
        else:
            lines.append(f"{role}: {content}")
    return "\n\n".join(lines)


async def summarise_conversation_to_markdown(
    *,
    conversation: Conversation,
    llm_provider: ModelProvider,
    llm_model_id: str,
    db: AsyncSession,
) -> str:
    """Return a Markdown summary of ``conversation`` end-to-end.

    The summary is *not* persisted anywhere by this function — the
    caller decides whether to stash it on the conversation row
    (Phase C cache) or write it to a file (Phase B pin-to-project).
    Keeping persistence out of this module keeps it reusable.

    Raises :class:`SummariseError` if the chat is too short to
    meaningfully summarise or if the LLM call fails.
    """
    rows = (
        (
            await db.execute(
                select(Message)
                .where(Message.conversation_id == conversation.id)
                .order_by(Message.created_at.asc(), Message.id.asc())
            )
        )
        .scalars()
        .all()
    )
    # Count only turns with textual content — tool-only turns don't
    # contribute to the "is this chat long enough to summarise"
    # gauge even though they still sit in the timeline.
    textual = [m for m in rows if (m.content or "").strip()]
    if len(textual) < _MIN_MESSAGES_TO_SUMMARISE:
        raise SummariseError(
            f"This chat is too short to summarise — need at least "
            f"{_MIN_MESSAGES_TO_SUMMARISE} messages with text, "
            f"got {len(textual)}."
        )

    transcript = _format_transcript(rows)
    if not transcript:
        raise SummariseError("Chat has no textual content to summarise.")

    try:
        chunks: list[str] = []
        async for token in model_router.stream_chat(
            provider=llm_provider,
            model_id=llm_model_id,
            messages=[ChatMessage(role="user", content=transcript)],
            system=_SUMMARY_SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=_MAX_SUMMARY_TOKENS,
        ):
            chunks.append(token)
        summary = "".join(chunks).strip()
    except ProviderError as e:
        logger.warning(
            "Summarisation failed for conversation %s: %s",
            conversation.id,
            e,
        )
        raise SummariseError(str(e)) from e

    if not summary:
        raise SummariseError("Model returned an empty summary.")

    logger.info(
        "Generated summary for conversation %s (%d chars)",
        conversation.id,
        len(summary),
    )
    return summary


async def get_or_generate_summary(
    *,
    conversation: Conversation,
    llm_provider: ModelProvider,
    llm_model_id: str,
    db: AsyncSession,
) -> str | None:
    """Return a cached summary if fresh, otherwise regenerate in place.

    Used by the ``@[title](id)`` reference resolver on the chat-send
    path — we want a summary of the referenced chat to prepend to
    the current turn's context, but we don't want to pay for a
    fresh LLM call on every mention.

    Cache policy:

    * If ``conversation.summary_text`` is set and
      ``conversation.summary_generated_at`` is newer than the
      latest message's ``created_at``, return the cache.
    * Otherwise call :func:`summarise_conversation_to_markdown`,
      store the result on the row, and commit.

    Returns ``None`` (not an exception) if the referenced chat is
    too short to summarise — the resolver treats that as "skip the
    mention" rather than blocking the user's send. A provider
    failure still raises :class:`SummariseError` so the resolver
    can surface it as a warning toast.
    """
    latest_q = await db.execute(
        select(Message.created_at)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at.desc())
        .limit(1)
    )
    latest_created_at = latest_q.scalar_one_or_none()

    if (
        conversation.summary_text
        and conversation.summary_generated_at is not None
        and (
            latest_created_at is None
            or conversation.summary_generated_at >= latest_created_at
        )
    ):
        return conversation.summary_text

    # Cache miss or stale — regenerate. Let "too short" propagate as
    # ``None`` rather than bubbling an exception to the resolver;
    # the user mentioned a short chat, nothing to summarise, move on.
    try:
        summary = await summarise_conversation_to_markdown(
            conversation=conversation,
            llm_provider=llm_provider,
            llm_model_id=llm_model_id,
            db=db,
        )
    except SummariseError as e:
        msg = str(e)
        if "too short" in msg or "no textual" in msg:
            return None
        raise

    conversation.summary_text = summary
    conversation.summary_generated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(conversation)

    return summary


__all__ = [
    "SummariseError",
    "get_or_generate_summary",
    "summarise_conversation_to_markdown",
]
