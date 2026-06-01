"""Background RAG indexer for email messages (Phase 12 — E.1).

Continuously embeds email messages into email_chunks so the search_emails
tool can do semantic retrieval. Mirrors the message semantic indexer pattern
(app/chat/semantic_index.py) exactly: small batches, adaptive sleep, no hooks
in the hot path, no-op when embeddings aren't configured.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Final

from sqlalchemy import text

from app.chat.semantic_search import EmbeddingConfig, get_embedding_config
from app.custom_models.embedding import (
    chunk_text,
    embed_texts,
    normalise_for_embedding,
    vector_literal,
)
from app.database import SessionLocal

logger = logging.getLogger("promptly.email.indexer")

_BATCH: Final[int] = 16
_MAX_BODY_CHARS: Final[int] = 6000   # cap per-message to limit cost
_ACTIVE_SLEEP: Final[float] = 10.0
_IDLE_SLEEP: Final[float] = 120.0


def _build_embed_text(subject: str | None, body_text: str | None, from_address: str | None) -> str:
    """Combine subject + body into a single embeddable string."""
    parts = []
    if subject:
        parts.append(f"Subject: {subject}")
    if from_address:
        parts.append(f"From: {from_address}")
    if body_text:
        parts.append(body_text[:_MAX_BODY_CHARS])
    return "\n".join(parts)


async def _find_candidates(db, dim: int, limit: int) -> list[dict]:
    """Email messages that need (re)embedding for the current dim."""
    sql = text(
        """
        SELECT m.id          AS email_id,
               m.user_id     AS user_id,
               m.subject     AS subject,
               m.body_text   AS body_text,
               m.from_address AS from_address,
               m.from_name   AS from_name,
               m.date        AS date
        FROM email_messages m
        WHERE m.body_text IS NOT NULL
          AND length(btrim(coalesce(m.body_text, ''))) > 20
          AND NOT EXISTS (
              SELECT 1 FROM email_chunks ec
              WHERE ec.email_id = m.id
                AND ec.embed_dim = :dim
                AND ec.content_hash = md5(
                    coalesce(m.subject,'') || coalesce(m.body_text,'')
                )
          )
        ORDER BY m.date DESC
        LIMIT :limit
        """
    )
    rows = (
        await db.execute(sql, {"dim": dim, "limit": limit})
    ).mappings().all()
    return [dict(r) for r in rows]


async def _delete_old_chunks(db, email_id, dim: int) -> None:
    """Remove stale chunks before inserting fresh ones."""
    await db.execute(
        text(
            "DELETE FROM email_chunks WHERE email_id = :eid AND embed_dim = :dim"
        ),
        {"eid": email_id, "dim": dim},
    )


async def _insert_chunk(
    db,
    *,
    email_id,
    user_id,
    chunk_index: int,
    text_content: str,
    dim: int,
    vec: list[float],
    model_id: str,
    metadata: dict,
    content_hash: str,
) -> None:
    other = 1536 if dim == 768 else 768
    sql = text(
        f"""
        INSERT INTO email_chunks
            (id, email_id, user_id, chunk_index, text, tokens, embedding_model,
             embed_dim, content_hash, chunk_metadata,
             embedding_{dim}, created_at, updated_at)
        VALUES
            (gen_random_uuid(), :eid, :uid, :cidx, :txt, :tok, :model,
             :dim, :chash, CAST(:meta AS jsonb),
             CAST(:vec AS vector({dim})), now(), now())
        ON CONFLICT (user_id, email_id, chunk_index) DO UPDATE SET
            text           = EXCLUDED.text,
            tokens         = EXCLUDED.tokens,
            embedding_model = EXCLUDED.embedding_model,
            embed_dim      = EXCLUDED.embed_dim,
            content_hash   = EXCLUDED.content_hash,
            chunk_metadata = EXCLUDED.chunk_metadata,
            embedding_{dim} = EXCLUDED.embedding_{dim},
            embedding_{other} = NULL,
            updated_at     = now()
        """
    )
    import json
    await db.execute(sql, {
        "eid": str(email_id),
        "uid": str(user_id),
        "cidx": chunk_index,
        "txt": text_content,
        "tok": len(text_content) // 4,
        "model": model_id,
        "dim": dim,
        "chash": content_hash,
        "meta": json.dumps(metadata),
        "vec": vector_literal(vec),
    })


async def _index_batch(db, cfg: EmbeddingConfig) -> int:
    """Embed + persist one batch of emails. Returns count processed."""
    import hashlib
    candidates = await _find_candidates(db, cfg.dim, _BATCH)
    if not candidates:
        return 0

    processed = 0
    for cand in candidates:
        raw_text = _build_embed_text(
            cand["subject"], cand["body_text"], cand["from_address"]
        )
        content_hash = hashlib.md5(
            ((cand["subject"] or "") + (cand["body_text"] or "")).encode()
        ).hexdigest()

        # Chunk the text
        chunks = chunk_text(normalise_for_embedding(raw_text))
        if not chunks:
            continue

        texts_to_embed = [c.text[:_MAX_BODY_CHARS] for c in chunks]
        try:
            vectors = await embed_texts(
                provider=cfg.provider, model_id=cfg.model_id, texts=texts_to_embed
            )
        except Exception:
            logger.exception("embed_texts failed for email %s", cand["email_id"])
            continue

        if len(vectors) != len(chunks):
            continue

        # Delete old chunks for this email+dim before inserting fresh
        await _delete_old_chunks(db, cand["email_id"], cfg.dim)

        metadata = {
            "subject": cand["subject"],
            "from_address": cand["from_address"],
            "from_name": cand["from_name"],
            "date": cand["date"].isoformat() if cand["date"] else None,
        }

        for chunk, vec in zip(chunks, vectors):
            await _insert_chunk(
                db,
                email_id=cand["email_id"],
                user_id=cand["user_id"],
                chunk_index=chunk.index,
                text_content=chunk.text,
                dim=cfg.dim,
                vec=vec,
                model_id=cfg.model_id,
                metadata=metadata,
                content_hash=content_hash,
            )

        processed += 1

    await db.commit()
    return processed


async def _loop() -> None:
    logger.info("Email RAG indexer started")
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
        except Exception:
            logger.exception("Email indexer batch failed")
            await asyncio.sleep(_IDLE_SLEEP)


def start_email_indexer() -> asyncio.Task:
    """Spawn the background email RAG indexer (called from the app lifespan)."""
    return asyncio.create_task(_loop(), name="email_indexer")
