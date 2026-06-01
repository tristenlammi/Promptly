"""search_emails chat tool (Phase 12 — E.1).

Allows the model to semantically search the user's email corpus via the
email_chunks pgvector table. Only included in the model's tool schema when
the user is explicitly in "email context" (toggled the Email button under ⋯,
or @-mentioned a person/email). Never auto-injected into ordinary chat turns.

The tool uses the same pgvector cosine similarity pattern as the Custom Models
RAG retrieval (app/custom_models/retrieval.py) but targets email_chunks.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text

from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.chat.semantic_search import get_embedding_config
from app.custom_models.embedding import embed_texts, normalise_for_embedding

logger = logging.getLogger("promptly.chat.tools.search_emails")

_MAX_RESULTS = 8
_MIN_SCORE = 0.30  # cosine similarity floor (keeps unrelated results out)


class SearchEmailsTool(Tool):
    name = "search_emails"
    category = "email"
    description = (
        "Search the user's email history semantically. Use this when the user "
        "asks about emails, conversations with specific people, or information "
        "that may be in their inbox. Do NOT call this tool in ordinary chat — "
        "only when the user is in email context or asks about their emails."
    )
    prompt_hint = (
        "Search emails — call when the user asks about their inbox, a specific "
        "sender, or information they expect to find in email."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Natural language search query (e.g. 'invoice from Acme', 'meeting with Sarah').",
                "maxLength": 400,
            },
            "from_address": {
                "type": "string",
                "description": "Optional: filter results to emails from this address or name.",
                "maxLength": 320,
            },
            "limit": {
                "type": "integer",
                "description": "Max results to return (1–8, default 5).",
                "minimum": 1,
                "maximum": 8,
                "default": 5,
            },
        },
        "required": ["query"],
    }
    max_per_turn = 3

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        query = (args.get("query") or "").strip()
        if not query:
            raise ToolError("query is required.")

        from_filter = (args.get("from_address") or "").strip().lower()
        limit = min(max(int(args.get("limit") or 5), 1), _MAX_RESULTS)

        cfg = await get_embedding_config(ctx.db)
        if cfg is None:
            raise ToolError(
                "Semantic email search requires embeddings to be configured "
                "(Admin → Settings → Embedding model)."
            )

        vec = await embed_texts(
            provider=cfg.provider,
            model_id=cfg.model_id,
            texts=[normalise_for_embedding(query)],
        )
        if not vec:
            raise ToolError("Failed to embed search query.")

        qvec = vec[0]
        dim = cfg.dim

        # Build the pgvector cosine query against email_chunks
        from_clause = ""
        params: dict[str, Any] = {
            "uid": ctx.user.id,
            "qvec": f"[{','.join(str(x) for x in qvec)}]",
            "dim": dim,
            "limit": limit,
            "min_score": _MIN_SCORE,
        }

        if from_filter:
            from_clause = "AND (lower(ec.chunk_metadata->>'from_address') LIKE :from_pat OR lower(ec.chunk_metadata->>'from_name') LIKE :from_pat)"
            params["from_pat"] = f"%{from_filter}%"

        sql = text(
            f"""
            SELECT
                ec.email_id,
                ec.text                               AS excerpt,
                ec.chunk_metadata,
                1 - (ec.embedding_{dim} <=> CAST(:qvec AS vector({dim}))) AS score,
                m.subject,
                m.from_address,
                m.from_name,
                m.date
            FROM email_chunks ec
            JOIN email_messages m ON m.id = ec.email_id
            WHERE ec.user_id = :uid
              AND ec.embedding_{dim} IS NOT NULL
              {from_clause}
            ORDER BY ec.embedding_{dim} <=> CAST(:qvec AS vector({dim})) ASC
            LIMIT :limit
            """
        )

        rows = (await ctx.db.execute(sql, params)).mappings().all()

        # Filter by minimum score
        results = [r for r in rows if float(r["score"]) >= _MIN_SCORE]

        if not results:
            return ToolResult(
                content=f"No emails found matching '{query}'.",
                meta={"query": query, "results": 0},
            )

        # Format as a readable block for the model
        lines = [f"Found {len(results)} email(s) matching '{query}':\n"]
        for i, r in enumerate(results, 1):
            date_str = ""
            if r["date"]:
                try:
                    d = r["date"]
                    if hasattr(d, "isoformat"):
                        date_str = d.strftime("%Y-%m-%d")
                except Exception:
                    pass
            sender = r["from_name"] or r["from_address"] or "Unknown"
            lines.append(
                f"{i}. [{date_str}] From: {sender}\n"
                f"   Subject: {r['subject'] or '(no subject)'}\n"
                f"   Excerpt: {(r['excerpt'] or '')[:300]}\n"
            )

        return ToolResult(
            content="\n".join(lines),
            meta={
                "query": query,
                "results": len(results),
                "email_ids": [str(r["email_id"]) for r in results],
            },
        )
