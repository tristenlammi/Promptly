"""Conversation-scoped attachment RAG (Phase 9 / J2).

When a chat's attachments are too large to inline, the user can choose to
*index them for this chat* instead. We chunk + embed the attachment files
into the shared ``knowledge_chunks`` table under the ``conversation``
scope, then at send time retrieve only the relevant chunks for the user's
question — so a long document isn't truncated at 64 KB and the context
window isn't blown.

This reuses the existing workspace/custom-model RAG machinery wholesale
(chunker, embedder, insert/delete, similarity search); it only adds the
conversation scope + a thin orchestration layer. Chunks cascade-delete
with the conversation (FK ``ON DELETE CASCADE``), so the index is cleaned
up automatically — no sweeper needed.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.semantic_search import get_embedding_config
from app.custom_models.ingestion import (
    delete_existing_chunks,
    embed_file_to_chunks,
    insert_chunks,
)
from app.custom_models.retrieval import (
    format_retrieved_block,
    retrieve_conversation_context,
)
from app.files.models import UserFile

logger = logging.getLogger("promptly.chat.attachment_rag")

# How many chunks to pull back per turn. A little higher than the workspace
# default since an attachment set is usually the user's primary focus.
ATTACHMENT_RAG_TOP_K = 8


async def index_attachments_for_conversation(
    db: AsyncSession,
    *,
    conversation_id: uuid.UUID,
    files: list[UserFile],
    interactive: bool = False,
) -> int:
    """Chunk + embed ``files`` into the conversation's RAG scope.

    Returns the number of files actually indexed. A no-op (returns 0) when
    no embedding provider is configured — the caller then falls back to the
    normal inline-preamble path. Non-text-extractable files (images) are
    skipped silently; they ride the vision/caption path instead.
    """
    cfg = await get_embedding_config(db)
    if cfg is None:
        logger.info(
            "attachment_rag: no embedder configured; skipping indexing for %s",
            conversation_id,
        )
        return 0

    indexed = 0
    for f in files:
        try:
            chunks, embeddings = await embed_file_to_chunks(
                f,
                provider=cfg.provider,
                model_id=cfg.model_id,
                dim=cfg.dim,
                interactive=interactive,
            )
        except (ValueError, RuntimeError) as e:
            # ValueError: not text-extractable (image/binary) or empty.
            # RuntimeError: provider returned a wrong-dim vector.
            logger.info("attachment_rag: skipped %s (%s)", f.id, e)
            continue
        except Exception:  # noqa: BLE001 — one bad file shouldn't fail the turn
            logger.exception("attachment_rag: failed embedding %s", f.id)
            continue
        if not chunks:
            continue
        await delete_existing_chunks(
            db,
            scope_kind="conversation",
            scope_id=conversation_id,
            user_file_id=f.id,
            commit=False,
        )
        await insert_chunks(
            db,
            scope_kind="conversation",
            scope_id=conversation_id,
            user_file_id=f.id,
            chunks=chunks,
            embeddings=embeddings,
            embedding_model=cfg.model_id,
            embedding_dim=cfg.dim,
        )
        indexed += 1

    logger.info(
        "attachment_rag: indexed %d/%d files for conversation %s",
        indexed,
        len(files),
        conversation_id,
    )
    return indexed


async def index_turn_attachments(
    conversation_id: uuid.UUID, file_ids: list[uuid.UUID], *, interactive: bool = False
) -> int:
    """Index a turn's documents for the rest of the conversation.

    Runs in the background after the reply, with its own session. The turn
    that brought the file has it inline; every later turn retrieves from it
    here. Without this, "summarise this contract" then "what does clause 7
    say?" was answered without the contract (R-045). A no-op without an
    embedder — later turns then re-send the file instead.
    """
    from app.database import SessionLocal

    if not file_ids:
        return 0
    try:
        async with SessionLocal() as db:
            already = await conversation_indexed_file_ids(db, conversation_id)
            wanted = [fid for fid in file_ids if fid not in already]
            if not wanted:
                return 0
            files = list(
                (await db.execute(select(UserFile).where(UserFile.id.in_(wanted)))).scalars()
            )
            n = await index_attachments_for_conversation(
                db, conversation_id=conversation_id, files=files, interactive=interactive
            )
            await db.commit()
            return n
    except Exception:  # noqa: BLE001 — background best effort
        logger.exception("attachment_rag: indexing turn files failed for %s", conversation_id)
        return 0


async def conversation_indexed_file_ids(
    db: AsyncSession, conversation_id: uuid.UUID
) -> set[uuid.UUID]:
    """File ids that have indexed chunks in this conversation's RAG scope.

    Used at send time so the inline-attachment preamble can *skip* these
    files (their content comes from retrieval instead) — avoiding both the
    64 KB truncation and double-feeding."""
    # Only chunks from the current embedding model count: after a switch the
    # old ones can't be retrieved, and the file must be inlined instead of
    # silently dropped (R-319).
    rows = await db.execute(
        text(
            "SELECT DISTINCT kc.user_file_id FROM knowledge_chunks kc "
            "JOIN app_settings s ON s.embedding_model_id = kc.embedding_model "
            "WHERE kc.conversation_id = :cid"
        ),
        {"cid": str(conversation_id)},
    )
    return {r[0] for r in rows.all()}


async def attachment_rag_block(
    db: AsyncSession, *, conversation_id: uuid.UUID, query: str
) -> str:
    """Retrieve relevant attachment chunks for ``query`` and format them as
    a system-prompt knowledge block. Empty string when nothing indexed /
    nothing relevant / no embedder."""
    chunks = await retrieve_conversation_context(
        db,
        conversation_id=conversation_id,
        query=query,
        top_k=ATTACHMENT_RAG_TOP_K,
    )
    return format_retrieved_block(chunks)


__all__ = [
    "index_attachments_for_conversation",
    "conversation_indexed_file_ids",
    "attachment_rag_block",
    "ATTACHMENT_RAG_TOP_K",
]
