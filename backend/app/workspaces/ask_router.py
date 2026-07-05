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
    # Deep-citation anchor (4.2): opening text of the best-matching chunk
    # so the client can scroll-to-highlight the cited passage.
    snippet: str | None = None


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

    citations = []
    for idx, fid in enumerate(order, start=1):
        citation = await _resolve_citation(db, ws.id, idx, fid)
        # Deep-citation anchor (4.2): the best chunk's opening text lets
        # the note pane scroll straight to the cited passage.
        citation.snippet = (by_file[fid][0] or "")[:240] or None
        citations.append(citation)
    return AskResponse(
        answer=answer or "(no answer)", citations=citations
    )


# ---------------------------------------------------------------------
# Workspace search (Batch 4.3) — one box over titles, full text, and
# semantic similarity. Complements ⌘K (fuzzy titles only) and Ask
# (synthesised answer): search shows you *where things are said*.
# ---------------------------------------------------------------------
class SearchHit(BaseModel):
    # 'title' | 'text' | 'semantic'
    source: str
    item_id: uuid.UUID | None
    ref_id: uuid.UUID | None
    kind: str
    title: str
    # For 'text' hits this is a ts_headline fragment containing <mark>
    # tags (and nothing else); plain text for the other sources.
    snippet: str = ""
    score: float = 0.0


class SearchResponse(BaseModel):
    hits: list[SearchHit] = Field(default_factory=list)
    semantic_available: bool = False


async def _visible_item_file_map(
    db: AsyncSession, workspace_id: uuid.UUID, user: User
) -> dict[uuid.UUID, tuple[uuid.UUID | None, uuid.UUID | None, str, str]]:
    """file_id → (item_id, open_ref_id, kind, title) for everything the
    caller may see: item backing files (notes/boards on ``ref_id``,
    canvases/sheets on ``text_file_id``) plus pinned Drive files. Other
    people's private drafts (0134) are omitted, which downstream turns
    into a hard filter for text + semantic hits."""
    from sqlalchemy import or_ as sa_or

    from app.chat.models import Spreadsheet, WorkspaceFile

    out: dict[uuid.UUID, tuple[uuid.UUID | None, uuid.UUID | None, str, str]] = {}
    visible = sa_or(
        WorkspaceItem.visibility != "private",
        WorkspaceItem.created_by == user.id,
    )
    items = (
        (
            await db.execute(
                select(WorkspaceItem).where(
                    WorkspaceItem.workspace_id == workspace_id,
                    WorkspaceItem.archived_at.is_(None),
                    visible,
                )
            )
        )
        .scalars()
        .all()
    )
    canvas_files = {
        c.id: c.text_file_id
        for c in (
            await db.execute(
                select(WorkspaceCanvas).where(
                    WorkspaceCanvas.workspace_id == workspace_id
                )
            )
        ).scalars()
    }
    sheet_files = {
        s.id: s.text_file_id
        for s in (
            await db.execute(
                select(Spreadsheet).where(
                    Spreadsheet.workspace_id == workspace_id
                )
            )
        ).scalars()
    }
    for it in items:
        if it.kind in ("note", "board") and it.ref_id is not None:
            out[it.ref_id] = (it.id, it.ref_id, it.kind, it.title)
        elif it.kind == "canvas" and it.ref_id in canvas_files:
            fid = canvas_files[it.ref_id]
            if fid is not None:
                out[fid] = (it.id, it.ref_id, "canvas", it.title)
        elif it.kind == "sheet" and it.ref_id in sheet_files:
            fid = sheet_files[it.ref_id]
            if fid is not None:
                out[fid] = (it.id, it.ref_id, "sheet", it.title)
    from app.workspaces.knowledge import WORKSPACE_MEMORY_SOURCE_KIND

    pins = (
        await db.execute(
            select(WorkspaceFile.file_id, UserFile.filename)
            .join(UserFile, UserFile.id == WorkspaceFile.file_id)
            .where(
                WorkspaceFile.workspace_id == workspace_id,
                # The auto-maintained memory doc is hidden everywhere else
                # (Drive, hub counts) — keep it out of search hits too.
                sa_or(
                    UserFile.source_kind.is_(None),
                    UserFile.source_kind != WORKSPACE_MEMORY_SOURCE_KIND,
                ),
            )
        )
    ).all()
    for file_id, filename in pins:
        out.setdefault(file_id, (None, file_id, "file", filename))
    return out


@router.get("/{workspace_id}/search", response_model=SearchResponse)
async def search_workspace(
    workspace_id: uuid.UUID,
    q: str,
    limit: int = 30,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SearchResponse:
    """Three passes, merged: item-title matches, Postgres FTS over the
    workspace's backing/pinned files (with ``<mark>`` headlines), and
    embedding similarity (when configured). Deduped per item, titles
    first, then FTS by rank, then any semantic-only stragglers."""
    from sqlalchemy import desc, func as sa_func, literal_column, or_ as sa_or

    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    q = (q or "").strip()
    if len(q) < 2:
        return SearchResponse(hits=[], semantic_available=False)
    limit = max(1, min(60, limit))

    hits: list[SearchHit] = []
    seen_items: set[uuid.UUID] = set()
    seen_files: set[uuid.UUID] = set()

    # 1) Title matches (cheap, exact-feeling).
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    title_rows = (
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.archived_at.is_(None),
                    WorkspaceItem.kind != "folder",
                    WorkspaceItem.title.ilike(f"%{escaped}%", escape="\\"),
                    sa_or(
                        WorkspaceItem.visibility != "private",
                        WorkspaceItem.created_by == user.id,
                    ),
                )
                .order_by(WorkspaceItem.title.asc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    for it in title_rows:
        seen_items.add(it.id)
        hits.append(
            SearchHit(
                source="title",
                item_id=it.id,
                ref_id=it.ref_id,
                kind=it.kind,
                title=it.title,
                score=1.0,
            )
        )

    file_map = await _visible_item_file_map(db, ws.id, user)

    # 2) Full-text over backing + pinned files (GIN ``content_tsv``).
    if file_map:
        content_tsv = literal_column("content_tsv")
        tsquery = sa_func.websearch_to_tsquery("english", q)
        rank_expr = sa_func.ts_rank(content_tsv, tsquery)
        headline_expr = sa_func.ts_headline(
            "english",
            sa_func.coalesce(UserFile.content_text, UserFile.filename),
            tsquery,
            "StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=8, MaxFragments=1",
        )
        fts_rows = (
            await db.execute(
                select(UserFile.id, rank_expr, headline_expr)
                .where(
                    UserFile.id.in_(list(file_map.keys())),
                    UserFile.trashed_at.is_(None),
                    content_tsv.op("@@")(tsquery),
                )
                .order_by(desc(rank_expr))
                .limit(limit)
            )
        ).all()
        for file_id, rank, snippet in fts_rows:
            item_id, ref_id, kind, title = file_map[file_id]
            if item_id is not None and item_id in seen_items:
                continue
            if item_id is not None:
                seen_items.add(item_id)
            seen_files.add(file_id)
            hits.append(
                SearchHit(
                    source="text",
                    item_id=item_id,
                    ref_id=ref_id,
                    kind=kind,
                    title=title,
                    snippet=str(snippet or "")[:400],
                    score=float(rank or 0.0),
                )
            )

    # 3) Semantic stragglers — meaning-matches that share no keywords.
    semantic_available = False
    try:
        chunks = await retrieve_workspace_context(
            db, workspace_id=ws.id, query=q, top_k=8
        )
        semantic_available = bool(chunks)
        for chunk in chunks:
            if chunk.score < 0.35:
                continue  # below this it's noise, not a result
            mapped = file_map.get(chunk.user_file_id)
            if mapped is None:
                continue  # private / archived / no longer visible
            item_id, ref_id, kind, title = mapped
            if (item_id is not None and item_id in seen_items) or (
                chunk.user_file_id in seen_files
            ):
                continue
            if item_id is not None:
                seen_items.add(item_id)
            seen_files.add(chunk.user_file_id)
            hits.append(
                SearchHit(
                    source="semantic",
                    item_id=item_id,
                    ref_id=ref_id,
                    kind=kind,
                    title=title,
                    snippet=chunk.text[:240],
                    score=chunk.score,
                )
            )
    except Exception:  # pragma: no cover — semantic is best-effort
        pass

    return SearchResponse(
        hits=hits[:limit], semantic_available=semantic_available
    )


# ---------------------------------------------------------------------
# Related items (Batch 4.5) — embedding-nearest neighbours of an item,
# for the "Related" strip under notes. Turns the workspace into a
# knowledge graph without requiring wiki-link discipline.
# ---------------------------------------------------------------------
class RelatedItem(BaseModel):
    item_id: uuid.UUID
    ref_id: uuid.UUID | None
    kind: str
    title: str
    score: float


class RelatedResponse(BaseModel):
    items: list[RelatedItem] = Field(default_factory=list)


@router.get(
    "/{workspace_id}/items/{item_id}/related", response_model=RelatedResponse
)
async def related_items(
    workspace_id: uuid.UUID,
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> RelatedResponse:
    """Semantic neighbours of ``item_id`` among the caller-visible pool.

    The query is the item's title + the head of its own indexed text —
    cheap, no new embeddings stored, and empty (never an error) when
    embeddings aren't configured."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    item = await db.get(WorkspaceItem, item_id)
    if item is None or item.workspace_id != ws.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Item not found"
        )
    from app.workspaces.items_router import require_item_visible

    require_item_visible(item, user)

    file_map = await _visible_item_file_map(db, ws.id, user)
    own_file_id = next(
        (fid for fid, (iid, _r, _k, _t) in file_map.items() if iid == item.id),
        None,
    )
    query = item.title or ""
    if own_file_id is not None:
        uf = await db.get(UserFile, own_file_id)
        if uf is not None and uf.content_text:
            query = f"{query}\n{uf.content_text[:1200]}"
    if len(query.strip()) < 3:
        return RelatedResponse(items=[])

    try:
        chunks = await retrieve_workspace_context(
            db, workspace_id=ws.id, query=query, top_k=10
        )
    except Exception:  # pragma: no cover — best-effort
        return RelatedResponse(items=[])

    out: list[RelatedItem] = []
    seen: set[uuid.UUID] = {item.id}
    for chunk in chunks:
        if chunk.score < 0.35:
            continue
        mapped = file_map.get(chunk.user_file_id)
        if mapped is None:
            continue
        rel_item_id, ref_id, kind, title = mapped
        if rel_item_id is None or rel_item_id in seen:
            continue
        seen.add(rel_item_id)
        out.append(
            RelatedItem(
                item_id=rel_item_id,
                ref_id=ref_id,
                kind=kind,
                title=title,
                score=chunk.score,
            )
        )
        if len(out) >= 4:
            break
    return RelatedResponse(items=out)


__all__ = ["router"]
