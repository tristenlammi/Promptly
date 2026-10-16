"""Top-K similarity retrieval over the knowledge_chunks table.

Called by the chat router right before dispatching a message that
targets a Custom Model. Embeds the user's latest turn, runs a
cosine-similarity search against pgvector, and returns a formatted
"Knowledge" block ready to splice into the system prompt.

We use raw SQL for the vector query instead of going through the
ORM because:

* SQLAlchemy 2.x doesn't ship a ``vector`` type and we deliberately
  haven't added the ``pgvector`` Python package (avoids registering
  a codec on every asyncpg connection).
* The query is one-line — clarity wins over abstraction here.
"""
from __future__ import annotations

import logging
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from contextvars import ContextVar

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.custom_models.embedding import (
    SUPPORTED_DIMS,
    embed_texts,
    normalise_for_embedding,
    vector_literal,
)
from app.custom_models.models import CustomModel
from app.models_config.models import ModelProvider

logger = logging.getLogger(__name__)

# Recent query embeddings, keyed by (provider, model, dim, text). Cmd-K
# global search runs the same query against up to 20 workspaces, and a chat
# turn retrieves from several scopes — each used to embed it again, serially
# (R-186). Small, short-lived, in-process (single worker).
_QUERY_VECTOR_CACHE: OrderedDict[tuple, tuple[float, str]] = OrderedDict()
_QUERY_VECTOR_CACHE_MAX = 256
_QUERY_VECTOR_TTL_S = 600.0


def _cached_vector(key: tuple) -> str | None:
    hit = _QUERY_VECTOR_CACHE.get(key)
    if hit is None:
        return None
    stamp, literal = hit
    if time.monotonic() - stamp > _QUERY_VECTOR_TTL_S:
        _QUERY_VECTOR_CACHE.pop(key, None)
        return None
    _QUERY_VECTOR_CACHE.move_to_end(key)
    return literal


def _remember_vector(key: tuple, literal: str) -> None:
    _QUERY_VECTOR_CACHE[key] = (time.monotonic(), literal)
    _QUERY_VECTOR_CACHE.move_to_end(key)
    while len(_QUERY_VECTOR_CACHE) > _QUERY_VECTOR_CACHE_MAX:
        _QUERY_VECTOR_CACHE.popitem(last=False)


@dataclass(frozen=True)
class RetrievedChunk:
    """Single hit from the vector search, plus the file it came from."""

    chunk_id: uuid.UUID
    user_file_id: uuid.UUID
    text: str
    score: float
    chunk_metadata: dict[str, object]
    filename: str | None


# What the vector arm did on this task's last retrieval: "off" (no embedder
# set up), "unavailable" (set up but it failed / is skipped / disabled) or
# "ok". Ask and search report it so an outage stops looking like "no
# results" (R-322).
_vector_status: ContextVar[str] = ContextVar("vector_status", default="off")


def vector_status() -> str:
    return _vector_status.get()


async def _resolve_query_vector(
    db: AsyncSession, query: str
) -> tuple[str, int, str] | None:
    out = await _resolve_query_vector_inner(db, query)
    if out is not None:
        _vector_status.set("ok")
    return out


async def _resolve_query_vector_inner(
    db: AsyncSession, query: str
) -> tuple[str, int, str] | None:
    """Embed ``query`` against the workspace config, returning
    ``(pgvector_literal, dim)`` — or ``None`` (never raises) when
    embeddings aren't configured / the dim is unindexed / the provider
    is gone / the embed call fails. Shared by every scope's retrieval."""
    settings: AppSettings | None = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if (
        settings is None
        or settings.embedding_provider_id is None
        or settings.embedding_model_id is None
        or settings.embedding_dim is None
    ):
        logger.debug("retrieval: no embedding provider configured")
        _vector_status.set("off")
        return None
    _vector_status.set("unavailable")

    dim = int(settings.embedding_dim)
    if dim not in SUPPORTED_DIMS:
        logger.warning(
            "retrieval: configured embedding_dim=%d is not one of the indexed "
            "columns %s",
            dim,
            sorted(SUPPORTED_DIMS),
        )
        return None

    provider: ModelProvider | None = await db.get(
        ModelProvider, settings.embedding_provider_id
    )
    if provider is None:
        logger.warning("retrieval: configured embedding provider gone")
        return None

    normalised = normalise_for_embedding(query)
    key = (provider.id, settings.embedding_model_id, dim, normalised)
    cached = _cached_vector(key)
    if cached is not None:
        return cached, dim, settings.embedding_model_id
    try:
        vectors = await embed_texts(
            fast=True,
            provider=provider,
            model_id=settings.embedding_model_id,
            texts=[normalised],
            dimensions=dim,
        )
    except Exception as exc:  # noqa: BLE001 - best-effort retrieval
        logger.warning("retrieval: embed call failed: %s", exc)
        return None
    if not vectors:
        return None
    literal = vector_literal(vectors[0])
    _remember_vector(key, literal)
    return literal, dim, settings.embedding_model_id


async def _similarity_search(
    db: AsyncSession,
    *,
    scope_col: str,
    scope_id: uuid.UUID,
    qvec_literal: str,
    dim: int,
    k: int,
    file_ids: list[uuid.UUID] | None = None,
    model: str | None = None,
    scope_where: str | None = None,
    scope_params: dict[str, object] | None = None,
) -> list[RetrievedChunk]:
    """Top-K cosine search within one owner scope. ``scope_col`` is the
    knowledge_chunks owner column (``custom_model_id`` / ``workspace_id``).

    ``file_ids`` optionally narrows the search to a specific set of source
    files within the scope — used to give a workspace's authored items
    (notes/boards) a guaranteed retrieval slice that a large pinned file
    can't crowd out. Empty/None searches the whole scope."""
    column = f"embedding_{dim}"
    # Optional per-file narrowing. Mirrors the ``= ANY(:param)`` uuid-array
    # binding used elsewhere (chat.semantic_search) — asyncpg binds a
    # ``list[uuid.UUID]`` straight to a uuid[] array, no cast needed.
    file_filter = "AND kc.user_file_id = ANY(:fids)" if file_ids else ""
    # Only vectors from the current embedding model: after a same-dimension
    # switch, comparing two models' vectors returns confident nonsense
    # (R-317). Stale chunks drop out until they're re-embedded.
    model_filter = "AND kc.embedding_model = :em" if model else ""
    scope_clause = scope_where or f"kc.{scope_col} = :sid"
    # ``<=>`` is pgvector's cosine distance operator (smaller = more
    # similar). We return ``1 - distance`` as the human "score" so the
    # frontend can display percentages without knowing pgvector's
    # operator semantics.
    sql = text(
        f"""
        SELECT
            kc.id              AS id,
            kc.user_file_id    AS user_file_id,
            kc.text            AS text,
            kc.metadata        AS chunk_metadata,
            (1 - (kc.{column} <=> CAST(:qvec AS vector({dim})))) AS score,
            f.original_filename AS filename
        FROM knowledge_chunks AS kc
        JOIN files AS f ON f.id = kc.user_file_id
        WHERE {scope_clause}
          AND kc.{column} IS NOT NULL
          -- Never retrieve chunks whose source file has been trashed/deleted:
          -- deleting a workspace item only *trashes* its backing file, so its
          -- chunks linger. Without this, a deleted board/note/sheet keeps
          -- feeding stale content into every answer.
          AND f.trashed_at IS NULL
          {file_filter}
          {model_filter}
        ORDER BY kc.{column} <=> CAST(:qvec AS vector({dim}))
        LIMIT :k
        """
    )
    params: dict[str, object] = {
        "qvec": qvec_literal,
        "k": max(1, k),
        **(scope_params or {"sid": str(scope_id)}),
    }
    if file_ids:
        params["fids"] = file_ids
    if model:
        params["em"] = model
    # pgvector 0.8: keep scanning the HNSW graph until the post-filters
    # (scope, trashed files, model) leave k rows, instead of returning too
    # few for a busy instance's small scopes (R-335).
    try:
        async with db.begin_nested():
            await db.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
            await db.execute(text("SET LOCAL hnsw.ef_search = 100"))
    except Exception:  # noqa: BLE001 — older pgvector: the plain query still works
        pass
    result = await db.execute(sql, params)
    return [
        RetrievedChunk(
            chunk_id=row["id"],
            user_file_id=row["user_file_id"],
            text=row["text"],
            score=float(row["score"]) if row["score"] is not None else 0.0,
            chunk_metadata=dict(row["chunk_metadata"] or {}),
            filename=row["filename"],
        )
        for row in result.mappings().all()
    ]


async def _keyword_search(
    db: AsyncSession,
    *,
    scope_col: str,
    scope_id: uuid.UUID,
    query: str,
    k: int,
    file_ids: list[uuid.UUID] | None = None,
    scope_where: str | None = None,
    scope_params: dict[str, object] | None = None,
) -> list[RetrievedChunk]:
    """Postgres full-text keyword search over chunk text (+ source filename)
    within one owner scope — the keyword arm of hybrid retrieval. It catches
    exact names / IDs / rare tokens that dense vectors blur together, and
    needs no embedder.

    ``websearch_to_tsquery`` accepts the quote-phrase / ``-exclude`` / ``OR``
    syntax users know from Google and never raises on malformed input (an
    empty or all-stopword query simply matches nothing). Best-effort: any
    failure degrades to ``[]`` so a chat send never crashes on the keyword
    arm."""
    query = (query or "").strip()
    if not query:
        return []
    file_filter = "AND kc.user_file_id = ANY(:fids)" if file_ids else ""
    scope_clause = scope_where or f"kc.{scope_col} = :sid"
    # Fold the source filename into the searchable text so "the Q3 Budget
    # PDF" matches by name even when the filename isn't in the chunk body.
    tsv = (
        "to_tsvector('english', "
        "coalesce(f.original_filename, '') || ' ' || kc.text)"
    )
    sql = text(
        f"""
        SELECT
            kc.id              AS id,
            kc.user_file_id    AS user_file_id,
            kc.text            AS text,
            kc.metadata        AS chunk_metadata,
            ts_rank({tsv}, websearch_to_tsquery('english', :q)) AS score,
            f.original_filename AS filename
        FROM knowledge_chunks AS kc
        JOIN files AS f ON f.id = kc.user_file_id
        WHERE {scope_clause}
          AND f.trashed_at IS NULL
          AND {tsv} @@ websearch_to_tsquery('english', :q)
          {file_filter}
        ORDER BY score DESC
        LIMIT :k
        """
    )
    params: dict[str, object] = {"q": query, "k": max(1, k), **(scope_params or {"sid": str(scope_id)})}
    if file_ids:
        params["fids"] = file_ids
    try:
        result = await db.execute(sql, params)
    except Exception as exc:  # noqa: BLE001 - keyword arm is best-effort
        logger.warning("retrieval: keyword search failed: %s", exc)
        return []
    return [
        RetrievedChunk(
            chunk_id=row["id"],
            user_file_id=row["user_file_id"],
            text=row["text"],
            score=float(row["score"]) if row["score"] is not None else 0.0,
            chunk_metadata=dict(row["chunk_metadata"] or {}),
            filename=row["filename"],
        )
        for row in result.mappings().all()
    ]


def _rrf_merge(
    arms: list[list[RetrievedChunk]], k: int, *, rrf_k: int = 60
) -> list[RetrievedChunk]:
    """Reciprocal Rank Fusion of several best-first ranked chunk lists. A
    chunk's fused score is the sum over arms of ``1/(rrf_k + rank)``; the
    ``rrf_k`` constant damps the weight of low ranks (60 is the widely-used
    default). Returns the top-``k`` fused chunks. The first arm's copy of a
    chunk is kept as the representative, so the vector arm's cosine score
    survives for any downstream display."""
    scores: dict[uuid.UUID, float] = {}
    rep: dict[uuid.UUID, RetrievedChunk] = {}
    for arm in arms:
        for rank, ch in enumerate(arm):
            scores[ch.chunk_id] = scores.get(ch.chunk_id, 0.0) + 1.0 / (
                rrf_k + rank + 1
            )
            rep.setdefault(ch.chunk_id, ch)
    ranked = sorted(scores, key=lambda cid: scores[cid], reverse=True)
    return [rep[cid] for cid in ranked[:k]]


async def retrieve_context(
    db: AsyncSession,
    *,
    custom_model: CustomModel,
    query: str,
    top_k: int | None = None,
) -> list[RetrievedChunk]:
    """Return the top-K chunks most similar to ``query`` for this assistant.

    Falls back to ``[]`` (no error) when the workspace has no embedding
    provider, the assistant has no indexed chunks, or the embed call
    fails — better to degrade into a personality-only chat than crash a
    message send.
    """
    query = (query or "").strip()
    if not query:
        return []
    resolved = await _resolve_query_vector(db, query)
    if resolved is None:
        return []
    qvec_literal, dim, em = resolved
    return await _similarity_search(
        db,
        scope_col="custom_model_id",
        scope_id=custom_model.id,
        qvec_literal=qvec_literal,
        dim=dim,
        k=int(top_k or custom_model.top_k or 6),
        model=em,
    )


async def retrieve_workspace_context(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    query: str,
    top_k: int = 6,
    file_ids: list[uuid.UUID] | None = None,
) -> list[RetrievedChunk]:
    """Hybrid (vector + keyword) top-K over a workspace's indexed content.

    The **vector arm** finds semantically related passages (needs an
    embedder); the **keyword arm** (Postgres FTS) catches exact names, IDs
    and rare tokens that dense vectors blur — and needs no embedder. Their
    ranked lists are fused with Reciprocal Rank Fusion. When only one arm
    returns anything, its result passes through unchanged, so a workspace
    whose keyword arm finds nothing behaves exactly as pure-vector did.
    Same graceful-degradation contract: ``[]`` on total failure.
    ``file_ids`` narrows both arms to specific source files."""
    query = (query or "").strip()
    if not query:
        return []
    # Pull a few extra per arm so the fusion has material to work with
    # before trimming back to top_k.
    per_arm = max(top_k, 8)
    vector_hits: list[RetrievedChunk] = []
    resolved = await _resolve_query_vector(db, query)
    if resolved is not None:
        qvec_literal, dim, em = resolved
        vector_hits = await _similarity_search(
            db,
            scope_col="workspace_id",
            scope_id=workspace_id,
            qvec_literal=qvec_literal,
            dim=dim,
            k=per_arm,
            file_ids=file_ids,
            model=em,
        )
    keyword_hits = await _keyword_search(
        db,
        scope_col="workspace_id",
        scope_id=workspace_id,
        query=query,
        k=per_arm,
        file_ids=file_ids,
    )
    if not keyword_hits:
        return vector_hits[:top_k]
    if not vector_hits:
        return keyword_hits[:top_k]
    return _rrf_merge([vector_hits, keyword_hits], top_k)


async def retrieve_conversation_context(
    db: AsyncSession,
    *,
    conversation_id: uuid.UUID,
    query: str,
    top_k: int = 6,
) -> list[RetrievedChunk]:
    """Top-K chunks most similar to ``query`` among a conversation's indexed
    attachments (Phase 9). Same graceful-degradation contract as
    :func:`retrieve_workspace_context` — returns ``[]`` on any failure."""
    query = (query or "").strip()
    if not query:
        return []
    per_arm = max(top_k, 8)
    vector_hits: list[RetrievedChunk] = []
    resolved = await _resolve_query_vector(db, query)
    if resolved is not None:
        qvec_literal, dim, em = resolved
        vector_hits = await _similarity_search(
            db,
            scope_col="conversation_id",
            scope_id=conversation_id,
            qvec_literal=qvec_literal,
            dim=dim,
            k=per_arm,
            model=em,
        )
    # Keyword arm too, as workspaces have: with the embedder down an
    # indexed attachment used to vanish from the turn entirely (R-319).
    keyword_hits = await _keyword_search(
        db,
        scope_col="conversation_id",
        scope_id=conversation_id,
        query=query,
        k=per_arm,
    )
    if not keyword_hits:
        return vector_hits[:top_k]
    if not vector_hits:
        return keyword_hits[:top_k]
    return _rrf_merge([vector_hits, keyword_hits], top_k)


def format_retrieved_block(chunks: list[RetrievedChunk]) -> str:
    """Render retrieved chunks as a system-prompt "Knowledge" block.

    The format is intentionally simple and self-describing — every
    LLM we ship handles it without special prompting. Numbered
    citations let the model say "from [2]" if it wants to, but we
    don't *require* it to (forcing a citation format hurt response
    quality more than it helped in our spike).
    """
    if not chunks:
        return ""
    lines = ["You have access to the following context from the knowledge base.",
             "Use it when relevant; you may cite sources like [1], [2].",
             ""]
    for i, c in enumerate(chunks, start=1):
        source = c.filename or "untitled"
        lines.append(f"[{i}] {source}")
        lines.append(c.text.strip())
        lines.append("")
    return "\n".join(lines).rstrip()


# "Related by meaning" (WP-5.4): a hit counts when it stands this far above
# the background — the k-th best similarity, which is what unrelated files
# score against the query. Relative, so it holds across embedding models
# (nomic: related ~0.6+, unrelated ~0.35-0.47 on a sample drive).
RELATED_SAMPLE = 12
RELATED_MARGIN = 0.12


async def related_drive_hits(
    db: AsyncSession,
    *,
    reader_id: uuid.UUID,
    query: str,
    filters: Any = None,
) -> list[RetrievedChunk]:
    """Vector-only Drive hits that are clearly about ``query`` — the "related
    by meaning" list beside word search, which needs no shared words but
    must not fill up with whatever is least unrelated. Empty when there's no
    working embedder."""
    from app.files.access import readable_predicate

    query = (query or "").strip()
    resolved = await _resolve_query_vector(db, query) if query else None
    if resolved is None:
        return []
    qvec_literal, dim, em = resolved
    where = f"kc.drive_user_id IS NOT NULL AND {readable_predicate('f')}"
    params: dict[str, Any] = {"reader_id": str(reader_id)}
    if filters is not None:
        extra, extra_params = filters.sql("f")
        if extra:
            where += f" AND {extra}"
            params.update(extra_params, ff_reader=str(reader_id))
    hits = await _similarity_search(
        db, scope_col="drive_user_id", scope_id=reader_id, qvec_literal=qvec_literal, dim=dim,
        k=RELATED_SAMPLE, file_ids=None, model=em, scope_where=where, scope_params=params,
    )
    if len(hits) < 4:
        return []  # too few files to tell related from merely nearest
    background = min(h.score for h in hits)
    return [h for h in hits if h.score >= background + RELATED_MARGIN]


async def retrieve_drive_context(
    db: AsyncSession,
    *,
    reader_id: uuid.UUID,
    query: str,
    top_k: int = 6,
    file_ids: list[uuid.UUID] | None = None,
    filters: Any = None,
) -> list[RetrievedChunk]:
    """Hybrid top-K over the Drive index (WP-5.1): chunks of every file the
    reader can read — their own, and files people shared with them (when the
    owner opted in to indexing). The read rule is the one downloads use
    (``app.files.access``), so search never surfaces a file you can't open."""
    from app.files.access import readable_predicate

    query = (query or "").strip()
    if not query:
        return []
    where = f"kc.drive_user_id IS NOT NULL AND {readable_predicate('f')}"
    params: dict[str, Any] = {"reader_id": str(reader_id)}
    if filters is not None:
        # ``app.files.finder.FileFilters`` (WP-5.3) — type / folder / owner /
        # date narrowing on the same files row.
        extra, extra_params = filters.sql("f")
        if extra:
            where += f" AND {extra}"
            params.update(extra_params, ff_reader=str(reader_id))
    per_arm = max(top_k, 8)
    vector_hits: list[RetrievedChunk] = []
    resolved = await _resolve_query_vector(db, query)
    if resolved is not None:
        qvec_literal, dim, em = resolved
        vector_hits = await _similarity_search(
            db,
            scope_col="drive_user_id",
            scope_id=reader_id,
            qvec_literal=qvec_literal,
            dim=dim,
            k=per_arm,
            file_ids=file_ids,
            model=em,
            scope_where=where,
            scope_params=params,
        )
    keyword_hits = await _keyword_search(
        db,
        scope_col="drive_user_id",
        scope_id=reader_id,
        query=query,
        k=per_arm,
        file_ids=file_ids,
        scope_where=where,
        scope_params=params,
    )
    if not keyword_hits:
        return vector_hits[:top_k]
    if not vector_hits:
        return keyword_hits[:top_k]
    return _rrf_merge([vector_hits, keyword_hits], top_k)
