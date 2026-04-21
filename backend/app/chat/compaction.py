"""Middle-compaction of long conversations.

Called from ``POST /conversations/{id}/compact`` when the user wants
to reclaim context space before the model starts dropping earlier
messages silently. We:

1. Keep the first ``_KEEP_HEAD`` messages verbatim — they usually set
   the scene (the user's opening question, the initial clarification,
   etc.) and anchor the rest of the chat.
2. Keep the last ``_KEEP_TAIL`` messages verbatim — whatever the user
   is actively working on in the foreground.
3. Ask the active model to summarise everything in between. The
   summary is inserted as a single ``role="system"`` message with a
   distinctive header so the UI can render it as a "compacted"
   pill rather than a plain system instruction.
4. Hard-delete the original middle rows. Compaction is destructive —
   a "keep both" option would defeat the point of freeing context.

The function is best-effort: if the LLM call fails (rate limit,
network, provider error), we leave the conversation untouched and
raise ``CompactionError`` so the API layer can return a 502. A
half-applied compaction would corrupt the history.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Final

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.models import Conversation, Message
from app.models_config.models import ModelProvider
from app.models_config.provider import (
    ChatMessage,
    ProviderError,
    model_router,
)

logger = logging.getLogger("promptly.chat.compaction")

# Keep the first 2 and last 8 verbatim. Covers the "intro + goal" at
# the top and the "what we're working on right now" at the bottom
# without risking losing the thread of the current discussion.
_KEEP_HEAD: Final[int] = 2
_KEEP_TAIL: Final[int] = 8

# Minimum compactable size — below this, the operation is a no-op.
# No point compressing 3 messages into a 1-message summary; you'd
# lose more fidelity than you'd save.
_MIN_TO_COMPACT: Final[int] = 4

# Prefix we stamp onto the summary so the frontend can detect a
# compaction-generated system row and render it with the "Compacted
# summary" chip instead of looking like an invisible system
# instruction.
_COMPACTION_PREFIX: Final[str] = "[Compacted summary of {n} earlier messages]\n\n"

_SUMMARISE_SYSTEM_PROMPT: Final[str] = (
    "You are a conversation summariser. Your output will replace a "
    "block of older turns in the middle of a chat so the model can "
    "keep going without running out of context.\n\n"
    "Rules:\n"
    "- Capture every concrete fact, decision, preference, open "
    "question, and piece of code / data the assistant would need to "
    "continue helping. Do not paraphrase loosely; preserve specifics.\n"
    "- Preserve speaker attribution. Write in the form 'The user ...', "
    "'The assistant ...'.\n"
    "- Use compact bullet points grouped by topic. No preamble, no "
    "sign-off, no commentary about the summary itself.\n"
    "- Omit social chit-chat and redundant restatements, but never "
    "drop a fact that might be referenced later.\n"
    "- Hard ceiling: ~400 words. Aim shorter when possible."
)


class CompactionError(RuntimeError):
    """Raised when the LLM call fails and no messages were touched."""


@dataclass
class CompactionResult:
    messages_removed: int
    summary_message_id: str


def _format_for_summary(messages: list[Message]) -> str:
    """Turn a slice of ORM messages into a transcript the model can
    read. ``role`` names are kept terse so the token overhead stays
    low — these transcripts can themselves be long."""
    lines: list[str] = []
    for m in messages:
        role = (m.role or "user").upper()
        content = (m.content or "").strip()
        if not content:
            continue
        lines.append(f"{role}: {content}")
    return "\n\n".join(lines)


async def compact_conversation(
    *,
    conversation: Conversation,
    llm_provider: ModelProvider,
    llm_model_id: str,
    db: AsyncSession,
) -> CompactionResult:
    """Summarise the middle of ``conversation`` in place.

    Caller is expected to have already validated authorisation on
    ``conversation``. The DB session is committed before returning
    so the deletes + insert land atomically.
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
    total = len(rows)
    # Nothing to compact if we can't even squeeze out the min middle
    # slice after reserving head+tail.
    if total <= _KEEP_HEAD + _KEEP_TAIL + _MIN_TO_COMPACT - 1:
        raise CompactionError(
            f"Not enough history to compact — need at least "
            f"{_KEEP_HEAD + _KEEP_TAIL + _MIN_TO_COMPACT} messages, got {total}."
        )

    head = rows[:_KEEP_HEAD]
    tail = rows[-_KEEP_TAIL:]
    middle = rows[_KEEP_HEAD : total - _KEEP_TAIL]
    if len(middle) < _MIN_TO_COMPACT:
        raise CompactionError(
            "Middle slice is too short to meaningfully compact."
        )

    transcript = _format_for_summary(middle)
    if not transcript:
        raise CompactionError("Middle slice has no textual content to compact.")

    # Call the same model the chat is using so the summary style
    # matches the ongoing conversation (and so the user's own
    # provider credentials / rate limits pay for the call, not a
    # privileged server-side default).
    try:
        chunks: list[str] = []
        async for token in model_router.stream_chat(
            provider=llm_provider,
            model_id=llm_model_id,
            messages=[ChatMessage(role="user", content=transcript)],
            system=_SUMMARISE_SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=700,
        ):
            chunks.append(token)
        summary = "".join(chunks).strip()
    except ProviderError as e:
        logger.warning("Compaction failed (provider error): %s", e)
        raise CompactionError(str(e)) from e

    if not summary:
        raise CompactionError("Model returned an empty summary.")

    # Land the result in one transaction: delete the middle rows,
    # insert the summary where they used to be. Because Message.id
    # is UUID + created_at orders the timeline, we use the first
    # middle row's created_at so the new summary sits naturally in
    # the same slot — no re-ordering needed on reload.
    summary_message = Message(
        conversation_id=conversation.id,
        role="system",
        content=_COMPACTION_PREFIX.format(n=len(middle)) + summary,
        created_at=middle[0].created_at,
    )
    db.add(summary_message)

    middle_ids = [m.id for m in middle]
    await db.execute(delete(Message).where(Message.id.in_(middle_ids)))
    await db.flush()
    await db.refresh(summary_message)

    # Bump the conversation's updated_at so sidebar bucketing reflects
    # the compaction activity.
    conversation.updated_at = summary_message.created_at

    await db.commit()

    logger.info(
        "Compacted %d middle messages on conversation %s into system summary %s",
        len(middle),
        conversation.id,
        summary_message.id,
    )

    return CompactionResult(
        messages_removed=len(middle),
        summary_message_id=str(summary_message.id),
    )


def is_compaction_summary(message: Message) -> bool:
    """Helper for the UI / tests: did we generate this system message
    via ``compact_conversation``? The prefix is stable enough to
    detect without needing an extra column on the table."""
    if message.role != "system":
        return False
    content = (message.content or "").lstrip()
    return content.startswith("[Compacted summary of ")
