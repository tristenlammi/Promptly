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


async def run_search_with_failover(
    db: AsyncSession,
    user: User,
    query: str,
    *,
    count: int | None = None,
    primary: SearchProvider | None = None,
) -> tuple[list[SearchResult], SearchProvider | None]:
    """Search with automatic failover across the user's enabled providers.

    Self-hosted scraping providers (SearXNG) fail in two distinct ways:
    a transport/auth error (``SearchError``) — or, more insidiously,
    HTTP 200 with an EMPTY result list because every upstream engine has
    CAPTCHA/429-suspended the instance. Both leave the model flying
    blind. This helper treats *both* as "try the next provider":

    1. Candidates: ``primary`` (or :func:`pick_search_provider`'s
       choice) first, then every other enabled provider visible to the
       user — deduped by *type*, since a second row of the same type
       (e.g. another SearXNG URL on the same box) almost certainly
       shares the primary's blocks.
    2. First candidate that returns non-empty results wins.
    3. If every candidate errors or comes back empty, return
       ``([], first_reachable_provider)`` so the caller can render the
       ordinary no-results path.

    Returns ``(results, provider_used)``; ``provider_used`` is ``None``
    only when no provider is configured at all. Failovers are logged so
    a persistently-blocked primary is visible in ops logs rather than
    silently masked by its fallback.
    """
    first = primary or await pick_search_provider(db, user)
    if first is None:
        return ([], None)

    rows = (
        (
            await db.execute(
                select(SearchProvider).where(
                    (
                        (SearchProvider.user_id == user.id)
                        | (SearchProvider.user_id.is_(None))
                    )
                    & (SearchProvider.enabled.is_(True))
                )
            )
        )
        .scalars()
        .all()
    )
    candidates: list[SearchProvider] = [first]
    seen_types = {first.type}
    # User-owned defaults first among the fallbacks, then the rest, so
    # a deliberately-configured personal fallback outranks a system row.
    for sp in sorted(
        rows, key=lambda r: (r.user_id is None, not r.is_default)
    ):
        if sp.id == first.id or sp.type in seen_types:
            continue
        seen_types.add(sp.type)
        candidates.append(sp)

    # Imported here (not module top) to keep this module's import-time
    # dependency on providers.py limited to the existing names.
    from app.search.providers import SearchError, run_search

    first_reachable: SearchProvider | None = None
    last_error: SearchError | None = None
    for i, sp in enumerate(candidates):
        try:
            results = await run_search(sp, query, count=count)
        except SearchError as e:
            last_error = e
            logger.warning(
                "search failover: provider=%s errored (%s); %d candidate(s) left",
                sp.type,
                e,
                len(candidates) - i - 1,
            )
            continue
        if first_reachable is None:
            first_reachable = sp
        if results:
            if i > 0:
                logger.info(
                    "search failover: %s answered after %s returned nothing",
                    sp.type,
                    candidates[0].type,
                )
            return (results, sp)
        logger.info(
            "search failover: provider=%s returned 0 results for %r; "
            "%d candidate(s) left",
            sp.type,
            query[:80],
            len(candidates) - i - 1,
        )

    if first_reachable is None and last_error is not None:
        # Every candidate errored — surface the last transport error so
        # callers keep their existing SearchError handling.
        raise last_error
    return ([], first_reachable)


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
