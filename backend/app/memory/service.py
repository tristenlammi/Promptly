"""Cross-chat memory: prompt injection, capture, and helpers (Phase 6).

Two jobs:

1. **Injection** — :func:`build_memory_prompt` renders the user's saved
   facts into a system-prompt block, mirroring the ambient personal-context
   block so the assistant "just knows" durable things across chats.
2. **Capture** — :func:`capture_memories` runs a cheap, bounded headless
   extraction over the latest turn (gated by :func:`should_attempt_capture`
   so ordinary turns cost nothing) and persists any genuinely new facts.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Final

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.titler import _strip_think_blocks
from app.custom_models.embedding import (
    embed_texts,
    normalise_for_embedding,
    vector_literal,
)
from app.chat.semantic_search import EmbeddingConfig, get_embedding_config
from app.memory.constants import (
    MAX_CONTENT_CHARS,
    MAX_MEMORIES,
    MAX_NEW_PER_TURN,
)
from app.memory.models import UserMemory
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, model_router

logger = logging.getLogger("promptly.memory")


def _content_hash(content: str) -> str:
    """Fingerprint of the embedded text so the indexer can detect edits."""
    return hashlib.md5(content.encode("utf-8")).hexdigest()


async def embed_memory_row(
    db: AsyncSession,
    memory: UserMemory,
    cfg: EmbeddingConfig | None = None,
) -> bool:
    """Embed one memory's content and write the vector onto its row.

    Best-effort: returns ``True`` if a vector was written, ``False`` when
    embeddings aren't configured or the provider call fails (the row just
    stays un-embedded and falls back to recency retrieval). Does NOT
    commit — the caller owns the transaction.
    """
    if cfg is None:
        cfg = await get_embedding_config(db)
    if cfg is None:
        return False
    cleaned = normalise_for_embedding(memory.content or "")
    if not cleaned:
        return False
    try:
        vectors = await embed_texts(
            provider=cfg.provider, model_id=cfg.model_id, texts=[cleaned]
        )
    except Exception as exc:  # noqa: BLE001 — never break the caller
        logger.warning("memory embed failed id=%s: %s", memory.id, exc)
        return False
    if not vectors:
        return False
    # Write via raw SQL CAST so pgvector accepts the literal regardless of
    # which dim column is active; NULL the other dim so a model switch
    # leaves a single source of truth.
    col = f"embedding_{cfg.dim}"
    other = f"embedding_{1536 if cfg.dim == 768 else 768}"
    await db.execute(
        text(
            f"""
            UPDATE user_memories
               SET {col} = CAST(:vec AS vector({cfg.dim})),
                   {other} = NULL,
                   embed_dim = :dim,
                   content_hash = :chash
             WHERE id = :mid
            """
        ),
        {
            "vec": vector_literal(vectors[0]),
            "dim": cfg.dim,
            "chash": _content_hash(memory.content or ""),
            "mid": memory.id,
        },
    )
    return True

# ----------------------------------------------------------------------
# Capture pre-filter
# ----------------------------------------------------------------------
# Running an extra model call after every single turn would be wasteful,
# so we only attempt capture when the user's message looks like it might
# contain something durable: an explicit "remember…" request, or a
# first-person statement of identity / preference / situation. Ordinary
# Q&A turns ("what's the capital of France?") match nothing and skip the
# extraction entirely — zero added cost.
_CAPTURE_HINT_RE: Final[re.Pattern[str]] = re.compile(
    r"""
    \b(
        remember\s+(that|this|my|i|to|me)         # "remember that I…"
      | don'?t\s+forget
      | note\s+that
      | keep\s+in\s+mind
      | for\s+(future|next\s+time|reference)
      | from\s+now\s+on
      | call\s+me
      | my\s+name\s+is
      | i\s?'?\s?a?m\s+(a|an)\b                    # "I'm a…", "I am an…"
      | i\s+(prefer|like|love|hate|use|work|live|need|want|always|usually|never)\b
      | i\s?'?\s?m\s+(working|building|using|learning|studying)
      | my\s+(favou?rite|preferred|goal|job|role|team|stack|company|timezone|pronouns)
    )\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

_EXTRACT_SYSTEM_PROMPT: Final[str] = (
    "You maintain a long-term memory of durable facts about a user for an "
    "AI assistant. You are given the latest exchange between the user and "
    "the assistant. Extract ONLY durable, reusable facts about the USER "
    "that would help personalise FUTURE, unrelated conversations.\n\n"
    "Capture things like: their name or what to call them, role/profession, "
    "the tools/languages/frameworks they use, stable preferences (tone, "
    "format, units), ongoing projects, and explicit 'remember this' "
    "requests.\n\n"
    "Do NOT capture: one-off task details, the answer to their question, "
    "transient state, anything time-bound ('I'm tired today'), sensitive "
    "data they didn't ask you to remember (passwords, full card/ID "
    "numbers), or things already obvious.\n\n"
    "Write each fact as a single concise third-person statement starting "
    "with 'User ' (e.g. 'User is a Rust developer', 'User prefers concise "
    "answers'). Output STRICTLY a JSON array of strings and nothing else. "
    "If there is nothing worth remembering, output []."
)

_MAX_USER_CHARS: Final[int] = 4000
_MAX_ASSISTANT_CHARS: Final[int] = 2000
_MAX_EXTRACT_TOKENS: Final[int] = 400


def should_attempt_capture(user_text: str | None) -> bool:
    """Cheap gate — only run the extraction model when the turn plausibly
    contains a durable fact. Keeps cost at zero for normal Q&A turns."""
    if not user_text:
        return False
    return bool(_CAPTURE_HINT_RE.search(user_text))


def _normalise(text: str) -> str:
    """Lowercased, whitespace-collapsed, punctuation-trimmed key used for
    duplicate detection (not for storage/display)."""
    return re.sub(r"\s+", " ", text.lower()).strip(" .!?,;:\"'`")


def _is_duplicate(candidate: str, existing_keys: list[str]) -> bool:
    """A candidate is a dupe if its normalised form equals, contains, or
    is contained by an existing fact — kills "User likes Python" vs
    "User likes Python a lot" churn."""
    key = _normalise(candidate)
    if not key:
        return True
    for ex in existing_keys:
        if not ex:
            continue
        if key == ex or key in ex or ex in key:
            return True
    return False


def build_memory_prompt(memories: list[UserMemory]) -> str | None:
    """Render saved facts into a system-prompt block, or ``None`` when the
    user has no memories. Phrased as background knowledge with an explicit
    "don't recite it" instruction, matching the personal-context block."""
    facts = [m.content.strip() for m in memories if m.content and m.content.strip()]
    if not facts:
        return None
    lines = [
        "Saved memory about the user (durable facts learned from past "
        "conversations — treat as background you already know):",
    ]
    lines.extend(f"- {f}" for f in facts)
    lines.append("")
    lines.append(
        "Apply these when relevant, but do NOT recite them back, list "
        "them, or thank the user for them unless they ask. Just behave as "
        "if you already knew."
    )
    return "\n".join(lines)


async def load_memories(
    db: AsyncSession, user_id, *, limit: int = MAX_MEMORIES
) -> list[UserMemory]:
    """Most-recent-first slice of a user's memories (capped)."""
    rows = (
        (
            await db.execute(
                select(UserMemory)
                .where(UserMemory.user_id == user_id)
                .order_by(UserMemory.created_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return list(rows)


async def count_memories(db: AsyncSession, user_id) -> int:
    return int(
        await db.scalar(
            select(func.count())
            .select_from(UserMemory)
            .where(UserMemory.user_id == user_id)
        )
        or 0
    )


async def build_memory_system_prompt(db: AsyncSession, user_id) -> str | None:
    """Convenience: load + render in one call for the chat router."""
    memories = await load_memories(db, user_id)
    return build_memory_prompt(memories)


def _parse_facts(raw: str) -> list[str]:
    """Pull a JSON array of strings out of a model response, tolerating a
    stray code-fence or preamble."""
    cleaned = _strip_think_blocks(raw).strip()
    if not cleaned:
        return []
    # Isolate the outermost [...] so a chatty model that adds "Here are
    # the facts:" doesn't break json.loads.
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        parsed = json.loads(cleaned[start : end + 1])
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    facts: list[str] = []
    for item in parsed:
        if not isinstance(item, str):
            continue
        fact = item.strip()
        if fact:
            facts.append(fact[:MAX_CONTENT_CHARS])
    return facts


async def capture_memories(
    db: AsyncSession,
    *,
    user_id,
    user_text: str,
    assistant_text: str,
    source_conversation_id,
    provider: ModelProvider,
    model_id: str,
) -> list[str]:
    """Extract durable facts from the latest turn and persist the new ones.

    Returns the list of fact strings that were actually saved (so the
    caller can surface a "saved to memory" affordance). Best-effort: any
    failure logs and returns ``[]`` without disturbing the chat turn.
    Adds + flushes the new rows but leaves the commit to the caller so it
    lands in the same transaction as the rest of the post-turn writes.
    """
    user_text = (user_text or "").strip()[:_MAX_USER_CHARS]
    if not user_text:
        return []

    assistant_text = (assistant_text or "").strip()[:_MAX_ASSISTANT_CHARS]

    existing = await load_memories(db, user_id)
    if len(existing) >= MAX_MEMORIES:
        # Store is full — don't spend a model call we can't act on.
        return []
    existing_keys = [_normalise(m.content) for m in existing]

    payload = f"User said:\n{user_text}"
    if assistant_text:
        payload += f"\n\nAssistant replied:\n{assistant_text}"

    chunks: list[str] = []
    try:
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=payload)],
            system=_EXTRACT_SYSTEM_PROMPT,
            temperature=0.0,
            max_tokens=_MAX_EXTRACT_TOKENS,
            reasoning_effort="off",
        ):
            chunks.append(token)
    except Exception:  # noqa: BLE001 — capture must never break the turn
        logger.exception("Memory extraction call failed user=%s", user_id)
        return []

    candidates = _parse_facts("".join(chunks))
    if not candidates:
        return []

    saved: list[str] = []
    new_rows: list[UserMemory] = []
    room = MAX_MEMORIES - len(existing)
    for fact in candidates:
        if len(saved) >= MAX_NEW_PER_TURN or len(saved) >= room:
            break
        if _is_duplicate(fact, existing_keys):
            continue
        row = UserMemory(
            user_id=user_id,
            content=fact,
            source="auto",
            source_conversation_id=source_conversation_id,
        )
        db.add(row)
        new_rows.append(row)
        saved.append(fact)
        existing_keys.append(_normalise(fact))

    if saved:
        try:
            await db.flush()
        except Exception:  # noqa: BLE001
            logger.exception("Memory persist flush failed user=%s", user_id)
            return []
        # Embed the new facts so they're retrievable (best-effort; a
        # single config lookup shared across the batch). Never fatal.
        try:
            cfg = await get_embedding_config(db)
            if cfg is not None:
                for row in new_rows:
                    await embed_memory_row(db, row, cfg)
        except Exception:  # noqa: BLE001
            logger.warning("memory embed-on-capture failed user=%s", user_id)
    return saved
