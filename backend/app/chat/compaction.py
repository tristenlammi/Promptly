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

All of this runs on the *visible* thread (``active_path``), never on
every row: regenerated and edited versions the user switched away from
are not part of the conversation being compacted.

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
from app.chat.versioning import active_path, lineage_to
from app.models_config.models import ModelProvider
from app.models_config.provider import (
    ChatMessage,
    ProviderError,
    model_router,
)

logger = logging.getLogger("promptly.chat.compaction")

# Keep the first 2 verbatim — they set the scene (the user's opening
# question + initial clarification) and anchor the rest of the chat.
_KEEP_HEAD: Final[int] = 2

# The live tail is chosen by *token budget*, not a fixed message count:
# keeping a fixed N messages frees almost nothing when those N happen to
# be huge (long code blocks, pasted logs). Instead we keep recent
# messages until their running token estimate fills this budget. Always
# keep at least ``_MIN_KEEP_TAIL`` (the current Q&A) and never more than
# ``_MAX_KEEP_TAIL`` (bounds a tail of many tiny messages).
_DEFAULT_KEEP_TAIL_TOKENS: Final[int] = 4000
_MIN_KEEP_TAIL: Final[int] = 2
_MAX_KEEP_TAIL: Final[int] = 40

# Minimum compactable size — below this, the operation is a no-op.
# No point compressing 3 messages into a 1-message summary; you'd
# lose more fidelity than you'd save.
_MIN_TO_COMPACT: Final[int] = 4


def _estimate_tokens(text: str | None) -> int:
    """Cheap char/4 token estimate — the same heuristic the chunker and
    the workspace RAG packer use. Good enough to pick a split point."""
    if not text:
        return 0
    return max(0, len(text) // 4)


def _select_tail_count(
    rows: list[Message], *, keep_tail_tokens: int, head_count: int
) -> int:
    """Number of trailing messages to keep verbatim, chosen by token
    budget rather than a fixed count.

    Walks from the newest message backwards, keeping messages while the
    running token total stays within ``keep_tail_tokens``. Always keeps
    at least ``_MIN_KEEP_TAIL`` so the current exchange survives, and
    never exceeds ``_MAX_KEEP_TAIL``.
    """
    available = len(rows) - head_count
    if available <= _MIN_KEEP_TAIL:
        return max(0, available)
    kept = 0
    acc = 0
    for m in reversed(rows[head_count:]):
        if kept >= _MAX_KEEP_TAIL:
            break
        tok = _estimate_tokens(m.content)
        # Past the floor, stop once one more message would blow the
        # budget — but never drop below the floor on token grounds.
        if kept >= _MIN_KEEP_TAIL and acc + tok > keep_tail_tokens:
            break
        acc += tok
        kept += 1
    return min(kept, available)

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
    keep_tail_tokens: int = _DEFAULT_KEEP_TAIL_TOKENS,
) -> CompactionResult:
    """Summarise the middle of ``conversation`` in place.

    The kept tail is sized by ``keep_tail_tokens`` (token-aware) rather
    than a fixed message count, so compaction frees meaningful space even
    when the most recent messages are large.

    Caller is expected to have already validated authorisation on
    ``conversation``. The DB session is committed before returning
    so the deletes + insert land atomically.
    """
    all_rows = list(
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
    # Work on the visible thread only. Slicing every row by position used
    # to mix in regenerated/edited versions the user had moved away from:
    # the summary could be spliced onto an off-path row, the visible
    # thread cut down to its last message, and the rest deleted (R-018).
    rows = active_path(all_rows, conversation.active_leaf_message_id)
    total = len(rows)
    head_count = min(_KEEP_HEAD, total)
    # Cheap early-out before the (token-aware) tail walk: even with the
    # smallest possible tail there must be room for a worthwhile middle.
    if total < head_count + _MIN_KEEP_TAIL + _MIN_TO_COMPACT:
        raise CompactionError(
            f"Not enough history to compact — need at least "
            f"{head_count + _MIN_KEEP_TAIL + _MIN_TO_COMPACT} messages, "
            f"got {total}."
        )

    tail_count = _select_tail_count(
        rows, keep_tail_tokens=keep_tail_tokens, head_count=head_count
    )
    head = rows[:head_count]
    tail = rows[total - tail_count :] if tail_count else []
    middle = rows[head_count : total - tail_count] if tail_count else rows[head_count:]
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
    # Phase 2.6 — splice the summary into the lineage where the middle
    # used to be: its parent is the last head row, and the first tail row
    # is re-pointed to the summary. Deleting the middle would otherwise
    # SET NULL the tail's parent_id and sever the active-path walk.
    summary_message = Message(
        conversation_id=conversation.id,
        role="system",
        content=_COMPACTION_PREFIX.format(n=len(middle)) + summary,
        parent_id=head[-1].id if head else None,
        created_at=middle[0].created_at,
    )
    db.add(summary_message)

    # Delete the compacted rows and any branch hanging off them (a version
    # of a compacted message can't be reached once its parent is gone).
    # Alternative versions that branch off the kept head are untouched —
    # they stay switchable alongside the summary.
    # The first kept message — and any alternative versions of it — hang
    # off the last compacted one; they move onto the summary instead.
    reattach = [r for r in all_rows if r.parent_id == middle[-1].id]
    doomed = _subtrees(
        all_rows, {m.id for m in middle}, keep={r.id for r in reattach}
    )
    await db.flush()
    await db.refresh(summary_message)
    for r in reattach:
        r.parent_id = summary_message.id
    await db.flush()
    await db.execute(delete(Message).where(Message.id.in_(doomed)))
    await db.flush()

    # Never commit a thread that no longer reaches its start.
    if conversation.active_leaf_message_id is not None:
        remaining = [r for r in all_rows if r.id not in doomed] + [summary_message]
        walk = lineage_to(remaining, conversation.active_leaf_message_id)
        if not walk or walk[0].parent_id is not None or (head and walk[0].id != head[0].id):
            await db.rollback()
            raise CompactionError("Compaction would break this conversation; nothing was changed.")

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
        messages_removed=len(doomed),
        summary_message_id=str(summary_message.id),
    )


def _subtrees(rows: list[Message], roots: set, *, keep: set) -> set:
    """``roots`` plus every descendant, never crossing into ``keep``."""
    children: dict = {}
    for r in rows:
        children.setdefault(r.parent_id, []).append(r.id)
    out: set = set()
    stack = list(roots)
    while stack:
        cur = stack.pop()
        if cur in out or cur in keep:
            continue
        out.add(cur)
        stack.extend(children.get(cur, []))
    return out


def is_compaction_summary(message: Message) -> bool:
    """Helper for the UI / tests: did we generate this system message
    via ``compact_conversation``? The prefix is stable enough to
    detect without needing an extra column on the table."""
    if message.role != "system":
        return False
    content = (message.content or "").lstrip()
    return content.startswith("[Compacted summary of ")
