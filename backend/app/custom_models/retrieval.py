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


async def retrieve_context(
    db: AsyncSession,
    *,
    custom_model: CustomModel,
    query: str,
    top_k: int | None = None,
) -> list[RetrievedChunk]:
    """Return the top-K chunks most similar to ``query`` for this assistant.

    Falls back to ``[]`` (no error) when:

    * the workspace has no embedding provider configured yet
      (the setup wizard hasn't run / admin skipped it);
    * the assistant has no indexed chunks yet (either no files are
      attached or all files are still queued / failed);
    * the embed call to the configured provider raises — better to
      degrade gracefully into a personality-only chat than crash a
      message send.
    """
    query = (query or "").strip()
    if not query:
        return []

    settings: AppSettings | None = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if (
        settings is None
        or settings.embedding_provider_id is None
        or settings.embedding_model_id is None
        or settings.embedding_dim is None
    ):
        logger.debug(
            "retrieve_context: workspace has no embedding provider configured; "
            "returning empty context"
        )
        return []

    dim = int(settings.embedding_dim)
    if dim not in SUPPORTED_DIMS:
        logger.warning(
            "retrieve_context: configured embedding_dim=%d is not one of the "
            "indexed columns %s; returning empty context",
            dim,
            sorted(SUPPORTED_DIMS),
        )
        return []

    provider: ModelProvider | None = await db.get(
        ModelProvider, settings.embedding_provider_id
    )
    if provider is None:
        logger.warning(
            "retrieve_context: configured embedding provider %s no longer exists",
            settings.embedding_provider_id,
        )
        return []

    try:
        vectors = await embed_texts(
            provider=provider,
            model_id=settings.embedding_model_id,
            texts=[normalise_for_embedding(query)],
        )
    except Exception as exc:  # noqa: BLE001 - best-effort retrieval
        logger.warning("retrieve_context: embed call failed: %s", exc)
        return []
    if not vectors:
        return []

    qvec_literal = vector_literal(vectors[0])
    column = f"embedding_{dim}"
    k = max(1, int(top_k or custom_model.top_k or 6))

    # ``<=>`` is pgvector's cosine distance operator (smaller = more
    # similar). We return ``1 - distance`` as the human "score" so the
    # frontend can display percentages without having to know pgvector
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
        LEFT JOIN files AS f ON f.id = kc.user_file_id
        WHERE kc.custom_model_id = :model_id
          AND kc.{column} IS NOT NULL
        ORDER BY kc.{column} <=> CAST(:qvec AS vector({dim}))
        LIMIT :k
        """
    )
    result = await db.execute(
        sql,
        {
            "qvec": qvec_literal,
            "model_id": str(custom_model.id),
            "k": k,
        },
    )
    rows = result.mappings().all()
    return [
        RetrievedChunk(
            chunk_id=row["id"],
            user_file_id=row["user_file_id"],
            text=row["text"],
            score=float(row["score"]) if row["score"] is not None else 0.0,
            chunk_metadata=dict(row["chunk_metadata"] or {}),
            filename=row["filename"],
        )
        for row in rows
    ]


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
