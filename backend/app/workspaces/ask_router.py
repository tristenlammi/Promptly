"""Ask-this-workspace — grounded Q&A across a workspace's knowledge (Phase 3).

One endpoint, ``POST /api/workspaces/{wid}/ask``, that retrieves the most
relevant chunks across the *whole* workspace pool (notes + canvases +
pinned files share one ``knowledge_chunks`` scope) and asks the model to
answer using only that context, returning citations that link back to the
source navigator item. This is the "second brain" payoff: ask the
workspace anything and get a cited answer.

Non-streaming for the MVP — the answer is collected and returned in one
shot (the volume is a short grounded answer, not a long generation), so
we don't have to thread through the SSE stream runner.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.app_settings.defaults import load_effective_defaults, org_id_of
from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Workspace, WorkspaceCanvas, WorkspaceItem
from app.custom_models.retrieval import retrieve_workspace_context
from app.database import get_db
from app.files.models import UserFile
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, model_router
from app.workspaces.shares import get_accessible_workspace

router = APIRouter()

_ASK_TOP_K = 8
_ASK_SYSTEM = (
    "You answer the user's question using ONLY the workspace context "
    "provided below. Cite the sources you use inline like [1], [2] — the "
    "numbers map to the labelled sources. If the context doesn't contain "
    "the answer, say you couldn't find it in this workspace rather than "
    "guessing. Be concise and direct."
)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)


class AskCitation(BaseModel):
    index: int
    # The navigator item to jump to (note/canvas). NULL for a pinned file
    # that isn't a first-class tree item.
    item_id: uuid.UUID | None
    # What the item opens by (document id for a note, canvas id for a
    # canvas, file id for a pinned file).
    ref_id: uuid.UUID | None
    kind: str  # 'note' | 'canvas' | 'file'
    title: str


class AskResponse(BaseModel):
    answer: str
    citations: list[AskCitation] = Field(default_factory=list)


async def _resolve_chat_model(
    db: AsyncSession, ws: Workspace
) -> tuple[ModelProvider | None, str | None]:
    """Provider + model to answer with: the workspace default if set and
    usable, else the app-wide default chat model."""
    if ws.default_provider_id and ws.default_model_id:
        provider = await db.get(ModelProvider, ws.default_provider_id)
        if provider is not None and provider.enabled:
            return provider, ws.default_model_id
    # Per-org default chat model, resolved via the workspace owner's org.
    eff = await load_effective_defaults(db, await org_id_of(db, ws.user_id))
    if eff.default_chat_configured:
        provider = await db.get(ModelProvider, eff.default_chat_provider_id)
        if provider is not None and provider.enabled:
            return provider, eff.default_chat_model_id
    return None, None


async def _resolve_citation(
    db: AsyncSession, workspace_id: uuid.UUID, index: int, file_id: uuid.UUID
) -> AskCitation:
    """Map a retrieved chunk's backing file to a navigator item citation."""
    # Note: the chunk file *is* the note's document (item.ref_id).
    note = (
        await db.execute(
            select(WorkspaceItem).where(
                WorkspaceItem.workspace_id == workspace_id,
                WorkspaceItem.kind == "note",
                WorkspaceItem.ref_id == file_id,
            )
        )
    ).scalars().first()
    if note is not None:
        return AskCitation(
            index=index,
            item_id=note.id,
            ref_id=note.ref_id,
            kind="note",
            title=note.title,
        )
    # Canvas: the chunk file is the canvas's backing text file.
    canvas = (
        await db.execute(
            select(WorkspaceCanvas).where(
                WorkspaceCanvas.workspace_id == workspace_id,
                WorkspaceCanvas.text_file_id == file_id,
            )
        )
    ).scalars().first()
    if canvas is not None:
        citem = (
            await db.execute(
                select(WorkspaceItem).where(
                    WorkspaceItem.workspace_id == workspace_id,
                    WorkspaceItem.kind == "canvas",
                    WorkspaceItem.ref_id == canvas.id,
                )
            )
        ).scalars().first()
        return AskCitation(
            index=index,
            item_id=citem.id if citem else None,
            ref_id=canvas.id,
            kind="canvas",
            title=citem.title if citem else canvas.title,
        )
    # Otherwise a pinned file — cite by filename, no tree item.
    uf = await db.get(UserFile, file_id)
    return AskCitation(
        index=index,
        item_id=None,
        ref_id=file_id,
        kind="file",
        title=uf.filename if uf is not None else "File",
    )


@router.post("/{workspace_id}/ask", response_model=AskResponse)
async def ask_workspace(
    workspace_id: uuid.UUID,
    payload: AskRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> AskResponse:
    ws, _role = await get_accessible_workspace(workspace_id, user, db)

    chunks = await retrieve_workspace_context(
        db, workspace_id=ws.id, query=payload.question, top_k=_ASK_TOP_K
    )
    if not chunks:
        return AskResponse(
            answer=(
                "I couldn't find anything about that in this workspace yet. "
                "Add notes, canvases, or files (and let them index) and try "
                "again."
            ),
            citations=[],
        )

    # Group chunks by source file, preserving best-score order, and number
    # each distinct source for the citation map.
    order: list[uuid.UUID] = []
    by_file: dict[uuid.UUID, list[str]] = {}
    names: dict[uuid.UUID, str] = {}
    for c in chunks:
        if c.user_file_id not in by_file:
            by_file[c.user_file_id] = []
            order.append(c.user_file_id)
            names[c.user_file_id] = c.filename or "Source"
        by_file[c.user_file_id].append(c.text)

    blocks = []
    for idx, fid in enumerate(order, start=1):
        joined = "\n".join(by_file[fid])
        blocks.append(f"[{idx}] {names[fid]}\n{joined}")
    context = "\n\n".join(blocks)

    provider, model_id = await _resolve_chat_model(db, ws)
    if provider is None or model_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model is configured to answer with. Set a default model "
                "on the workspace (or an admin can set an app default)."
            ),
        )

    user_msg = f"Workspace context:\n{context}\n\nQuestion: {payload.question}"
    try:
        parts: list[str] = []
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=user_msg)],
            system=_ASK_SYSTEM,
            temperature=0.2,
            max_tokens=900,
        ):
            parts.append(token)
        answer = "".join(parts).strip()
    except Exception as exc:  # noqa: BLE001 - surface a clean 502
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The model couldn't be reached to answer.",
        ) from exc

    citations = [
        await _resolve_citation(db, ws.id, idx, fid)
        for idx, fid in enumerate(order, start=1)
    ]
    return AskResponse(
        answer=answer or "(no answer)", citations=citations
    )


__all__ = ["router"]
