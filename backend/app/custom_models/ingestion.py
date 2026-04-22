"""Background ingestion tasks for the Custom Models knowledge library.

Two flavours:

* :func:`index_file_for_custom_model` — embed a single file. Called
  whenever a file is attached / re-indexed manually.
* :func:`reembed_custom_model`        — fan out the above for every
  file pinned to an assistant. Useful after the admin changes the
  embedding provider in the setup wizard.

Both run on FastAPI's :class:`~fastapi.BackgroundTasks` runner. We
deliberately avoid Celery / arq / a dedicated worker for this — at
the expected workspace scale (dozens of files per assistant, not
thousands) the in-process queue is plenty, and skipping the moving
parts keeps the operational footprint flat.

The functions own their own DB session (one per task) so they can
outlive the originating HTTP request without holding its session
hostage.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.custom_models.embedding import (
    Chunk,
    SUPPORTED_DIMS,
    chunk_text,
    embed_texts,
    extract_text_for_embedding,
    file_content_hash,
    normalise_for_embedding,
    vector_literal,
)
from app.custom_models.models import CustomModelFile, KnowledgeChunk
from app.database import SessionLocal
from app.files.models import UserFile
from app.models_config.models import ModelProvider

logger = logging.getLogger(__name__)


# Embed in batches so a 200-chunk file doesn't fire 200 round trips.
# 16 is the sweet spot — small enough to keep one provider call under
# the few-second mark on a dial-up CPU-only Ollama and large enough
# to amortise per-call overhead on cloud providers.
EMBED_BATCH_SIZE = 16


async def _set_status(
    db: AsyncSession,
    *,
    custom_model_id: uuid.UUID,
    user_file_id: uuid.UUID,
    status: str,
    error: str | None = None,
    indexed_hash: str | None = None,
) -> None:
    """Single-row update of the indexing status fields, committed
    immediately so the UI's polling reflects progress in real time."""
    pivot = await db.get(
        CustomModelFile, (custom_model_id, user_file_id)
    )
    if pivot is None:
        return
    pivot.indexing_status = status
    pivot.indexing_error = error
    if status == "ready":
        pivot.indexed_at = datetime.now(timezone.utc)
        if indexed_hash is not None:
            pivot.indexed_content_hash = indexed_hash
    await db.commit()


async def _delete_existing_chunks(
    db: AsyncSession,
    *,
    custom_model_id: uuid.UUID,
    user_file_id: uuid.UUID,
) -> None:
    """Drop any prior chunks for this (model, file) pair before re-embedding.

    Cheaper than a per-chunk MERGE — and the unique constraint on
    ``(custom_model_id, user_file_id, chunk_index)`` would refuse a
    plain re-insert anyway.
    """
    await db.execute(
        text(
            """
            DELETE FROM knowledge_chunks
            WHERE custom_model_id = :cm AND user_file_id = :uf
            """
        ),
        {"cm": str(custom_model_id), "uf": str(user_file_id)},
    )
    await db.commit()


async def _insert_chunks(
    db: AsyncSession,
    *,
    custom_model_id: uuid.UUID,
    user_file_id: uuid.UUID,
    chunks: list[Chunk],
    embeddings: list[list[float]],
    embedding_model: str,
    embedding_dim: int,
) -> None:
    """Bulk-insert embedded chunks into ``knowledge_chunks``.

    Vector literals are interpolated into the SQL via the standard
    pgvector text format; everything else goes through bind
    parameters. The dim discriminator picks which ``embedding_<N>``
    column to populate so the unused column stays NULL (the partial
    HNSW index doesn't index NULLs).
    """
    if not chunks:
        return
    if embedding_dim not in SUPPORTED_DIMS:
        raise ValueError(
            f"embedding_dim={embedding_dim} not one of supported "
            f"vector columns {sorted(SUPPORTED_DIMS)}"
        )
    column = f"embedding_{embedding_dim}"

    # One row per chunk. We intentionally use a single INSERT with
    # multiple VALUES tuples instead of executemany() so the vector
    # literal goes through ``text()`` once per row — asyncpg's
    # parameter system can't bind a vector literal directly.
    sql = text(
        f"""
        INSERT INTO knowledge_chunks
            (id, custom_model_id, user_file_id, chunk_index,
             text, tokens, embedding_model, embedding_dim,
             metadata, {column})
        VALUES
            (gen_random_uuid(), :cm, :uf, :idx,
             :text, :tokens, :em_model, :em_dim,
             CAST(:meta AS jsonb), CAST(:vec AS vector({embedding_dim})))
        """
    )
    for chunk, vec in zip(chunks, embeddings):
        await db.execute(
            sql,
            {
                "cm": str(custom_model_id),
                "uf": str(user_file_id),
                "idx": chunk.index,
                "text": chunk.text,
                "tokens": chunk.tokens,
                "em_model": embedding_model,
                "em_dim": embedding_dim,
                "meta": _json_dump(chunk.metadata),
                "vec": vector_literal(vec),
            },
        )
    await db.commit()


def _json_dump(obj: dict[str, object]) -> str:
    """Tiny shim so we don't need ``json.dumps`` imported in two places."""
    import json

    return json.dumps(obj, ensure_ascii=False)


async def _load_embedding_provider(
    db: AsyncSession,
) -> tuple[ModelProvider | None, str | None, int | None]:
    """Resolve the workspace's configured embedding provider + model id + dim."""
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if (
        settings is None
        or settings.embedding_provider_id is None
        or settings.embedding_model_id is None
        or settings.embedding_dim is None
    ):
        return None, None, None
    provider = await db.get(ModelProvider, settings.embedding_provider_id)
    return provider, settings.embedding_model_id, int(settings.embedding_dim)


async def index_file_for_custom_model(
    custom_model_id: uuid.UUID,
    user_file_id: uuid.UUID,
    *,
    force: bool = False,
) -> None:
    """Embed (or re-embed) a single knowledge-library file.

    Owns its own DB session — safe to call from a FastAPI
    ``BackgroundTasks`` runner where the request session is gone by
    the time we start.

    ``force`` skips the content-hash short-circuit. Used when the
    admin clicks "re-index" in the UI to recover from a transient
    embedding failure even when the file bytes haven't changed.
    """
    async with SessionLocal() as db:
        try:
            await _set_status(
                db,
                custom_model_id=custom_model_id,
                user_file_id=user_file_id,
                status="embedding",
            )

            file = await db.get(UserFile, user_file_id)
            if file is None:
                await _set_status(
                    db,
                    custom_model_id=custom_model_id,
                    user_file_id=user_file_id,
                    status="failed",
                    error="source file no longer exists",
                )
                return

            provider, model_id, dim = await _load_embedding_provider(db)
            if provider is None or model_id is None or dim is None:
                await _set_status(
                    db,
                    custom_model_id=custom_model_id,
                    user_file_id=user_file_id,
                    status="failed",
                    error=(
                        "no embedding provider configured for this workspace; "
                        "an admin can pick one in Settings → Models"
                    ),
                )
                return

            # Hash short-circuit: skip the embed work entirely when
            # the file bytes haven't changed since the last successful
            # index. Saves a non-trivial cost on re-attaches.
            current_hash = file_content_hash(file)
            pivot = await db.get(CustomModelFile, (custom_model_id, user_file_id))
            if (
                not force
                and pivot is not None
                and pivot.indexed_content_hash == current_hash
                and pivot.indexing_status == "ready"
            ):
                logger.debug(
                    "index_file_for_custom_model: skipping %s — content hash unchanged",
                    user_file_id,
                )
                return

            # 1. Pull text out of the file (raises ValueError on
            #    unsupported / unparseable inputs).
            try:
                raw_text = extract_text_for_embedding(file)
            except ValueError as exc:
                await _set_status(
                    db,
                    custom_model_id=custom_model_id,
                    user_file_id=user_file_id,
                    status="failed",
                    error=str(exc),
                )
                return
            normalised = normalise_for_embedding(raw_text)
            if not normalised:
                await _set_status(
                    db,
                    custom_model_id=custom_model_id,
                    user_file_id=user_file_id,
                    status="failed",
                    error="no extractable text content in this file",
                )
                return

            # 2. Chunk + embed in batches.
            chunks = chunk_text(normalised)
            if not chunks:
                await _set_status(
                    db,
                    custom_model_id=custom_model_id,
                    user_file_id=user_file_id,
                    status="failed",
                    error="file produced no chunks (empty after normalisation)",
                )
                return

            embeddings: list[list[float]] = []
            for start in range(0, len(chunks), EMBED_BATCH_SIZE):
                batch = chunks[start : start + EMBED_BATCH_SIZE]
                vecs = await embed_texts(
                    provider=provider,
                    model_id=model_id,
                    texts=[c.text for c in batch],
                )
                if len(vecs) != len(batch):
                    raise RuntimeError(
                        f"embedding provider returned {len(vecs)} vectors "
                        f"for {len(batch)} inputs"
                    )
                # Defensive: if a provider unexpectedly returned a
                # different dimension than configured, fail loudly
                # rather than write a row that will mismatch the
                # vector column type.
                if vecs and len(vecs[0]) != dim:
                    raise RuntimeError(
                        f"embedding provider returned dim={len(vecs[0])} "
                        f"but workspace is configured for dim={dim}"
                    )
                embeddings.extend(vecs)

            # 3. Atomic-ish swap: drop old chunks, then insert new.
            #    A crash between the two leaves the file with an empty
            #    index (status=failed via the except path) — the admin
            #    can retry from the UI.
            await _delete_existing_chunks(
                db,
                custom_model_id=custom_model_id,
                user_file_id=user_file_id,
            )
            await _insert_chunks(
                db,
                custom_model_id=custom_model_id,
                user_file_id=user_file_id,
                chunks=chunks,
                embeddings=embeddings,
                embedding_model=model_id,
                embedding_dim=dim,
            )
            await _set_status(
                db,
                custom_model_id=custom_model_id,
                user_file_id=user_file_id,
                status="ready",
                indexed_hash=current_hash,
            )
            logger.info(
                "indexed %d chunks for custom_model=%s file=%s",
                len(chunks),
                custom_model_id,
                user_file_id,
            )
        except Exception as exc:  # noqa: BLE001 - last-line catch
            logger.exception("index_file_for_custom_model failed")
            try:
                await _set_status(
                    db,
                    custom_model_id=custom_model_id,
                    user_file_id=user_file_id,
                    status="failed",
                    error=f"{type(exc).__name__}: {exc}",
                )
            except Exception:  # noqa: BLE001 - don't mask the real failure
                pass


async def reembed_custom_model(custom_model_id: uuid.UUID) -> None:
    """Re-index every file attached to ``custom_model_id``.

    Called when the admin changes the workspace's embedding provider —
    the existing chunks are now in the wrong vector dim and have to
    be regenerated.
    """
    async with SessionLocal() as db:
        rows = await db.execute(
            select(CustomModelFile.user_file_id).where(
                CustomModelFile.custom_model_id == custom_model_id
            )
        )
        file_ids = [row[0] for row in rows.all()]
    for fid in file_ids:
        await index_file_for_custom_model(custom_model_id, fid, force=True)
