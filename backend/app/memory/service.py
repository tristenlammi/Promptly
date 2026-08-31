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
from datetime import datetime, timezone
from typing import Final

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.defaults import load_effective_defaults
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
    MAX_PINNED_MEMORIES,
    MAX_NEW_PER_TURN,
    MEMORY_CATEGORIES,
    SEMANTIC_DUP_THRESHOLD,
)
from app.memory.models import UserMemory
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, model_router

logger = logging.getLogger("promptly.memory")

_VALID_CATEGORIES: frozenset[str] = frozenset(MEMORY_CATEGORIES)


def resolve_memory_mode(user) -> str:
    """The user's memory mode: ``off`` | ``auto`` | ``manual``.

    ``memory_mode`` supersedes the legacy ``memory_enabled`` boolean;
    accounts predating the three-way setting fall back to it. Lives here
    rather than in the chat router because the memory tools need the same
    answer, and a second copy of the fallback would drift.
    """
    settings = getattr(user, "settings", None) or {}
    mode = settings.get("memory_mode")
    if mode in ("off", "auto", "manual"):
        return mode
    return "off" if settings.get("memory_enabled", True) is False else "auto"


# An explicit ask to save or drop something, as opposed to merely saying
# something durable. This is the line "Self-managed" mode draws, and the
# settings panel states it in writing: "Promptly never captures anything
# on its own."
#
# It exists because prompting alone did not hold. With the tools offered
# and a restraining system-prompt guideline in place, the model still
# wrote two facts from "I've just started learning Portuguese and I
# usually work from a café" — the guideline lost to the tool's own
# description. A promise the UI makes should not depend on the model
# agreeing with it, so this is checked server-side before the write.
_EXPLICIT_MEMORY_REQUEST_RE: Final[re.Pattern[str]] = re.compile(
    r"""
    (
        remember\b
      | memoris[ez]|memoriz[ez]
      | don'?t\s+forget
      | forget\s+(that|what|about|my|the|it)
      | keep\s+(in\s+mind|a\s+note|track\s+of)
      | (make|take)\s+a\s+note
      | note\s+(that|this|down)
      | (save|store|record)\s+(this|that|it|my)
      | add\s+(this|that|it)\s+to\s+(your\s+)?memory
      | (update|change|fix|correct)\s+(your\s+)?memory
      | from\s+now\s+on
      | for\s+(future|next\s+time|reference)
      | stop\s+(calling|saying|assuming|thinking)
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)


def is_explicit_memory_request(text: str | None) -> bool:
    """True when the user asked, in so many words, to change memory.

    Used only in the modes that promise nothing is captured uninvited
    (Self-managed, and a chat with capture paused). Deliberately generous
    about phrasing: a false negative here refuses a save the user did
    want, but the tool reports that back so the model can say so — while
    a false positive silently breaks the promise, which nobody would see.
    """
    return bool(_EXPLICIT_MEMORY_REQUEST_RE.search(text or ""))


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
            provider=cfg.provider,
            model_id=cfg.model_id,
            texts=[cleaned],
            # Matryoshka truncation — models whose native output exceeds the
            # vector(cfg.dim) column (e.g. qwen3-embedding-8b at 4096) must
            # be shortened here or the CAST below rejects every write.
            dimensions=cfg.dim,
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
    try:
        # Savepoint so a bad vector (wrong dims, provider quirk) rolls back
        # only this write and never poisons the caller's transaction —
        # this function is documented best-effort.
        async with db.begin_nested():
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
    except Exception as exc:  # noqa: BLE001
        logger.warning("memory embed write failed id=%s: %s", memory.id, exc)
        return False
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

        # Corrections, negations, and changes of state. The reconciliation
        # pass can already rewrite and delete stale facts, but it only ever
        # ran on turns that looked like assertions — so "I use Vim" was
        # captured and "I don't use Vim any more" was not, and the store
        # accumulated confidently-wrong facts with no way to retract them.
        # These are the backstop for turns where the `remember` / `forget`
        # tools aren't available (Tools toggle off).
      | (i|we)\s+(no\s+longer|don'?t|do\s+not|used\s+to|never)\s
      | not\s+(any\s?more|anymore|any\s+longer)
      | (i|we)'?\s*(ve|m)?\s*(switched|moved|changed|migrated|left|quit|renamed)\b
      | (stop|quit|don'?t)\s+(calling|call|using|use|suggesting|suggest|assuming|assume)
      | (forget|disregard|ignore)\s+(that|what|the|my|about)
      | scratch\s+that
      | that'?s\s+(wrong|no\s+longer|not\s+right|outdated)
      | actually,?\s+(i|we|my|it'?s)
      | correction[:,\s]
      | i\s+was\s+wrong
    )\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Multilingual capture hints (Memory follow-ups). The English pattern
# above carries the fine-grained coverage; this companion covers explicit
# save requests and first-person identity/preference statements in the
# other major languages so non-English users get auto-capture at all.
# Same philosophy: a cheap hint, not a parser — implicit phrasings in
# these languages may still miss, but "remember…" / "my name is…" fire.
# NOTE: no \b anchors — word boundaries don't exist for CJK scripts.
_CAPTURE_HINT_INTL_RE: Final[re.Pattern[str]] = re.compile(
    r"""
    (
        # Spanish
        recu[eé]rda | acu[eé]rdate | no\s+olvides | me\s+llamo
      | soy\s+(un|una)\s | prefiero\s | trabajo\s+(en|como)\s
        # French
      | souviens[- ]toi | rappelle[- ]toi | n'oublie\s+pas
      | je\s+m'appelle | je\s+suis\s+(un|une)\s | je\s+pr[eé]f[eè]re\s
      | je\s+travaille\s
        # German
      | merk\s+dir | vergiss\s+nicht | denk\s+daran | ich\s+hei[ßs]e
      | ich\s+bin\s+(ein|eine)\s | ich\s+bevorzuge\s | ich\s+arbeite\s
        # Portuguese
      | lembre[- ]se | n[aã]o\s+esque[cç]a | me\s+chamo | eu\s+sou\s
      | eu\s+prefiro\s | eu\s+trabalho\s
        # Italian
      | ricordati? | non\s+dimenticare | mi\s+chiamo | io\s+sono\s
      | preferisco\s | lavoro\s+(in|come)\s
        # Dutch
      | onthoud\s | vergeet\s+niet | ik\s+heet\s | ik\s+ben\s+een\s
        # Russian / Ukrainian
      | запомни | не\s+забудь | меня\s+зовут | я\s+работаю | я\s+предпочитаю
      | запам['’]?ятай | мене\s+звати | я\s+працюю
        # Polish
      | zapami[eę]taj | nie\s+zapomnij | mam\s+na\s+imi[eę] | pracuj[eę]\s+jako
        # Turkish
      | hat[iı]rla | unutma | benim\s+ad[iı]m | olarak\s+[cç]al[iı][sş][iı]yorum
        # Arabic
      | تذكر | لا\s+تنس | اسمي | أعمل
        # Hindi
      | याद\s+रख | मेरा\s+नाम | मैं\s+काम
        # Chinese (simplified + traditional)
      | 记住 | 記住 | 别忘 | 別忘 | 我叫 | 我是 | 我喜欢 | 我喜歡 | 我在.{0,6}工作
        # Japanese
      | 覚えて | 忘れないで | 私の名前 | 私は
        # Korean
      | 기억해 | 잊지\s*마 | 제\s*이름은 | 저는
        # Vietnamese
      | nhớ\s+r[aằ]ng | tên\s+tôi\s+là | tôi\s+là\s | tôi\s+thích\s
        # Indonesian / Malay
      | ingatlah\s | jangan\s+lupa | nama\s+saya | saya\s+(suka|bekerja)\s

        # Corrections / negations, mirroring the English additions above.
        # A store that can only learn and never unlearn is worse in every
        # language, and the assertion bias was the same in all of them.
        # Spanish
      | ya\s+no\s | olv[ií]da\s+(que|lo)
        # Portuguese
      | j[aá]\s+n[ãa]o\s | esque[cç]a\s+(que|o)
        # Italian
      | non\s+\S{1,12}\s+pi[uù]\s | dimentica\s+(che|il)
        # French
      | ne\s+\S{1,12}\s+plus\s | oublie\s+(que|ça|ce)
        # German
      | nicht\s+mehr | vergiss\s+(dass|das)
        # Dutch
      | niet\s+meer | vergeet\s+dat
        # Russian / Ukrainian
      | больше\s+не | забудь\s+(что|о) | б[іi]льше\s+не
        # Polish
      | ju[zż]\s+nie | zapomnij\s+[oż]
        # Chinese / Japanese / Korean
      | 不再 | 已经不 | 已經不 | 忘记 | 忘記
      | もう\S{0,4}ない | 忘れて
      | 더\s?이상 | 잊어
        # Vietnamese / Turkish / Arabic / Hindi
      | kh[ôo]ng\s+c[òo]n | qu[êe]n\s
      | art[iı]k\s+\S{1,12}\s+de[gğ]il | unut\s
      | لم\s+أعد | انس\s
      | अब\s+नहीं | भूल\s+जा
    )
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
    return bool(
        _CAPTURE_HINT_RE.search(user_text)
        or _CAPTURE_HINT_INTL_RE.search(user_text)
    )


# Credential shapes that must never reach durable storage. Memory rows
# outlive the conversation and are replayed into every relevant future
# turn, so a secret saved once is a secret re-injected indefinitely — and
# since the model can now write memory directly *and* read fetched pages
# in the same turn, "don't save secrets" being prompt-only was the
# weakest link in that chain.
#
# Deliberately limited to unambiguous token *shapes*. Phrase matching
# ("password is …") is where the false positives live — it would refuse
# to remember "User keeps their passwords in 1Password", which is an
# ordinary durable fact — and a screen that fires on innocent text gets
# loosened until it catches nothing.
_SECRET_SHAPE_RE: Final[re.Pattern[str]] = re.compile(
    r"""
    (
        sk-[A-Za-z0-9_-]{16,}                  # OpenAI-style keys
      | sk_(live|test)_[A-Za-z0-9]{16,}        # Stripe
      | gh[pousr]_[A-Za-z0-9]{20,}             # GitHub tokens
      | github_pat_[A-Za-z0-9_]{20,}
      | xox[baprs]-[A-Za-z0-9-]{10,}           # Slack
      | AKIA[0-9A-Z]{16}                       # AWS access key id
      | AIza[0-9A-Za-z_-]{20,}                 # Google API key
      | ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}  # JWT
      | -----BEGIN[A-Z ]*PRIVATE\ KEY-----     # PEM private key
      | \b\d{3}-\d{2}-\d{4}\b                  # US SSN
      | \b(?:\d[\ -]?){13,19}\b                # card-length digit run
    )
    """,
    re.VERBOSE,
)


def looks_sensitive(text: str) -> bool:
    """True when ``text`` contains something that looks like a credential.

    Used by both write paths — the post-turn extraction pass and the
    ``remember`` tool — as a last line of defence behind the prompt-level
    instruction. It only recognises token shapes, so it will not catch a
    password spelled out in prose; that is a deliberate trade, not an
    oversight (see the pattern's comment).
    """
    return bool(_SECRET_SHAPE_RE.search(text or ""))


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


def build_memory_prompt(
    memories: list[UserMemory],
    *,
    total: int | None = None,
    can_recall: bool = False,
) -> str | None:
    """Render saved facts into a system-prompt block, or ``None`` when the
    user has no memories. Phrased as background knowledge with an explicit
    "don't recite it" instruction, matching the personal-context block.

    Each fact carries *how* it was learned as well as when. The store has
    always known whether a fact was stated by the user or inferred from
    conversation, and the prompt threw that away — so an inference the
    model made last month arrived with exactly the same authority as
    something the user typed, and nothing broke the tie when they
    disagreed.

    ``total`` and ``can_recall`` tell the model this is a *selection*, not
    the whole store, and that it can go and look. Without them a model
    holding ten of two hundred facts answers "what do you know about me?"
    confidently and incompletely, with no idea anything is missing.
    """
    kept = [m for m in memories if m.content and m.content.strip()]
    if not kept:
        return None

    header = (
        "Saved memory about the user (durable facts from past "
        "conversations — treat as background you already know)."
    )
    if total is not None and total > len(kept):
        header += (
            f" These are the {len(kept)} most relevant of {total} saved "
            "facts, not the whole store"
        )
        header += (
            "; call `recall` if you need something that isn't here."
            if can_recall
            else ", so don't imply this is everything you know."
        )
    lines = [
        header,
        "",
        "Each line notes when it was learned, and whether the user stated "
        'it outright ("stated") or it was picked up from conversation '
        '("inferred"). Prefer newer facts over older ones if they '
        "conflict, and stated over inferred — an inference can be wrong in "
        "ways the user never had a chance to correct.",
        "",
    ]
    for m in kept:
        learned = m.updated_at or m.created_at
        origin = "stated" if m.source == "manual" else "inferred"
        stamp = (
            f" ({origin}, {learned.strftime('%b %Y')})"
            if learned
            else f" ({origin})"
        )
        lines.append(f"- {m.content.strip()}{stamp}")
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
    """Pinned facts for a user, newest first, capped.

    These are always injected regardless of the top-K retrieval cap — the
    user's explicit "must-know" facts. Uses the partial index on
    ``(user_id) WHERE pinned = true`` added in migration 0061.

    The cap is a backstop, not the primary guard: the API refuses to pin
    past ``MAX_PINNED_MEMORIES``, but accounts that pinned freely before
    that limit existed would otherwise keep injecting an unbounded block
    forever.

    It caps the *unconditional* half only. A fact pinned beyond the cap
    isn't hidden — it stops riding free and competes for the retrieval
    slots like any other fact, which is why the excluded set below is the
    loaded pins rather than every pinned row. Making over-cap pins
    unreachable would bury facts the user cared enough to pin.
    """
    rows = (
        (
            await db.execute(
                select(UserMemory)
                .where(UserMemory.user_id == user_id, UserMemory.pinned.is_(True))
                .order_by(UserMemory.created_at.desc())
                .limit(MAX_PINNED_MEMORIES)
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
    strict: bool = False,
) -> list[UserMemory]:
    """Return up to ``k`` memories most relevant to ``query`` by cosine
    similarity, falling back to most-recent-first when embeddings aren't
    configured, the query is empty, the lookup fails, or nothing is
    embedded yet. Best-effort — retrieval must never break a chat turn.

    ``exclude_ids`` — skip these memory ids (used to avoid re-including
    pinned facts that are already being added separately).

    ``strict`` — return ``[]`` instead of falling back to recency. Right
    for background injection, wrong for a *search*: a caller that asked
    "what do they drive?" and silently received the three most recent
    facts has been handed an answer to a question nobody asked, with
    nothing marking it as unrelated. The failure is easy to hit — an
    embedder that is configured but unreachable takes this path on every
    call — so the distinction is a parameter rather than a comment.
    """
    cleaned = normalise_for_embedding(query or "")
    if cfg is None:
        cfg = await get_embedding_config(db)

    _excl = exclude_ids or set()

    def _fallback(rows: list[UserMemory]) -> list[UserMemory]:
        if strict:
            return []
        return [m for m in rows if m.id not in _excl][:k]

    if cfg is None or not cleaned:
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return _fallback(rows)

    try:
        vectors = await embed_texts(
            provider=cfg.provider,
            model_id=cfg.model_id,
            texts=[cleaned],
            # Pass matryoshka truncation so providers like qwen3-embedding-8b
            # return cfg.dim dimensions instead of their native 4096, which
            # would be rejected by the vector(cfg.dim) column.
            dimensions=cfg.dim,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("memory retrieval embed failed user=%s: %s", user_id, exc)
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return _fallback(rows)
    if not vectors:
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return _fallback(rows)

    col = f"embedding_{cfg.dim}"
    # Over-fetch so the usage-aware re-rank below has candidates to promote
    # and excluded ids don't starve the result.
    fetch_k = max(k * 2, k + len(_excl) + 5)
    sql = text(
        f"""
        SELECT id,
               {col} <=> CAST(:qvec AS vector({cfg.dim})) AS dist,
               times_used,
               last_used_at
        FROM user_memories
        WHERE user_id = :uid AND {col} IS NOT NULL
        ORDER BY dist
        LIMIT :k
        """
    )
    try:
        # Use a savepoint so a dimension mismatch (or any other pgvector
        # error) only rolls back this nested block and not the entire session
        # transaction.  Without it, asyncpg marks the outer transaction as
        # aborted, causing the load_memories fallback to also fail with
        # InFailedSQLTransactionError — crashing the whole chat stream.
        async with db.begin_nested():
            rows_raw = (
                await db.execute(
                    sql,
                    {"uid": user_id, "qvec": vector_literal(vectors[0]), "k": fetch_k},
                )
            ).all()
    except Exception as exc:  # noqa: BLE001
        logger.warning("memory retrieval query failed user=%s: %s", user_id, exc)
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return _fallback(rows)

    # Usage-aware re-rank (Dynamics batch): cosine relevance dominates, but
    # facts that keep proving useful get a small, bounded boost — enough to
    # win near-ties, never enough to beat a genuinely on-topic fact.
    now = datetime.now(timezone.utc)

    def _rank(row) -> float:
        _rid, dist, times_used, last_used_at = row
        score = 1.0 - float(dist)
        score += 0.004 * min(int(times_used or 0), 20)  # ≤ +0.08 lifetime
        if last_used_at is not None:
            if last_used_at.tzinfo is None:
                last_used_at = last_used_at.replace(tzinfo=timezone.utc)
            if (now - last_used_at).days <= 14:
                score += 0.03  # recently useful
        return score

    candidates = [r for r in rows_raw if r[0] not in _excl]
    candidates.sort(key=_rank, reverse=True)
    ids = [r[0] for r in candidates][:k]
    if not ids:
        rows = await load_memories(db, user_id, limit=k + len(_excl))
        return _fallback(rows)

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
    can_recall: bool = False,
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
    # Pinned facts used to consume the whole budget: ten pins drove
    # ``remaining_k`` to zero, so semantic retrieval never ran and the
    # block was whatever happened to be pinned, on every turn, whatever
    # the user asked. Reserve half the slots for relevance so pinning
    # adds to the block instead of replacing it.
    remaining_k = max(k // 2, k - len(pinned))

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

    # The count is what lets the block admit it's a selection. One
    # indexed COUNT, and only when something was actually injected.
    total = await count_memories(db, user_id) if all_memories else 0
    return (
        build_memory_prompt(all_memories, total=total, can_recall=can_recall),
        all_memories,
    )


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
            # Anything that looks like a credential is dropped whatever the
            # model's confidence — the extraction prompt already asks it not
            # to capture secrets, and this is the part that doesn't depend
            # on the model having listened.
            if txt and confidence == "high" and not looks_sensitive(txt):
                ops.append({"op": "add", "text": txt[:MAX_CONTENT_CHARS], "category": category})
        elif op == "update":
            mid = str(item.get("id") or "")
            txt = (item.get("text") or "").strip()
            if mid in valid_ids and txt and not looks_sensitive(txt):
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
            provider=cfg.provider,
            model_id=cfg.model_id,
            texts=[cleaned],
            dimensions=cfg.dim,
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


async def _evict_for_capture(
    db: AsyncSession, user_id, *, protect_ids: list | None = None
) -> bool:
    """Free one slot at the per-user fact cap by deleting the least
    valuable *auto-captured* fact: fewest injections first, then longest
    idle (never-used rows fall back to creation age). Pinned and manual
    facts are never evicted — the cap only recycles what the model
    captured on its own, so user-stated facts are safe. Returns ``True``
    when a row was deleted.

    ``protect_ids`` — rows added or updated earlier in this same capture
    pass; without it, a brand-new fact (times_used=0) could be evicted to
    make room for the next one.
    """
    stmt = select(UserMemory).where(
        UserMemory.user_id == user_id,
        UserMemory.source == "auto",
        UserMemory.pinned.is_(False),
    )
    if protect_ids:
        stmt = stmt.where(UserMemory.id.not_in(protect_ids))
    # Least recently useful first, and only then least used. Leading with
    # ``times_used`` made eviction self-reinforcing: the counter increments
    # on *injection*, injection is what the retrieval boost rewards, so a
    # fact that kept being injected kept being protected whether or not it
    # ever helped — while a genuinely on-point fact that only fires for a
    # rare topic looked like the cheapest thing to throw away.
    stmt = stmt.order_by(
        func.coalesce(UserMemory.last_used_at, UserMemory.created_at).asc(),
        UserMemory.times_used.asc(),
    ).limit(1)
    row = (await db.execute(stmt)).scalars().first()
    if row is None:
        return False
    logger.info(
        "memory cap: evicting auto fact id=%s uses=%d user=%s",
        row.id,
        row.times_used,
        user_id,
    )
    await db.delete(row)
    return True


async def resolve_memory_model(
    db: AsyncSession,
    *,
    fallback_provider: ModelProvider | None = None,
    fallback_model_id: str | None = None,
    user_id=None,
) -> tuple[ModelProvider, str] | None:
    """The model that runs memory extraction / consolidation / editing.

    1. The dedicated memory model (admin-configured — ideally a fast/cheap
       one, since these are small strict-JSON extraction jobs).
    2. The caller-supplied fallback (capture passes the conversation's
       model — the historical behaviour).
    3. The instance default chat model.
    4. The model this user last chatted with.

    Step 4 exists because steps 1–3 all depend on an admin having set a
    default, and a single-user self-hosted install often hasn't: the user
    picks a model per chat and never visits Admin → Defaults. Capture
    still worked for them (it passes the conversation's model at step 2),
    so the gap only showed up on the surfaces with no conversation to
    inherit from — Tidy up, and editing memory from settings — which
    failed with a message pointing at an admin page they may not even be
    able to reach.

    Returns ``None`` when nothing resolves — callers skip the pass.
    """
    settings = await load_effective_defaults(db)
    if settings.memory_configured:
        provider = await db.get(ModelProvider, settings.memory_provider_id)
        if provider is not None and provider.enabled:
            return provider, settings.memory_model_id
    if fallback_provider is not None and fallback_model_id:
        return fallback_provider, fallback_model_id
    if settings.default_chat_configured:
        provider = await db.get(ModelProvider, settings.default_chat_provider_id)
        if provider is not None and provider.enabled:
            return provider, settings.default_chat_model_id
    if user_id is not None:
        from app.chat.models import Conversation

        row = (
            await db.execute(
                select(Conversation.provider_id, Conversation.model_id)
                .where(
                    Conversation.user_id == user_id,
                    Conversation.provider_id.is_not(None),
                    Conversation.model_id.is_not(None),
                )
                .order_by(Conversation.updated_at.desc())
                .limit(1)
            )
        ).first()
        if row is not None:
            provider = await db.get(ModelProvider, row.provider_id)
            if provider is not None and provider.enabled:
                return provider, row.model_id
    return None


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

    # Prefer the dedicated memory model when the admin has set one —
    # predictable cost and JSON-op quality regardless of what the
    # conversation runs on. Falls back to the conversation's model.
    resolved = await resolve_memory_model(
        db, fallback_provider=provider, fallback_model_id=model_id
    )
    if resolved is None:
        return []
    provider, model_id = resolved

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
        if len(new_rows) >= MAX_NEW_PER_TURN:
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
        # At the fact cap, evict the least-valuable auto fact instead of
        # dropping the new one — memory keeps renewing rather than freezing
        # at its oldest facts. Runs after the dup checks so a skipped
        # candidate never costs an eviction. Skips the add when nothing is
        # evictable (all pinned/manual).
        if total + len(new_rows) >= MAX_MEMORIES:
            if new_rows:
                await db.flush()  # assign ids so eviction can protect them
            protect = [
                r.id for r in (*new_rows, *updated_rows) if r.id is not None
            ]
            if not await _evict_for_capture(db, user_id, protect_ids=protect):
                continue
            total -= 1
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


# ----------------------------------------------------------------------
# Consolidation (Memory follow-ups)
# ----------------------------------------------------------------------
# User-triggered tidy-up pass: one model call sees the whole store and
# proposes merge groups; we apply them conservatively (merge-only — the
# model can never delete or invent facts through this path).

_MAX_MERGE_OPS: Final[int] = 20
_MAX_CONSOLIDATE_TOKENS: Final[int] = 1200

_CONSOLIDATE_SYSTEM_PROMPT: Final[str] = (
    "You tidy a user's long-term memory store for an AI assistant. You are "
    "given every saved fact, each with an id. Find groups of facts that "
    "state the same or overlapping information — restatements, stale "
    "versions of the same fact, fragments that clearly belong together — "
    "and merge each group into ONE clear fact.\n\n"
    "Output ONLY a JSON array of merge operations:\n"
    '  {"op": "merge", "ids": ["<id>", "<id>", ...], "text": "<the single '
    'combined fact>", "category": "<cat>"}\n\n'
    f"Categories (exactly one per merge): {_CATEGORY_LIST}\n\n"
    "Rules:\n"
    "- Only merge facts that genuinely overlap or supersede each other. "
    "Facts that are merely about the same topic stay separate.\n"
    "- The combined text may ONLY contain information present in the "
    "merged facts — never add, infer, or embellish anything.\n"
    "- When two facts conflict, keep the newer information (facts are "
    "listed oldest first).\n"
    "- Write the combined fact as one concise third-person statement "
    "starting with 'User '.\n"
    "- Each id may appear in at most one operation, and every id must come "
    "from the list. If nothing should merge, output []."
)


def _parse_merge_ops(raw: str, valid_ids: set[str]) -> list[dict]:
    """Parse the consolidation model's JSON array. Each op needs ≥2 known
    ids (no id reused across ops) and non-empty text; anything else is
    dropped rather than guessed at."""
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
    used: set[str] = set()
    for item in parsed:
        if not isinstance(item, dict) or item.get("op") != "merge":
            continue
        raw_ids = item.get("ids")
        if not isinstance(raw_ids, list):
            continue
        ids = [str(i) for i in raw_ids if str(i) in valid_ids]
        ids = [i for i in dict.fromkeys(ids) if i not in used]  # dedupe, no reuse
        txt = (item.get("text") or "").strip()
        if len(ids) < 2 or not txt:
            continue
        raw_cat = (item.get("category") or "").strip().lower()
        ops.append(
            {
                "ids": ids,
                "text": txt[:MAX_CONTENT_CHARS],
                "category": raw_cat if raw_cat in _VALID_CATEGORIES else None,
            }
        )
        used.update(ids)
        if len(ops) >= _MAX_MERGE_OPS:
            break
    return ops


async def consolidate_memories(db: AsyncSession, *, user_id) -> dict:
    """Merge near-duplicate facts across the user's whole store.

    Returns ``{"merged_groups": int, "removed": int, "changes": [...]}``
    where each change is ``{"kept_id", "text", "merged": [old texts]}``.
    Merge-only by design: for each group the most valuable row survives
    (pinned > most-used > oldest), takes the combined text, inherits any
    pin, and is re-embedded; the rest are deleted. Raises ``ValueError``
    when no model is resolvable; other failures propagate to the caller
    (this is a user-triggered action — errors should be visible).
    Flushes but does not commit.
    """
    rows = await load_memories(db, user_id)
    if len(rows) < 2:
        return {"merged_groups": 0, "removed": 0, "changes": []}

    resolved = await resolve_memory_model(db, user_id=user_id)
    if resolved is None:
        raise ValueError(
            "No model available — set a Memory model (or a default chat "
            "model) under Admin → Defaults first."
        )
    provider, model_id = resolved

    # tz-aware sentinel — created_at is always set in practice, but a naive
    # datetime.min would TypeError against the tz-aware column values.
    _epoch = datetime.min.replace(tzinfo=timezone.utc)
    ordered = sorted(rows, key=lambda m: m.created_at or _epoch)
    listing = "\n".join(
        f"- id={m.id} [{m.category or 'other'}{', pinned' if m.pinned else ''}]: "
        f"{m.content}"
        for m in ordered
    )
    chunks: list[str] = []
    async for token in model_router.stream_chat(
        provider=provider,
        model_id=model_id,
        messages=[
            ChatMessage(
                role="user", content=f"SAVED FACTS ({len(ordered)}):\n{listing}"
            )
        ],
        system=_CONSOLIDATE_SYSTEM_PROMPT,
        temperature=0.0,
        max_tokens=_MAX_CONSOLIDATE_TOKENS,
        reasoning_effort="off",
    ):
        chunks.append(token)

    by_id = {str(m.id): m for m in rows}
    ops = _parse_merge_ops("".join(chunks), set(by_id))
    if not ops:
        return {"merged_groups": 0, "removed": 0, "changes": []}

    cfg = await get_embedding_config(db)
    changes: list[dict] = []
    kept_rows: list[UserMemory] = []
    removed = 0
    for op in ops:
        group = [by_id[i] for i in op["ids"]]
        # Survivor: a pinned row if any, else the most-used, else the oldest
        # (stable provenance — its id and source conversation live on).
        keep = sorted(
            group,
            key=lambda m: (not m.pinned, -m.times_used, m.created_at or _epoch),
        )[0]
        merged_texts = [m.content for m in group]
        keep.content = op["text"]
        if op["category"]:
            keep.category = op["category"]
        keep.pinned = keep.pinned or any(m.pinned for m in group)
        keep.times_used = max(m.times_used for m in group)
        for m in group:
            if m.id != keep.id:
                await db.delete(m)
                removed += 1
        kept_rows.append(keep)
        changes.append(
            {"kept_id": str(keep.id), "text": keep.content, "merged": merged_texts}
        )

    await db.flush()
    if cfg is not None:
        for row in kept_rows:
            await embed_memory_row(db, row, cfg)  # best-effort

    logger.info(
        "memory consolidation user=%s: %d group(s) merged, %d row(s) removed",
        user_id,
        len(changes),
        removed,
    )
    return {"merged_groups": len(changes), "removed": removed, "changes": changes}


# ----------------------------------------------------------------------
# Editing memory by describing the change
# ----------------------------------------------------------------------
#
# The management panel could already add, edit and delete facts one row at
# a time — fine for a typo, tedious for "drop everything about my old job"
# across a store of two hundred. This brings the capability the chat tools
# gained to the place users actually go to tidy their memory, and reuses
# their machinery: the model proposes ops and ``_parse_ops`` validates
# them (ids must be the caller's own, credential shapes are refused)
# before anything is written.
#
# Deliberately propose-then-approve rather than apply-on-send. An
# instruction like "forget the stuff about work" is genuinely ambiguous
# about scope, and this is the one surface where a user bulk-edits durable
# state — the same reasoning behind the workspace write-back proposals.
# Preview costs one model call; applying costs none.

_MAX_INSTRUCT_TOKENS: Final[int] = 1200

_INSTRUCT_SYSTEM_PROMPT: Final[str] = (
    "You edit a user's saved long-term memory on their explicit "
    "instruction. You are given every fact they have saved (each with an "
    "id) and one instruction from them. Output ONLY a JSON array of "
    "operation objects.\n\n"
    "Operations:\n"
    '  {"op": "add", "text": "<new fact>", "category": "<cat>", '
    '"confidence": "high"}\n'
    '  {"op": "update", "id": "<existing id>", "text": "<rewritten fact>", '
    '"category": "<cat>"}\n'
    '  {"op": "delete", "id": "<existing id>"}\n\n'
    'Always set confidence to "high" on adds. The user asked for this '
    "change directly, so there is nothing to be tentative about.\n"
    f"Categories (use exactly one per add/update): {_CATEGORY_LIST}\n\n"
    "Make the SMALLEST set of changes that satisfies the instruction. Do "
    "not rewrite facts it doesn't touch, do not invent facts it doesn't "
    "imply, and do not tidy up in passing. Only use ids that appear in "
    "the list. Write each fact as one concise third-person statement "
    "starting with 'User '. If the instruction doesn't apply to anything "
    "saved, output []."
)


async def plan_memory_edits(
    db: AsyncSession, *, user_id, instruction: str
) -> list[dict]:
    """Ask the memory model what ``instruction`` should change.

    Returns enriched ops — each carrying the *current* text for updates
    and deletes — so the caller can render a before/after preview. Nothing
    is written. Raises ``ValueError`` when the instruction is empty or no
    model is resolvable; this is user-triggered, so errors should be
    visible rather than swallowed.
    """
    text = (instruction or "").strip()
    if not text:
        raise ValueError("Say what you'd like changed.")

    rows = await load_memories(db, user_id)
    if not rows:
        return []

    resolved = await resolve_memory_model(db, user_id=user_id)
    if resolved is None:
        raise ValueError(
            "No model available — set a Memory model (or a default chat "
            "model) under Admin → Defaults first."
        )
    provider, model_id = resolved

    listing = "\n".join(
        f"- id={m.id} [{m.category or 'other'}"
        f"{', pinned' if m.pinned else ''}]: {m.content}"
        for m in rows
    )
    chunks: list[str] = []
    async for token in model_router.stream_chat(
        provider=provider,
        model_id=model_id,
        messages=[
            ChatMessage(
                role="user",
                content=(
                    f"SAVED FACTS ({len(rows)}):\n{listing}\n\n"
                    f"INSTRUCTION FROM THE USER:\n{text}"
                ),
            )
        ],
        system=_INSTRUCT_SYSTEM_PROMPT,
        temperature=0.0,
        max_tokens=_MAX_INSTRUCT_TOKENS,
        reasoning_effort="off",
    ):
        chunks.append(token)

    by_id = {str(m.id): m for m in rows}
    ops = _parse_ops("".join(chunks), set(by_id))

    enriched: list[dict] = []
    for op in ops:
        if op["op"] == "add":
            enriched.append(
                {"op": "add", "after": op["text"], "category": op["category"]}
            )
            continue
        current = by_id.get(op["id"])
        if current is None:  # pragma: no cover — _parse_ops already filters
            continue
        if op["op"] == "update":
            # A no-op rewrite is noise in the preview: it reads as a change
            # the user then has to check, and there's nothing to check.
            if current.content.strip() == op["text"].strip():
                continue
            enriched.append(
                {
                    "op": "update",
                    "id": op["id"],
                    "before": current.content,
                    "after": op["text"],
                    "category": op["category"],
                }
            )
        elif op["op"] == "delete":
            enriched.append(
                {"op": "delete", "id": op["id"], "before": current.content}
            )
    return enriched


async def apply_memory_edits(
    db: AsyncSession, *, user_id, ops: list[dict]
) -> dict:
    """Apply ops returned by :func:`plan_memory_edits`.

    Every id is re-checked against this user's own rows rather than
    trusted from the request — the plan travelled through the client, so
    treating it as authoritative would let a crafted payload edit someone
    else's memory. Text is re-screened for credential shapes for the same
    reason. Flushes but does not commit.
    """
    rows = await load_memories(db, user_id)
    by_id = {str(m.id): m for m in rows}
    added = updated = deleted = 0

    for op in ops:
        kind = op.get("op")
        if kind == "add":
            content = (op.get("after") or "").strip()[:MAX_CONTENT_CHARS]
            if not content or looks_sensitive(content):
                continue
            if _is_duplicate(content, [_normalise(m.content) for m in rows]):
                continue
            if len(rows) + added - deleted >= MAX_MEMORIES:
                continue
            category = op.get("category")
            row = UserMemory(
                user_id=user_id,
                content=content,
                # The user asked for this one by name, so it's theirs —
                # which also keeps it out of the cap-eviction pool.
                source="manual",
                category=category if category in MEMORY_CATEGORIES else None,
            )
            db.add(row)
            await db.flush()
            await embed_memory_row(db, row)
            added += 1
        elif kind == "update":
            row = by_id.get(str(op.get("id") or ""))
            content = (op.get("after") or "").strip()[:MAX_CONTENT_CHARS]
            if row is None or not content or looks_sensitive(content):
                continue
            row.content = content
            category = op.get("category")
            if category in MEMORY_CATEGORIES:
                row.category = category
            await db.flush()
            await embed_memory_row(db, row)
            updated += 1
        elif kind == "delete":
            row = by_id.get(str(op.get("id") or ""))
            if row is None:
                continue
            await db.delete(row)
            deleted += 1

    if added or updated or deleted:
        logger.info(
            "memory instruct: +%d ~%d -%d for user=%s",
            added,
            updated,
            deleted,
            user_id,
        )
    return {"added": added, "updated": updated, "deleted": deleted}
