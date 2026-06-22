"""Semantic (embedding) search over conversation messages (Phase 7).

Reuses the workspace embedding config + pgvector plumbing that powers
Custom-Model RAG. Degrades gracefully to "no results" (never raises)
when embeddings aren't configured or the provider call fails, so the
keyword/FTS path the search palette already relies on keeps working.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.custom_models.embedding import (
    SUPPORTED_DIMS,
    embed_texts,
    normalise_for_embedding,
    vector_literal,
)
from app.models_config.models import ModelProvider

logger = logging.getLogger("promptly.chat.semantic_search")

# Cosine-similarity floor for a semantic-only hit to be surfaced. Below
# this the match is almost always noise (pgvector top-k always returns
# *something*, however unrelated). Conservative so it rarely drops a
# genuine paraphrase match; tuned against 768-dim nomic / 1536-dim
# text-embedding-3-small.
MIN_SCORE: Final[float] = 0.30


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: ModelProvider
    model_id: str
    dim: int


async def get_embedding_config(db: AsyncSession) -> EmbeddingConfig | None:
    """Resolve the workspace embedding provider/model/dim, or ``None`` when
    embeddings aren't configured (fresh install / admin skipped setup)."""
    settings: AppSettings | None = await db.get(
        AppSettings, SINGLETON_APP_SETTINGS_ID
    )
    if (
        settings is None
        or settings.embedding_provider_id is None
        or settings.embedding_model_id is None
        or settings.embedding_dim is None
    ):
        return None
    dim = int(settings.embedding_dim)
    if dim not in SUPPORTED_DIMS:
        return None
    provider = await db.get(ModelProvider, settings.embedding_provider_id)
    if provider is None:
        return None
    return EmbeddingConfig(
        provider=provider, model_id=settings.embedding_model_id, dim=dim
    )


async def embed_query(cfg: EmbeddingConfig, q: str) -> list[float] | None:
    """Embed a search query. Best-effort — returns ``None`` on failure."""
    cleaned = normalise_for_embedding(q or "")
    if not cleaned:
        return None
    try:
        vectors = await embed_texts(
            provider=cfg.provider,
            model_id=cfg.model_id,
            texts=[cleaned],
            dimensions=cfg.dim,
        )
    except Exception as exc:  # noqa: BLE001 - best-effort
        logger.warning("semantic search embed failed: %s", exc)
        return None
    return vectors[0] if vectors else None


async def semantic_search_messages(
    db: AsyncSession,
    *,
    qvec: list[float],
    cfg: EmbeddingConfig,
    conv_ids: list[uuid.UUID],
    user_id: uuid.UUID,
    limit: int,
    start: datetime | None = None,
    end: datetime | None = None,
) -> list[dict]:
    """Cosine-similarity search over indexed messages in ``conv_ids``.

    Returns row dicts with the same field names as the FTS query plus a
    ``content`` field (for snippet synthesis) and a 0–1 ``score``.

    ``start`` / ``end`` optionally bound matches by ``created_at`` so the
    semantic recall honours the same date filter the keyword path does.
    """
    if not conv_ids:
        return []
    # ``cfg.dim`` is interpolated into the column name and the vector cast
    # below, so it must never be attacker-influenced. In practice every
    # ``EmbeddingConfig`` is built by ``get_embedding_config`` which already
    # rejects any dim outside ``SUPPORTED_DIMS`` — this assertion keeps that
    # SQL-injection guarantee local to the query instead of relying on a
    # caller invariant.
    if cfg.dim not in SUPPORTED_DIMS:
        raise ValueError(f"Unsupported embedding dim for search: {cfg.dim!r}")
    column = f"embedding_{cfg.dim}"
    # Optional created_at range — mirrors the FTS path so a hybrid search
    # with a date filter doesn't leak out-of-range semantic hits.
    date_sql = ""
    date_params: dict[str, datetime] = {}
    if start is not None:
        date_sql += " AND m.created_at >= :start"
        date_params["start"] = start
    if end is not None:
        date_sql += " AND m.created_at < :end"
        date_params["end"] = end
    sql = text(
        f"""
        SELECT
            m.conversation_id AS conversation_id,
            m.id              AS message_id,
            c.title           AS conversation_title,
            m.role            AS role,
            m.content         AS content,
            m.created_at      AS created_at,
            (1 - (e.{column} <=> CAST(:qvec AS vector({cfg.dim})))) AS score,
            CASE
                WHEN c.user_id = :user_id THEN 'owner'
                ELSE 'collaborator'
            END AS access
        FROM message_embeddings e
        JOIN messages m ON m.id = e.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE e.conversation_id = ANY(:conv_ids)
          AND e.{column} IS NOT NULL
          AND c.archived_at IS NULL
          {date_sql}
        ORDER BY e.{column} <=> CAST(:qvec AS vector({cfg.dim}))
        LIMIT :limit
        """
    )
    rows = (
        await db.execute(
            sql,
            {
                "qvec": vector_literal(qvec),
                "conv_ids": conv_ids,
                "user_id": user_id,
                "limit": limit,
                **date_params,
            },
        )
    ).mappings().all()
    out: list[dict] = []
    for r in rows:
        score = float(r["score"]) if r["score"] is not None else 0.0
        if score < MIN_SCORE:
            continue
        out.append({**dict(r), "score": score})
    return out
