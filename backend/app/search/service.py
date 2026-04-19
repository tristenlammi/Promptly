"""Search orchestration helpers — provider selection, query distillation,
prompt injection, and config masking."""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.config import get_settings
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router
from app.search.models import SearchProvider
from app.search.providers import canonicalise_url as _canonicalise_url
from app.search.schemas import SearchResult

# Re-exported so the chat router can dedupe the per-stream sources
# accumulator without reaching into ``app.search.providers`` directly.
canonicalise_url = _canonicalise_url

logger = logging.getLogger("promptly.search")

_QUERY_DISTILLATION_PROMPT = (
    "You turn user messages into concise web-search queries. "
    "Reply with ONLY the query — no quotes, punctuation, or explanation. "
    "Keep it under 15 words and strip any pleasantries or context that isn't "
    "useful as search keywords."
)


# --------------------------------------------------------------------
# Provider resolution
# --------------------------------------------------------------------
async def pick_search_provider(
    db: AsyncSession, user: User, *, provider_id: uuid.UUID | None = None
) -> SearchProvider | None:
    """Resolve which SearchProvider row to use for a given request.

    Precedence:
      1. Explicit provider_id (must be visible to the user).
      2. The user's own default (is_default=true, enabled=true).
      3. A system-wide default (user_id IS NULL, is_default=true, enabled=true).
      4. The first enabled provider matching `settings.DEFAULT_SEARCH_PROVIDER`.
      5. Any enabled provider.
    """
    if provider_id is not None:
        sp = await db.get(SearchProvider, provider_id)
        if sp is None or (sp.user_id is not None and sp.user_id != user.id):
            return None
        return sp if sp.enabled else None

    owned_default = await db.execute(
        select(SearchProvider).where(
            SearchProvider.user_id == user.id,
            SearchProvider.is_default.is_(True),
            SearchProvider.enabled.is_(True),
        )
    )
    sp = owned_default.scalars().first()
    if sp:
        return sp

    system_default = await db.execute(
        select(SearchProvider).where(
            SearchProvider.user_id.is_(None),
            SearchProvider.is_default.is_(True),
            SearchProvider.enabled.is_(True),
        )
    )
    sp = system_default.scalars().first()
    if sp:
        return sp

    preferred_type = get_settings().DEFAULT_SEARCH_PROVIDER
    any_preferred = await db.execute(
        select(SearchProvider).where(
            ((SearchProvider.user_id == user.id) | (SearchProvider.user_id.is_(None)))
            & (SearchProvider.type == preferred_type)
            & (SearchProvider.enabled.is_(True))
        )
    )
    sp = any_preferred.scalars().first()
    if sp:
        return sp

    any_enabled = await db.execute(
        select(SearchProvider).where(
            ((SearchProvider.user_id == user.id) | (SearchProvider.user_id.is_(None)))
            & (SearchProvider.enabled.is_(True))
        )
    )
    return any_enabled.scalars().first()


# --------------------------------------------------------------------
# Query distillation
# --------------------------------------------------------------------
def _fallback_query(user_message: str) -> str:
    """Best-effort keyword extraction when we can't (or shouldn't) call an LLM."""
    text = re.sub(r"\s+", " ", user_message).strip()
    # Drop trailing punctuation and truncate — good enough for most engines.
    return text[:200]


async def distill_query(
    user_message: str,
    *,
    llm_provider: ModelProvider | None,
    llm_model_id: str | None,
) -> str:
    """Collapse a user message into a focused search query.

    Attempts a single non-streaming LLM call. On any failure (missing provider,
    auth error, timeout) we fall back to the raw user message truncated.
    Short messages skip the LLM entirely since they're already query-like.
    """
    msg = user_message.strip()
    if not msg:
        return ""

    # Short, keyword-y inputs don't need distillation.
    if len(msg) < 60 and "\n" not in msg:
        return msg

    if llm_provider is None or not llm_model_id:
        return _fallback_query(msg)

    try:
        chunks: list[str] = []
        async for token in model_router.stream_chat(
            provider=llm_provider,
            model_id=llm_model_id,
            messages=[ChatMessage(role="user", content=msg)],
            system=_QUERY_DISTILLATION_PROMPT,
            temperature=0.0,
            max_tokens=40,
        ):
            chunks.append(token)
        distilled = "".join(chunks).strip().strip('"').strip("'")
        return distilled or _fallback_query(msg)
    except ProviderError as e:
        logger.warning("Query distillation failed, falling back to raw message: %s", e)
        return _fallback_query(msg)


# --------------------------------------------------------------------
# Prompt formatting
# --------------------------------------------------------------------
def format_results_for_prompt(results: list[SearchResult], query: str) -> str:
    """Build the `<search_results>` block that gets prepended to the system
    prompt. Mirrors the example in the project overview §7.5."""
    if not results:
        return ""

    lines = ["<search_results>"]
    for idx, r in enumerate(results, start=1):
        snippet = (r.snippet or "").strip().replace("\n", " ")
        lines.append(f"[{idx}] Title: {r.title}")
        lines.append(f"    URL: {r.url}")
        if snippet:
            lines.append(f"    Snippet: {snippet}")
    lines.append("</search_results>")
    lines.append("")
    lines.append(
        f"The user asked: {query}\n"
        "Use these search results to inform your answer. Cite the numbered "
        "sources inline with [1], [2], etc. wherever you rely on them. If the "
        "results don't answer the question, say so."
    )
    return "\n".join(lines)


def merge_system_prompt(base: str | None, search_block: str) -> str | None:
    """Combine an existing system prompt with the search-results block."""
    if not search_block:
        return base
    if not base:
        return search_block
    return f"{base}\n\n{search_block}"


# --------------------------------------------------------------------
# Config masking (used by the router)
# --------------------------------------------------------------------
def masked_config(config: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow copy with the api_key replaced by a fixed mask.

    We deliberately don't decrypt (and therefore don't leak a suffix of) the
    stored value — the UI only needs to know "is a key set?", mirroring the
    `mask_key` behaviour used by the Models tab.
    """
    if not config:
        return {}
    clean = dict(config)
    if clean.pop("api_key", None):
        clean["api_key_masked"] = "••••••••"
    return clean


def encrypt_config_secrets(config: dict[str, Any]) -> dict[str, Any]:
    """Encrypt the api_key inside a config dict before persisting."""
    if not config:
        return {}
    out = dict(config)
    raw = out.get("api_key")
    if raw:
        out["api_key"] = encrypt_secret(str(raw))
    return out
