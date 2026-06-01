"""Cross-chat memory: prompt injection, capture, and helpers (Phase 6 + Overhaul).

Two jobs:

1. **Injection** — :func:`build_memory_system_prompt` renders the user's saved
   facts into a system-prompt block, always including pinned facts first,
   then filling remaining slots with the top-K retrieved (or recency) facts.
2. **Capture** — :func:`capture_memories` runs a cheap, bounded headless
   extraction over the latest turn (gated by :func:`should_attempt_capture`
   so ordinary turns cost nothing) and persists any genuinely new facts via
   a reconciliation pass that can add, update, or delete existing rows.
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
    MEMORY_CATEGORIES,
    SEMANTIC_DUP_THRESHOLD,
)
from app.memory.models import UserMemory
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, model_router

logger = logging.getLogger("promptly.memory")

_VALID_CATEGORIES: frozenset[str] = frozenset(MEMORY_CATEGORIES)


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
        # Explicit save requests (any phrasing)
        remember\s+(that|this|my|i|to|me|the|we)
      | don'?t\s+forget
      | note\s+that
      | keep\s+in\s+mind
      | for\s+(future|next\s+time|reference)
      | from\s+now\s+on
      | store\s+this
      | save\s+this
      | make\s+a\s+note

        # First-person identity/preference
      | call\s+me
      | my\s+name\s+is
      | i\s?'?\s?a?m\s+(a|an)\b
      | i\s+(prefer|like|love|hate|use|work|live|need|want|always|usually|never)\b
      | i\s?'?\s?m\s+(working|building|using|learning|studying|based)
      | my\s+(favou?rite|preferred|goal|job|role|team|stack|company|timezone|pronouns|project)

        # Second-person (assistant noting something about the user)
      | you\s+(are|were|have|prefer|use|work|like|need|always|usually|never)\b
      | your\s+(name|role|job|team|stack|project|goal|company|timezone)\s+is

        # Collective "we" — often about the project/team
      | we\s+(use|prefer|chose|decided|standardis|settled\s+on|are\s+using|are\s+building)
      | we'?\s*re\s+(using|building|migrating|moving|switching)

        # Passive / project context
      | (the\s+)?(project|app|system|repo|codebase|stack|database)\s+is\s+(called|named|built|using|based)
    )\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

_MAX_USER_CHARS: Final[int] = 4000
_MAX_ASSISTANT_CHARS: Final[int] = 2000
_MAX_EXTRACT_TOKENS: Final[int] = 500


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


async def load_pinned_memories(
    db: AsyncSession, user_id
) -> list[UserMemory]:
    """All pinned facts for a user (typically a small set).

    These are always injected regardless of the top-K retrieval cap — the
    user's explicit "must-know" facts. Uses the partial index on
    ``(user_id) WHERE pinned = true`` added in migration 0061.
    """
    rows = (
        (
            await db.execute(
                select(UserMemory)
                .where(UserMemory.user_id == user_id, UserMemory.pinned.is_(True))
                .order_by(UserMemory.created_at.desc())
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


async def retrieve_relevant_memories(
    db: AsyncSession,
    user_id,
    *,
    query: str | None,
    k: int,
    cfg: EmbeddingConfig | None = None,
    exclude_ids: set | None = None,
) -> list[UserMemory]:
    """Return up to ``k`` memories most relevant to ``query`` by cosine
    similarity, falling back to most-recent-first when embeddings aren't
    configured, the query is empty, the lookup fails, or nothing is
    embedded yet. Best-effort — retrieval must never break a chat turn.

    ``exclude_ids`` — skip these memory ids (used to avoid re-including
    pinned facts that are already being added separately).
    """
    cleaned = normalise_for_embedding(query or "")
    if cfg is None:
        cfg = await get_embedding_config(db)

    _excl = exclude_ids or set()

    if cfg is None or not cleaned:
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return [m for m in rows if m.id not in _excl][:k]

    try:
        vectors = await embed_texts(
            provider=cfg.provider, model_id=cfg.model_id, texts=[cleaned]
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("memory retrieval embed failed user=%s: %s", user_id, exc)
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return [m for m in rows if m.id not in _excl][:k]
    if not vectors:
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return [m for m in rows if m.id not in _excl][:k]

    col = f"embedding_{cfg.dim}"
    # Fetch k + buffer to account for excluded ids without a second query.
    fetch_k = k + len(_excl) + 5
    sql = text(
        f"""
        SELECT id
        FROM user_memories
        WHERE user_id = :uid AND {col} IS NOT NULL
        ORDER BY {col} <=> CAST(:qvec AS vector({cfg.dim}))
        LIMIT :k
        """
    )
    try:
        rows_raw = (
            await db.execute(
                sql,
                {"uid": user_id, "qvec": vector_literal(vectors[0]), "k": fetch_k},
            )
        ).all()
    except Exception as exc:  # noqa: BLE001
        logger.warning("memory retrieval query failed user=%s: %s", user_id, exc)
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return [m for m in rows if m.id not in _excl][:k]

    ids = [r[0] for r in rows_raw if r[0] not in _excl][:k]
    if not ids:
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return [m for m in rows if m.id not in _excl][:k]

    fetched = (
        (await db.execute(select(UserMemory).where(UserMemory.id.in_(ids))))
        .scalars()
        .all()
    )
    # Preserve the cosine ordering (SQL IN doesn't guarantee it).
    by_id = {m.id: m for m in fetched}
    return [by_id[i] for i in ids if i in by_id]


async def build_memory_system_prompt(
    db: AsyncSession,
    user_id,
    *,
    query: str | None = None,
    k: int = MAX_MEMORIES,
) -> tuple[str | None, list[UserMemory]]:
    """Load, render, and stamp usage for a chat turn's system-prompt block.

    Returns ``(rendered_block | None, memories_injected)``.

    Pinned facts are always injected first (Phase 2.1). The remaining
    ``k - len(pinned)`` slots are filled with the top-K semantically
    relevant facts (or recency fallback) excluding the already-pinned ones.
    Degrades gracefully when embeddings aren't configured.

    Phase 3.1: stamps ``times_used`` / ``last_used_at`` on every injected
    fact as a best-effort UPDATE (never fails the chat turn on error).
    """
    pinned = await load_pinned_memories(db, user_id)
    pinned_ids = {m.id for m in pinned}
    remaining_k = max(0, k - len(pinned))

    if remaining_k > 0:
        retrieved = await retrieve_relevant_memories(
            db,
            user_id,
            query=query,
            k=remaining_k,
            exclude_ids=pinned_ids,
        )
    else:
        retrieved = []

    all_memories = pinned + retrieved

    # Stamp usage signals on every injected fact (Phase 3.1). Best-effort —
    # a failure here never disturbs the chat turn.
    if all_memories:
        ids = [m.id for m in all_memories]
        try:
            await db.execute(
                text(
                    """
                    UPDATE user_memories
                       SET times_used = times_used + 1,
                           last_used_at = NOW()
                     WHERE id = ANY(:ids)
                    """
                ),
                {"ids": ids},
            )
        except Exception:  # noqa: BLE001
            logger.warning("memory usage stamp failed user=%s", user_id)

    return build_memory_prompt(all_memories), all_memories


# Reconciliation prompt (Memory Overhaul 1.3 + 2.1). Unlike the append-only
# extractor, this one sees the user's EXISTING related facts (with ids)
# and returns operations, so a contradiction ("I moved to Rust") updates
# the stale fact in place instead of stacking a duplicate. Phase 2.1 adds
# category tagging to each add/update op.
_CATEGORY_LIST = " | ".join(MEMORY_CATEGORIES)
_RECONCILE_SYSTEM_PROMPT: Final[str] = (
    "You maintain a long-term memory of durable facts about a user for an "
    "AI assistant. You are given the latest exchange between the user and "
    "the assistant, plus the user's EXISTING saved facts (each with an id). "
    "Decide how the exchange should change memory and output ONLY a JSON "
    "array of operation objects.\n\n"
    "Operations:\n"
    '  {"op": "add", "text": "<new durable fact>", "category": "<cat>", "confidence": "high"|"low"} — '
    "a genuinely new fact not already covered by the existing list. Set "
    "confidence to \"high\" ONLY when you are certain this fact is durable "
    "and will still be relevant weeks from now. Use \"low\" for anything "
    "borderline — low-confidence adds are automatically discarded.\n"
    '  {"op": "update", "id": "<existing id>", "text": "<rewritten fact>", "category": "<cat>"} '
    "— when the exchange refines or CONTRADICTS an existing fact (e.g. the "
    "user switched their main language); rewrite that fact in place.\n"
    '  {"op": "delete", "id": "<existing id>"} — when an existing fact is no '
    "longer true and has no replacement.\n\n"
    f"Categories (use exactly one per add/update): {_CATEGORY_LIST}\n"
    "  identity = name, role, occupation, location, pronouns\n"
    "  preferences = tools, languages, formats, style, units\n"
    "  projects = active work, goals, ongoing builds\n"
    "  context = other durable background facts\n\n"
    "Capture durable, reusable facts about the USER: their name or what to "
    "call them, role/profession, tools/languages/frameworks, stable "
    "preferences (tone, format, units), ongoing projects, and explicit "
    "'remember this' requests.\n"
    "Do NOT capture (always use confidence 'low' or omit): one-off task "
    "details, the answer to their question, transient state, time-bound "
    "statements ('I'm tired today', 'I'm in a meeting'), emotional states, "
    "sensitive data they didn't ask you to remember (passwords, full "
    "card/ID numbers), or facts already present AND unchanged.\n\n"
    "Write each fact as a single concise third-person statement starting "
    "with 'User ' (e.g. 'User is a Rust developer'). Only use ids that "
    "appear in the existing list. If nothing should change, output []."
)


def _parse_ops(raw: str, valid_ids: set[str]) -> list[dict]:
    """Parse the reconciliation model's JSON op array, tolerating preamble.

    Returns a list of validated op dicts. ``update``/``delete`` are dropped
    unless their id is one we actually supplied (never act on an arbitrary
    id the model hallucinated). ``add``/``update`` require non-empty text.
    Category is extracted and validated against the controlled vocabulary;
    unknown values are coerced to None.
    """
    cleaned = _strip_think_blocks(raw).strip()
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
    ops: list[dict] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        op = item.get("op")
        raw_cat = (item.get("category") or "").strip().lower()
        category = raw_cat if raw_cat in _VALID_CATEGORIES else None
        if op == "add":
            txt = (item.get("text") or "").strip()
            confidence = (item.get("confidence") or "low").strip().lower()
            # Only save facts the model explicitly marks as high-confidence.
            # Anything borderline (low confidence or field absent) is dropped.
            if txt and confidence == "high":
                ops.append({"op": "add", "text": txt[:MAX_CONTENT_CHARS], "category": category})
        elif op == "update":
            mid = str(item.get("id") or "")
            txt = (item.get("text") or "").strip()
            if mid in valid_ids and txt:
                ops.append(
                    {
                        "op": "update",
                        "id": mid,
                        "text": txt[:MAX_CONTENT_CHARS],
                        "category": category,
                    }
                )
        elif op == "delete":
            mid = str(item.get("id") or "")
            if mid in valid_ids:
                ops.append({"op": "delete", "id": mid})
    return ops


async def _nearest_similarity(
    db: AsyncSession, user_id, cfg: EmbeddingConfig, candidate: str
) -> float:
    """Best cosine similarity (0–1) between ``candidate`` and any of the
    user's existing embedded memories. ``0.0`` when nothing is embedded or
    the embed/query fails — i.e. "no semantic duplicate found"."""
    cleaned = normalise_for_embedding(candidate)
    if not cleaned:
        return 0.0
    try:
        vectors = await embed_texts(
            provider=cfg.provider, model_id=cfg.model_id, texts=[cleaned]
        )
    except Exception:  # noqa: BLE001
        return 0.0
    if not vectors:
        return 0.0
    col = f"embedding_{cfg.dim}"
    sql = text(
        f"""
        SELECT 1 - ({col} <=> CAST(:qvec AS vector({cfg.dim}))) AS sim
        FROM user_memories
        WHERE user_id = :uid AND {col} IS NOT NULL
        ORDER BY {col} <=> CAST(:qvec AS vector({cfg.dim}))
        LIMIT 1
        """
    )
    try:
        row = (
            await db.execute(
                sql, {"uid": user_id, "qvec": vector_literal(vectors[0])}
            )
        ).first()
    except Exception:  # noqa: BLE001
        return 0.0
    return float(row[0]) if row and row[0] is not None else 0.0


async def capture_memories(
    db: AsyncSession,
    *,
    user_id,
    user_text: str,
    assistant_text: str,
    source_conversation_id,
    provider: ModelProvider,
    model_id: str,
) -> list[dict]:
    """Extract durable facts from the latest turn and persist the new ones.

    Returns a list of ``{"id": str, "content": str}`` dicts for every fact
    that was actually saved (added or updated), so the caller can surface
    a "saved to memory" affordance with the ability to undo by id.
    Best-effort: any failure logs and returns ``[]`` without disturbing the
    chat turn. Adds + flushes the new rows but leaves the commit to the
    caller so it lands in the same transaction as the rest of the
    post-turn writes.
    """
    user_text = (user_text or "").strip()[:_MAX_USER_CHARS]
    if not user_text:
        return []

    assistant_text = (assistant_text or "").strip()[:_MAX_ASSISTANT_CHARS]

    cfg = await get_embedding_config(db)
    total = await count_memories(db, user_id)

    # Show the model the existing facts most RELATED to this turn (with
    # ids) so it can update/contradict them rather than stack duplicates.
    # Falls back to most-recent when embeddings are off. Bounded so the
    # prompt stays cheap regardless of store size.
    related = await retrieve_relevant_memories(
        db, user_id, query=user_text, k=15, cfg=cfg
    )
    existing_keys = {_normalise(m.content) for m in related}
    valid_ids = {str(m.id) for m in related}
    by_id = {str(m.id): m for m in related}

    if related:
        existing_block = "\n".join(
            f'- id={m.id}: {m.content}' for m in related
        )
    else:
        existing_block = "(none yet)"

    payload = (
        f"EXISTING FACTS:\n{existing_block}\n\n"
        f"LATEST EXCHANGE:\nUser said:\n{user_text}"
    )
    if assistant_text:
        payload += f"\n\nAssistant replied:\n{assistant_text}"

    chunks: list[str] = []
    try:
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=payload)],
            system=_RECONCILE_SYSTEM_PROMPT,
            temperature=0.0,
            max_tokens=_MAX_EXTRACT_TOKENS,
            reasoning_effort="off",
        ):
            chunks.append(token)
    except Exception:  # noqa: BLE001 — capture must never break the turn
        logger.exception("Memory extraction call failed user=%s", user_id)
        return []

    ops = _parse_ops("".join(chunks), valid_ids)
    if not ops:
        return []

    # Separate tracking: updates know their id immediately (the row already
    # exists); new rows get their id after flush().
    saved_updates: list[dict] = []
    new_rows: list[UserMemory] = []
    updated_rows: list[UserMemory] = []
    room = MAX_MEMORIES - total

    for op in ops:
        kind = op["op"]
        if kind == "delete":
            row = by_id.get(op["id"])
            if row is not None:
                await db.delete(row)
            continue
        if kind == "update":
            row = by_id.get(op["id"])
            if row is None:
                continue
            new_text = op["text"]
            if _normalise(new_text) == _normalise(row.content):
                continue  # no real change
            row.content = new_text
            # Update category if the model provided one.
            if op.get("category"):
                row.category = op["category"]
            updated_rows.append(row)
            saved_updates.append({"id": str(row.id), "content": new_text})
            continue
        # add
        if len(new_rows) >= MAX_NEW_PER_TURN or len(new_rows) >= room:
            continue
        fact = op["text"]
        if _is_duplicate(fact, list(existing_keys)):
            continue
        # Semantic safety net: skip a near-identical restatement the
        # substring check would miss ("User is a dev" vs "User works as a
        # software engineer"). Only when embeddings are configured.
        if cfg is not None and (
            await _nearest_similarity(db, user_id, cfg, fact)
            >= SEMANTIC_DUP_THRESHOLD
        ):
            continue
        row = UserMemory(
            user_id=user_id,
            content=fact,
            source="auto",
            source_conversation_id=source_conversation_id,
            category=op.get("category"),
        )
        db.add(row)
        new_rows.append(row)
        existing_keys.add(_normalise(fact))

    if new_rows or updated_rows:
        try:
            await db.flush()
        except Exception:  # noqa: BLE001
            logger.exception("Memory persist flush failed user=%s", user_id)
            return []
        # After flush, new_rows have their DB-assigned ids.
        saved_new = [{"id": str(r.id), "content": r.content} for r in new_rows]
        # (Re-)embed added + updated facts so retrieval stays accurate.
        # Best-effort; ``cfg`` was resolved once above. Never fatal.
        if cfg is not None:
            try:
                for row in (*new_rows, *updated_rows):
                    await embed_memory_row(db, row, cfg)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "memory embed-on-capture failed user=%s", user_id
                )
    else:
        saved_new = []

    return saved_updates + saved_new
