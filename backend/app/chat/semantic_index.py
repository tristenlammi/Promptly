"""Background indexer that embeds conversation messages (Phase 7).

A single lifespan loop that continuously embeds any message lacking an
up-to-date embedding row — which transparently handles both backfill of
existing history and indexing of new messages, with no hooks in the hot
chat path. Re-embeds when a message's content changes (``content_hash``
mismatch) or the admin switches embedding model/dim (``embed_dim``
mismatch).

Deliberately conservative: small batches with a short sleep between
them so it makes steady progress without saturating the embedding
provider, and a longer idle sleep when there's nothing to do (or
embeddings aren't configured).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Final

from sqlalchemy import text

from app.chat.semantic_search import EmbeddingConfig, get_embedding_config
from app.custom_models.embedding import (
    embed_texts,
    normalise_for_embedding,
    vector_literal,
)
from app.database import SessionLocal

logger = logging.getLogger("promptly.chat.semantic_index")

_BATCH: Final[int] = 32
_MIN_CHARS: Final[int] = 12
# Cap per-message text fed to the embedder — keeps cost bounded and most
# embedding models truncate well past this anyway. The whole message is
# still keyword-searchable via FTS; semantic recall keys on the gist.
_MAX_EMBED_CHARS: Final[int] = 4000
_ACTIVE_SLEEP: Final[float] = 5.0
_IDLE_SLEEP: Final[float] = 60.0


async def _find_candidates(db, dim: int, limit: int) -> list[dict]:
    """Newest-first messages that need (re)embedding for the current dim."""
    sql = text(
        """
        SELECT m.id AS id, m.conversation_id AS conversation_id,
               m.content AS content
        FROM messages m
        LEFT JOIN message_embeddings e ON e.message_id = m.id
        WHERE m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND length(btrim(m.content)) >= :min_chars
          AND (
                e.message_id IS NULL
             OR e.embed_dim <> :dim
             OR e.content_hash <> md5(m.content)
          )
        ORDER BY m.created_at DESC
        LIMIT :limit
        """
    )
    rows = (
        await db.execute(
            sql, {"min_chars": _MIN_CHARS, "dim": dim, "limit": limit}
        )
    ).mappings().all()
    return [dict(r) for r in rows]


async def _upsert(db, *, dim: int, message_id, conversation_id, vec, content):
    """Write one embedding row (active column = current dim, other NULLed)."""
    other = 1536 if dim == 768 else 768
    sql = text(
        f"""
        INSERT INTO message_embeddings
            (message_id, conversation_id, content_hash, embed_dim,
             embedding_{dim}, created_at, updated_at)
        VALUES
            (:mid, :cid, md5(:content), :dim,
             CAST(:vec AS vector({dim})), now(), now())
        ON CONFLICT (message_id) DO UPDATE SET
            conversation_id = EXCLUDED.conversation_id,
            content_hash   = EXCLUDED.content_hash,
            embed_dim      = EXCLUDED.embed_dim,
            embedding_{dim} = EXCLUDED.embedding_{dim},
            embedding_{other} = NULL,
            updated_at     = now()
        """
    )
    await db.execute(
        sql,
        {
            "mid": message_id,
            "cid": conversation_id,
            "content": content,
            "dim": dim,
            "vec": vector_literal(vec),
        },
    )


async def _index_batch(db, cfg: EmbeddingConfig) -> int:
    """Embed + persist one batch. Returns the number of rows processed."""
    candidates = await _find_candidates(db, cfg.dim, _BATCH)
    if not candidates:
        return 0

    # ``md5(:content)`` in the upsert must hash the SAME bytes the row's
    # change-detector compares against — i.e. the full raw content — so
    # we keep the raw text for hashing but embed a normalised/truncated
    # copy.
    raw = [c["content"] for c in candidates]
    to_embed = [
        normalise_for_embedding(c["content"])[:_MAX_EMBED_CHARS]
        for c in candidates
    ]
    vectors = await embed_texts(
        provider=cfg.provider,
        model_id=cfg.model_id,
        texts=to_embed,
        dimensions=cfg.dim,
    )
    if len(vectors) != len(candidates):
        logger.warning(
            "semantic indexer: embed returned %d vectors for %d inputs; "
            "skipping batch",
            len(vectors),
            len(candidates),
        )
        return 0

    for cand, vec, raw_content in zip(candidates, vectors, raw):
        await _upsert(
            db,
            dim=cfg.dim,
            message_id=cand["id"],
            conversation_id=cand["conversation_id"],
            vec=vec,
            content=raw_content,
        )
    await db.commit()
    return len(candidates)


async def _loop() -> None:
    logger.info("Semantic conversation indexer started")
    while True:
        try:
            processed = 0
            async with SessionLocal() as db:
                cfg = await get_embedding_config(db)
                if cfg is not None:
                    processed = await _index_batch(db, cfg)
            await asyncio.sleep(_ACTIVE_SLEEP if processed else _IDLE_SLEEP)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - never let the loop die
            logger.exception("Semantic indexer batch failed")
            await asyncio.sleep(_IDLE_SLEEP)


def start_semantic_indexer() -> asyncio.Task:
    """Spawn the background indexer (called from the app lifespan)."""
    return asyncio.create_task(_loop(), name="semantic_indexer")
