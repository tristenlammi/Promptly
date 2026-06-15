"""Workspace graph view (Phase 5).

``GET /api/workspaces/{wid}/graph`` returns the workspace as a graph:
nodes are its items (notes, canvases, chats) and edges are either
**explicit** wiki-links (``[[`` references between notes) or **semantic**
neighbours (nearest items by embedding similarity). The semantic edges
are the "better than Obsidian" part — they surface connections the user
never typed. Best-effort: when embeddings aren't configured, the graph
degrades to explicit links only.
"""
from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Conversation, WorkspaceCanvas, WorkspaceItem
from app.chat.semantic_search import get_embedding_config
from app.custom_models.retrieval import retrieve_workspace_context
from app.database import get_db
from app.files.models import UserFile
from app.files.storage import absolute_path
from app.workspaces.shares import get_accessible_workspace

router = APIRouter()

_UUID_RE = re.compile(
    r"item=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
_MAX_CONTENT_NODES = 40   # nodes we'll run a semantic neighbour query for
_SEMANTIC_NEIGHBOURS = 2  # top-N similar items per content node
_MAX_SEMANTIC_EDGES = 80


class GraphNode(BaseModel):
    id: uuid.UUID
    kind: str  # 'note' | 'canvas' | 'chat'
    ref_id: uuid.UUID | None
    title: str


class GraphEdge(BaseModel):
    source: uuid.UUID
    target: uuid.UUID
    kind: str  # 'link' | 'similar'


class WorkspaceGraph(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)


@router.get("/{workspace_id}/graph", response_model=WorkspaceGraph)
async def workspace_graph(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceGraph:
    ws, _role = await get_accessible_workspace(workspace_id, user, db)

    # --- Nodes -----------------------------------------------------------
    items = list(
        (
            await db.execute(
                select(WorkspaceItem)
                .where(
                    WorkspaceItem.workspace_id == ws.id,
                    WorkspaceItem.kind.in_(("note", "canvas")),
                    WorkspaceItem.archived_at.is_(None),
                )
                .order_by(WorkspaceItem.position.asc())
            )
        ).scalars()
    )
    convs = list(
        (
            await db.execute(
                select(Conversation)
                .where(
                    Conversation.workspace_id == ws.id,
                    Conversation.archived_at.is_(None),
                )
                .order_by(Conversation.updated_at.desc())
            )
        ).scalars()
    )

    nodes: list[GraphNode] = [
        GraphNode(id=it.id, kind=it.kind, ref_id=it.ref_id, title=it.title)
        for it in items
    ]
    nodes.extend(
        GraphNode(id=c.id, kind="chat", ref_id=c.id, title=c.title or "New chat")
        for c in convs
    )
    node_ids = {n.id for n in nodes}

    # Map a chunk's backing file id → the node it belongs to (notes ride
    # their document id; canvases their backing text file id).
    file_to_node: dict[uuid.UUID, uuid.UUID] = {}
    note_items = [it for it in items if it.kind == "note" and it.ref_id]
    for it in note_items:
        if it.ref_id is not None:
            file_to_node[it.ref_id] = it.id
    canvas_items = [it for it in items if it.kind == "canvas" and it.ref_id]
    for it in canvas_items:
        canvas = await db.get(WorkspaceCanvas, it.ref_id)
        if canvas is not None and canvas.text_file_id is not None:
            file_to_node[canvas.text_file_id] = it.id

    edges: list[GraphEdge] = []

    # --- Explicit wiki-link edges (scan note HTML for item=<id>) ---------
    for it in note_items:
        if it.ref_id is None:
            continue
        uf = await db.get(UserFile, it.ref_id)
        if uf is None:
            continue
        try:
            html = absolute_path(uf.storage_path).read_text(encoding="utf-8")
        except OSError:
            continue
        for raw in set(_UUID_RE.findall(html)):
            try:
                target = uuid.UUID(raw)
            except ValueError:
                continue
            if target in node_ids and target != it.id:
                edges.append(
                    GraphEdge(source=it.id, target=target, kind="link")
                )

    # --- Semantic edges (nearest items by embedding) --------------------
    cfg = await get_embedding_config(db)
    if cfg is not None:
        seen_pairs: set[tuple[str, str]] = set()
        content_nodes = (items)[:_MAX_CONTENT_NODES]
        for it in content_nodes:
            if len(edges) >= _MAX_SEMANTIC_EDGES + len(node_ids):
                break
            # Query text for the item.
            query = ""
            if it.kind == "note" and it.ref_id is not None:
                uf = await db.get(UserFile, it.ref_id)
                query = (uf.content_text or "") if uf else ""
            elif it.kind == "canvas" and it.ref_id is not None:
                canvas = await db.get(WorkspaceCanvas, it.ref_id)
                query = (canvas.content_text or "") if canvas else ""
            query = query.strip()
            if not query:
                continue
            try:
                chunks = await retrieve_workspace_context(
                    db, workspace_id=ws.id, query=query[:1000], top_k=6
                )
            except Exception:  # noqa: BLE001 - best-effort
                continue
            added = 0
            for ch in chunks:
                if added >= _SEMANTIC_NEIGHBOURS:
                    break
                target = file_to_node.get(ch.user_file_id)
                if target is None or target == it.id:
                    continue
                pair = tuple(sorted((str(it.id), str(target))))
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                edges.append(
                    GraphEdge(source=it.id, target=target, kind="similar")
                )
                added += 1

    return WorkspaceGraph(nodes=nodes, edges=edges)


__all__ = ["router"]
