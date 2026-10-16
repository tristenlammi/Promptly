"""Background indexer that embeds conversation messages (Phase 7).

A single lifespan loop that embeds any message lacking an up-to-date
embedding row — backfill of existing history and indexing of new messages
alike, with no hooks in the hot chat path. A row is stale when the
message's content changed (``content_hash``) or the admin switched the
embedding model or dimension (``embed_model`` / ``embed_dim``, R-317).

Cheap when idle (R-323): after one full pass, cycles only look at
messages created or edited since a watermark, with a full pass every half
hour to catch in-place appends (continue-generation). A message the
embedder can't take (empty after normalising, or rejected by the
provider) gets a marker row (``embed_dim = 0``) so it leaves the candidate
set instead of stalling every batch behind it. Runs as background work
through the fairness gate with character-capped batches, so chat query
embeds don't queue behind it (R-332).
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta
from typing import Final

import openai
from sqlalchemy import text

from app.chat.semantic_search import EmbeddingConfig, get_embedding_config
from app.custom_models.embedding import (
    EmbedderUnavailable,
    embed_texts,
    normalise_for_embedding,
    vector_literal,
)
from app.database import SessionLocal

logger = logging.getLogger("promptly.chat.semantic_index")

_BATCH: Final[int] = 16
# Characters per embed request — 32 long turns used to make a ~128k-char
# request that a chat's query embed queued behind (R-332).
_MAX_BATCH_CHARS: Final[int] = 32_000
_MIN_CHARS: Final[int] = 12
# Cap per-message text fed to the embedder — keeps cost bounded and most
# embedding models truncate well past this anyway. The whole message is
# still keyword-searchable via FTS; semantic recall keys on the gist.
_MAX_EMBED_CHARS: Final[int] = 4000
_ACTIVE_SLEEP: Final[float] = 5.0
_IDLE_SLEEP: Final[float] = 60.0
_FULL_SCAN_SECONDS: Final[float] = 1800.0

# Stale-row test. ``embed_dim = 0`` is the "can't embed" marker: it stays
# out while the content and model still match.
_STALE_SQL: Final[str] = """
          AND (
                e.message_id IS NULL
             OR e.content_hash <> md5(m.content)
             OR e.embed_model IS DISTINCT FROM :model
             OR (e.embed_dim <> :dim AND e.embed_dim <> 0)
          )
"""


async def _find_candidates(
    db, dim: int, model: str, limit: int, since: datetime | None = None
) -> list[dict]:
    """Newest-first messages that need (re)embedding for the current model
    and dim. ``since`` narrows to messages created or edited after a
    watermark (both columns are indexed — 0186)."""
    params: dict = {"min_chars": _MIN_CHARS, "dim": dim, "model": model, "limit": limit}
    since_sql = ""
    if since is not None:
        since_sql = "AND (m.created_at >= :since OR m.edited_at >= :since)"
        params["since"] = since
    sql = text(
        f"""
        SELECT m.id AS id, m.conversation_id AS conversation_id,
               m.content AS content
        FROM messages m
        LEFT JOIN message_embeddings e ON e.message_id = m.id
        WHERE m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND length(btrim(m.content)) >= :min_chars
          {since_sql}
          {_STALE_SQL}
        ORDER BY m.created_at DESC
        LIMIT :limit
        """
    )
    rows = (await db.execute(sql, params)).mappings().all()
    return [dict(r) for r in rows]


async def _upsert(db, *, dim: int, model: str, message_id, conversation_id, vec, content):
    """Write one embedding row (active column = current dim, other NULLed).
    ``vec=None`` writes the "can't embed" marker (embed_dim 0, no vector)."""
    if vec is None:
        await db.execute(
            text(
                """
                INSERT INTO message_embeddings
                    (message_id, conversation_id, content_hash, embed_dim,
                     embed_model, created_at, updated_at)
                VALUES (:mid, :cid, md5(:content), 0, :model, now(), now())
                ON CONFLICT (message_id) DO UPDATE SET
                    content_hash   = EXCLUDED.content_hash,
                    embed_dim      = 0,
                    embed_model    = EXCLUDED.embed_model,
                    embedding_768  = NULL,
                    embedding_1536 = NULL,
                    updated_at     = now()
                """
            ),
            {"mid": message_id, "cid": conversation_id, "content": content, "model": model},
        )
        return
    other = 1536 if dim == 768 else 768
    sql = text(
        f"""
        INSERT INTO message_embeddings
            (message_id, conversation_id, content_hash, embed_dim, embed_model,
             embedding_{dim}, created_at, updated_at)
        VALUES
            (:mid, :cid, md5(:content), :dim, :model,
             CAST(:vec AS vector({dim})), now(), now())
        ON CONFLICT (message_id) DO UPDATE SET
            conversation_id = EXCLUDED.conversation_id,
            content_hash   = EXCLUDED.content_hash,
            embed_dim      = EXCLUDED.embed_dim,
            embed_model    = EXCLUDED.embed_model,
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
            "model": model,
            "vec": vector_literal(vec),
        },
    )


async def _embed_one(cfg: EmbeddingConfig, text_: str) -> list[float] | None:
    """Embed one message; ``None`` when the provider rejects it. Outages
    (timeouts, the breaker, 5xx) still raise — they aren't the message's
    fault, so it mustn't be marked."""
    try:
        vecs = await embed_texts(
            provider=cfg.provider, model_id=cfg.model_id, texts=[text_], dimensions=cfg.dim
        )
    except openai.BadRequestError:
        return None
    if len(vecs) != 1 or len(vecs[0]) != cfg.dim:
        return None
    return vecs[0]


async def _index_batch(db, cfg: EmbeddingConfig, since: datetime | None = None) -> int:
    """Embed + persist one batch. Returns the number of rows processed."""
    candidates = await _find_candidates(db, cfg.dim, cfg.model_id, _BATCH, since)
    if not candidates:
        return 0

    # ``md5(:content)`` in the upsert must hash the SAME bytes the row's
    # change-detector compares against — i.e. the full raw content — so
    # we keep the raw text for hashing but embed a normalised/truncated
    # copy.
    batch: list[tuple[dict, str]] = []
    chars = 0
    for c in candidates:
        t = normalise_for_embedding(c["content"])[:_MAX_EMBED_CHARS]
        if batch and chars + len(t) > _MAX_BATCH_CHARS:
            break
        batch.append((c, t))
        chars += len(t)

    # Inputs the embedder would drop are marked now, so the vectors line
    # up with the rest by index (R-323).
    embeddable = [(c, t) for c, t in batch if len(t) >= _MIN_CHARS]
    for c, t in batch:
        if len(t) < _MIN_CHARS:
            await _upsert(
                db, dim=cfg.dim, model=cfg.model_id, message_id=c["id"],
                conversation_id=c["conversation_id"], vec=None, content=c["content"],
            )

    vectors: list[list[float] | None] = []
    if embeddable:
        try:
            got = await embed_texts(
                provider=cfg.provider,
                model_id=cfg.model_id,
                texts=[t for _, t in embeddable],
                dimensions=cfg.dim,
            )
            if len(got) == len(embeddable):
                vectors = list(got)
        except openai.BadRequestError:
            pass
        if not vectors:
            # The provider refused the batch or returned a short list: go
            # one by one so the bad message is isolated and marked, instead
            # of the same batch failing every cycle forever.
            vectors = [await _embed_one(cfg, t) for _, t in embeddable]

    for (cand, _), vec in zip(embeddable, vectors):
        if vec is not None and len(vec) != cfg.dim:
            vec = None
        await _upsert(
            db,
            dim=cfg.dim,
            model=cfg.model_id,
            message_id=cand["id"],
            conversation_id=cand["conversation_id"],
            vec=vec,
            content=cand["content"],
        )
    await db.commit()
    return len(batch)


async def _loop() -> None:
    from app.custom_models import embedding_gate

    # Background work: yields to interactive query embeds (R-332).
    embedding_gate.mark_background()
    logger.info("Semantic conversation indexer started")
    # Per fingerprint: the watermark set when a full pass came up empty.
    watermark: dict[tuple[str, int], datetime] = {}
    last_full: dict[tuple[str, int], float] = {}
    while True:
        try:
            processed = 0
            async with SessionLocal() as db:
                cfg = await get_embedding_config(db)
                if cfg is not None:
                    fp = (cfg.model_id, cfg.dim)
                    now_mono = time.monotonic()
                    full = (
                        fp not in watermark
                        or now_mono - last_full.get(fp, 0.0) >= _FULL_SCAN_SECONDS
                    )
                    scan_started = (await db.execute(text("SELECT now()"))).scalar_one()
                    processed = await _index_batch(db, cfg, None if full else watermark[fp])
                    if full and not processed:
                        # Margin for transactions still open across the scan.
                        watermark[fp] = scan_started - timedelta(minutes=10)
                        last_full[fp] = now_mono
            await asyncio.sleep(_ACTIVE_SLEEP if processed else _IDLE_SLEEP)
        except asyncio.CancelledError:
            raise
        except EmbedderUnavailable:
            # Breaker open or provider disabled — admins are told once
            # (embedding._note_outage); no stack trace every minute.
            await asyncio.sleep(_IDLE_SLEEP)
        except Exception:  # noqa: BLE001 - never let the loop die
            logger.exception("Semantic indexer batch failed")
            await asyncio.sleep(_IDLE_SLEEP)


def start_semantic_indexer() -> asyncio.Task:
    """Spawn the background indexer (called from the app lifespan)."""
    return asyncio.create_task(_loop(), name="semantic_indexer")
