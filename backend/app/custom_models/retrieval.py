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
import uuid
from dataclasses import dataclass

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


@dataclass(frozen=True)
class RetrievedChunk:
    """Single hit from the vector search, plus the file it came from."""

    chunk_id: uuid.UUID
    user_file_id: uuid.UUID
    text: str
    score: float
    chunk_metadata: dict[str, object]
    filename: str | None


async def _resolve_query_vector(
    db: AsyncSession, query: str
) -> tuple[str, int] | None:
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
        return None

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

    try:
        vectors = await embed_texts(
            provider=provider,
            model_id=settings.embedding_model_id,
            texts=[normalise_for_embedding(query)],
            dimensions=dim,
        )
    except Exception as exc:  # noqa: BLE001 - best-effort retrieval
        logger.warning("retrieval: embed call failed: %s", exc)
        return None
    if not vectors:
        return None
    return vector_literal(vectors[0]), dim


async def _similarity_search(
    db: AsyncSession,
    *,
    scope_col: str,
    scope_id: uuid.UUID,
    qvec_literal: str,
    dim: int,
    k: int,
    file_ids: list[uuid.UUID] | None = None,
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
        WHERE kc.{scope_col} = :sid
          AND kc.{column} IS NOT NULL
          -- Never retrieve chunks whose source file has been trashed/deleted:
          -- deleting a workspace item only *trashes* its backing file, so its
          -- chunks linger. Without this, a deleted board/note/sheet keeps
          -- feeding stale content into every answer.
          AND f.trashed_at IS NULL
          {file_filter}
        ORDER BY kc.{column} <=> CAST(:qvec AS vector({dim}))
        LIMIT :k
        """
    )
    params: dict[str, object] = {
        "qvec": qvec_literal,
        "sid": str(scope_id),
        "k": max(1, k),
    }
    if file_ids:
        params["fids"] = file_ids
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
        WHERE kc.{scope_col} = :sid
          AND f.trashed_at IS NULL
          AND {tsv} @@ websearch_to_tsquery('english', :q)
          {file_filter}
        ORDER BY score DESC
        LIMIT :k
        """
    )
    params: dict[str, object] = {"q": query, "sid": str(scope_id), "k": max(1, k)}
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
    qvec_literal, dim = resolved
    return await _similarity_search(
        db,
        scope_col="custom_model_id",
        scope_id=custom_model.id,
        qvec_literal=qvec_literal,
        dim=dim,
        k=int(top_k or custom_model.top_k or 6),
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
        qvec_literal, dim = resolved
        vector_hits = await _similarity_search(
            db,
            scope_col="workspace_id",
            scope_id=workspace_id,
            qvec_literal=qvec_literal,
            dim=dim,
            k=per_arm,
            file_ids=file_ids,
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
    resolved = await _resolve_query_vector(db, query)
    if resolved is None:
        return []
    qvec_literal, dim = resolved
    return await _similarity_search(
        db,
        scope_col="conversation_id",
        scope_id=conversation_id,
        qvec_literal=qvec_literal,
        dim=dim,
        k=top_k,
    )


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
