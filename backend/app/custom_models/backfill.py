"""Catch up on everything that couldn't be embedded (R-261, R-268, R-321).

With no embedder configured — or one that was down — workspace files and
items stayed "queued" or "failed" for good, and saved memories stayed
without a vector, so they dropped out of retrieval. This goes back for
them: right after the embedding setup changes, every hour (in-process, so
it yields to chat query embeds through the fairness gate), and nightly.

A model switch re-embeds everything (R-317): ``mark_all_for_reembed``
queues every indexed file, item and chat, and drops chat-attachment
chunks (those fall back to the inline attachment text until re-attached).
Retrieval keeps to the current model's vectors meanwhile, so stale ones
just drop out instead of returning nonsense.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import func, or_, select, text, update

from app.chat.models import Conversation, WorkspaceFile, WorkspaceItem
from app.chat.semantic_search import get_embedding_config
from app.database import SessionLocal
from app.memory.models import UserMemory

logger = logging.getLogger("promptly.embedding.backfill")

_PENDING = ("queued", "failed")
_INDEXED = ("ready", "failed", "embedding", "queued")

# Item kinds with their own indexer (knowledge.index_<kind>_for_workspace).
_ITEM_KINDS = ("note", "canvas", "sheet", "roster", "board", "discussion")

_RECONCILE_SECONDS = 3600.0


def _item_indexer(kind: str):
    from app.workspaces import knowledge

    return getattr(knowledge, f"index_{kind}_for_workspace", None)


def _memory_stale(cfg):
    return or_(
        UserMemory.embed_dim.is_(None),
        UserMemory.embed_dim != cfg.dim,
        UserMemory.embed_model.is_distinct_from(cfg.model_id),
    )


async def backfill_embeddings(
    *, max_items: int = 500, max_memories: int = 2000, include_vision: bool = True
) -> dict[str, Any]:
    """One pass over everything pending. ``include_vision=False`` (the
    hourly run) skips images and other non-text files still queued: they
    wait for a vision relay and would cost a describe call every hour."""
    from app.custom_models import embedding_gate
    from app.custom_models.embedding import is_text_extractable
    from app.files.models import UserFile
    from app.memory.service import embed_memory_row
    from app.workspaces.knowledge import (
        index_automations_for_workspace,
        index_chat_for_workspace,
        index_file_for_workspace,
    )

    embedding_gate.mark_background()
    async with SessionLocal() as db:
        cfg = await get_embedding_config(db)
        if cfg is None:
            return {"skipped": "no embedding model configured"}
        file_rows = (
            await db.execute(
                select(WorkspaceFile.workspace_id, WorkspaceFile.file_id, UserFile)
                .join(UserFile, UserFile.id == WorkspaceFile.file_id)
                .where(WorkspaceFile.indexing_status.in_(_PENDING))
                .limit(max_items)
            )
        ).all()
        files = [
            (ws_id, fid)
            for ws_id, fid, uf in file_rows
            if include_vision or is_text_extractable(uf)
        ]
        items = (
            await db.execute(
                select(WorkspaceItem.workspace_id, WorkspaceItem.id, WorkspaceItem.kind)
                .where(
                    WorkspaceItem.kind.in_(_ITEM_KINDS),
                    WorkspaceItem.indexing_status.in_(_PENDING),
                    WorkspaceItem.trashed_at.is_(None),
                )
                .limit(max_items)
            )
        ).all()
        chats = (
            await db.execute(
                select(Conversation.workspace_id, Conversation.id).where(
                    Conversation.workspace_id.is_not(None),
                    Conversation.context_enabled.is_(True),
                    Conversation.context_index_status.in_(_PENDING),
                )
                .limit(max_items)
            )
        ).all()
        # Workspaces still holding chunks from another model — the
        # automations digest has no status column of its own.
        stale_ws = list(
            (
                await db.execute(
                    text(
                        """
                        SELECT DISTINCT workspace_id FROM knowledge_chunks
                        WHERE workspace_id IS NOT NULL
                          AND embedding_model IS DISTINCT FROM :m
                        LIMIT 200
                        """
                    ),
                    {"m": cfg.model_id},
                )
            ).scalars()
        )
        memory_ids = list(
            (
                await db.execute(select(UserMemory.id).where(_memory_stale(cfg)).limit(max_memories))
            ).scalars()
        )

    done = {"files": 0, "items": 0, "chats": 0, "automations": 0, "memories": 0}
    for ws_id, file_id in files:
        try:
            await index_file_for_workspace(ws_id, file_id, force=True)
            done["files"] += 1
        except Exception:  # noqa: BLE001 — one bad file mustn't stop the rest
            logger.exception("backfill: file %s failed", file_id)
    for ws_id, item_id, kind in items:
        fn = _item_indexer(kind)
        if fn is None:
            continue
        try:
            await fn(ws_id, item_id, force=True)
            done["items"] += 1
        except Exception:  # noqa: BLE001
            logger.exception("backfill: %s %s failed", kind, item_id)
    for ws_id, conv_id in chats:
        try:
            await index_chat_for_workspace(ws_id, conv_id, force=True)
            done["chats"] += 1
        except Exception:  # noqa: BLE001
            logger.exception("backfill: chat %s failed", conv_id)
    for ws_id in stale_ws:
        try:
            await index_automations_for_workspace(ws_id, force=True)
            done["automations"] += 1
        except Exception:  # noqa: BLE001
            logger.exception("backfill: automations for %s failed", ws_id)
    async with SessionLocal() as db:
        for mid in memory_ids:
            row = await db.get(UserMemory, mid)
            if row is None:
                continue
            try:
                if await embed_memory_row(db, row, cfg):
                    done["memories"] += 1
                    await db.commit()
            except Exception:  # noqa: BLE001
                await db.rollback()
                logger.exception("backfill: memory %s failed", mid)
    logger.info("Embedding backfill: %s", done)
    return done


async def mark_all_for_reembed(db, *, model_id: str | None) -> None:
    """The embedding model or dimension changed: queue every indexed file,
    item and chat for a fresh embed (their content hashes are cleared so
    the "unchanged, skip" check can't fire), and drop chat-attachment
    chunks made by another model. The caller commits."""
    await db.execute(
        update(WorkspaceFile)
        .where(WorkspaceFile.indexing_status.in_(_INDEXED))
        .values(indexing_status="queued", indexed_content_hash=None)
    )
    await db.execute(
        update(WorkspaceItem)
        .where(
            WorkspaceItem.kind.in_(_ITEM_KINDS),
            WorkspaceItem.indexing_status.in_(_INDEXED),
            WorkspaceItem.trashed_at.is_(None),
        )
        .values(indexing_status="queued", indexed_content_hash=None)
    )
    await db.execute(
        update(Conversation)
        .where(
            Conversation.workspace_id.is_not(None),
            Conversation.context_enabled.is_(True),
            Conversation.context_index_status.in_(_INDEXED),
        )
        .values(context_index_status="queued", context_indexed_hash=None)
    )
    await db.execute(
        text(
            """
            DELETE FROM knowledge_chunks
            WHERE conversation_id IS NOT NULL
              AND embedding_model IS DISTINCT FROM :m
            """
        ),
        {"m": model_id},
    )


async def pending_counts(db) -> dict[str, int]:
    """What's still waiting for the current embedder — the admin card's
    re-index progress (R-321)."""
    cfg = await get_embedding_config(db)
    files = await db.scalar(
        select(func.count()).select_from(WorkspaceFile).where(
            WorkspaceFile.indexing_status.in_(("queued", "embedding"))
        )
    )
    items = await db.scalar(
        select(func.count()).select_from(WorkspaceItem).where(
            WorkspaceItem.kind.in_(_ITEM_KINDS),
            WorkspaceItem.indexing_status.in_(("queued", "embedding")),
            WorkspaceItem.trashed_at.is_(None),
        )
    )
    failed = await db.scalar(
        select(func.count()).select_from(WorkspaceItem).where(
            WorkspaceItem.kind.in_(_ITEM_KINDS),
            WorkspaceItem.indexing_status == "failed",
            WorkspaceItem.trashed_at.is_(None),
        )
    )
    failed = int(failed or 0) + int(
        await db.scalar(
            select(func.count()).select_from(WorkspaceFile).where(
                WorkspaceFile.indexing_status == "failed"
            )
        )
        or 0
    )
    memories = 0
    if cfg is not None:
        memories = int(
            await db.scalar(select(func.count()).select_from(UserMemory).where(_memory_stale(cfg)))
            or 0
        )
    return {
        "files": int(files or 0),
        "items": int(items or 0),
        "memories": memories,
        "failed": failed,
    }


async def recover_interrupted_indexing() -> int:
    """At start-up: files, items and chats left "embedding" by a restart
    mid-index go back to "queued", and the back-fill picks them up. They
    used to stay "embedding" for good (R-178)."""
    async with SessionLocal() as db:
        files = await db.execute(
            update(WorkspaceFile).where(WorkspaceFile.indexing_status == "embedding").values(indexing_status="queued")
        )
        items = await db.execute(
            update(WorkspaceItem).where(WorkspaceItem.indexing_status == "embedding").values(indexing_status="queued")
        )
        chats = await db.execute(
            update(Conversation)
            .where(Conversation.context_index_status == "embedding")
            .values(context_index_status="queued")
        )
        await db.commit()
        cfg = await get_embedding_config(db)
    reset = (files.rowcount or 0) + (items.rowcount or 0) + (chats.rowcount or 0)
    if reset and cfg is not None:
        start_backfill()
    return reset


def start_backfill() -> None:
    """Run the backfill in the background (single worker: in-process)."""
    from app.background import spawn

    spawn(backfill_embeddings(), name="embedding-backfill")


async def _reconcile_loop() -> None:
    while True:
        await asyncio.sleep(_RECONCILE_SECONDS)
        try:
            await backfill_embeddings(max_items=200, max_memories=500, include_vision=False)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — never let the loop die
            logger.exception("Hourly embedding reconcile failed")


def start_embedding_reconciler() -> asyncio.Task:
    """Hourly retry of anything queued or failed while an embedder is set
    up (R-321). Called from the app lifespan."""
    return asyncio.create_task(_reconcile_loop(), name="embedding_reconciler")
