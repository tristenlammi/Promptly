"""Search orchestration helpers — provider selection, query distillation,
prompt injection, and config masking."""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.config import get_settings
from app.database import SessionLocal
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router
from app.notifications import notify_user
from app.search.models import SearchProvider
from app.search.providers import canonicalise_url as _canonicalise_url
from app.search.schemas import SearchResult

# A provider that fails with a hard (auth/quota) error is paused this long
# before it's tried again — long enough to stop hammering a dead key and to
# give the notified admin time to fix it; short enough to self-heal.
_PROVIDER_COOLDOWN = timedelta(days=7)

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
async def _load_visible(db: AsyncSession, user: User) -> list[SearchProvider]:
    """Every enabled provider this user may use — their own rows + system rows."""
    rows = (
        (
            await db.execute(
                select(SearchProvider).where(
                    (
                        (SearchProvider.user_id == user.id)
                        | (SearchProvider.user_id.is_(None))
                    )
                    & SearchProvider.enabled.is_(True)
                )
            )
        )
        .scalars()
        .all()
    )
    return list(rows)


def _order_candidates(
    rows: list[SearchProvider],
    now: datetime,
    *,
    primary: SearchProvider | None = None,
) -> list[SearchProvider]:
    """Build the failover chain: the admin-arranged order (``position``, lower
    first), skipping any provider still inside its cooldown window, deduped by
    type. An explicit ``primary`` is forced to the front (and tried even if
    it's cooling down — a manual test should still run it)."""
    ordered = sorted(rows, key=lambda r: (r.position, r.created_at))
    out: list[SearchProvider] = []
    seen: set[str] = set()
    if primary is not None:
        out.append(primary)
        seen.add(primary.type)
    for sp in ordered:
        if primary is not None and sp.id == primary.id:
            continue
        if sp.cooldown_until is not None and sp.cooldown_until > now:
            continue
        if sp.type in seen:
            continue
        seen.add(sp.type)
        out.append(sp)
    return out


async def pick_search_provider(
    db: AsyncSession, user: User, *, provider_id: uuid.UUID | None = None
) -> SearchProvider | None:
    """Resolve the SearchProvider to try first.

    An explicit ``provider_id`` (must be visible to the user) wins; otherwise
    it's the top of the admin-ordered failover chain — the lowest ``position``
    that's enabled and not currently in cooldown.
    """
    if provider_id is not None:
        sp = await db.get(SearchProvider, provider_id)
        if sp is None or (sp.user_id is not None and sp.user_id != user.id):
            return None
        return sp if sp.enabled else None

    candidates = _order_candidates(
        await _load_visible(db, user), datetime.now(timezone.utc)
    )
    return candidates[0] if candidates else None


async def run_search_with_failover(
    db: AsyncSession,
    user: User,
    query: str,
    *,
    count: int | None = None,
    primary: SearchProvider | None = None,
) -> tuple[list[SearchResult], SearchProvider | None]:
    """Search with automatic failover across the user's enabled providers.

    Walks the admin-arranged provider chain (``position`` order), skipping any
    provider still in cooldown, and uses the first that returns results.

    Providers fail two ways, and both mean "try the next": a transport/auth
    error (``SearchError``) or an HTTP 200 with an EMPTY result list (every
    upstream engine CAPTCHA/429-suspended the instance). A *hard* error
    (auth/quota — ``SearchError.permanent``) additionally **pauses** that
    provider for a week and notifies admins, so a dead key/exhausted quota
    isn't retried on every search.

    Returns ``(results, provider_used)``; ``provider_used`` is ``None`` only
    when no provider is configured. Failovers are logged.
    """
    now = datetime.now(timezone.utc)
    candidates = _order_candidates(
        await _load_visible(db, user), now, primary=primary
    )
    if not candidates:
        return ([], None)

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
            remaining = len(candidates) - i - 1
            if e.permanent:
                # Auth/quota failure — sideline this provider for a week and
                # tell the admins. Runs in its own session so it never commits
                # the caller's (request/research) transaction.
                logger.warning(
                    "search: provider=%s hard-failed (%s) — pausing %s; "
                    "%d candidate(s) left",
                    sp.type, e, _PROVIDER_COOLDOWN, remaining,
                )
                await _pause_provider(sp.id, sp.name, e)
            else:
                logger.warning(
                    "search failover: provider=%s errored (%s); %d left",
                    sp.type, e, remaining,
                )
            continue
        if first_reachable is None:
            first_reachable = sp
        if results:
            if i > 0:
                logger.info(
                    "search failover: %s answered after %s returned nothing",
                    sp.type, candidates[0].type,
                )
            return (results, sp)
        logger.info(
            "search failover: provider=%s returned 0 results for %r; %d left",
            sp.type, query[:80], len(candidates) - i - 1,
        )

    if first_reachable is None and last_error is not None:
        # Every candidate errored — surface the last transport error so
        # callers keep their existing SearchError handling.
        raise last_error
    return ([], first_reachable)


async def _pause_provider(
    provider_id: uuid.UUID, provider_name: str, error: Any
) -> None:
    """Sideline a provider for the cooldown window + notify admins, in a fresh
    session so the caller's transaction is untouched. No-ops (and doesn't
    re-notify) if the provider is already paused."""
    now = datetime.now(timezone.utc)
    try:
        async with SessionLocal() as s:
            sp = await s.get(SearchProvider, provider_id)
            if sp is None:
                return
            if sp.cooldown_until is not None and sp.cooldown_until > now:
                return  # already paused — don't reset the clock or re-spam
            sp.cooldown_until = now + _PROVIDER_COOLDOWN
            status = getattr(error, "status_code", None)
            sp.last_error = (
                f"HTTP {status}: {str(error)[:400]}" if status else str(error)[:400]
            )
            await s.commit()

            admins = (
                (await s.execute(select(User).where(User.role == "admin")))
                .scalars()
                .all()
            )
        for admin in admins:
            await notify_user(
                user_id=admin.id,
                category="system_alert",
                title="Web search provider paused",
                body=(
                    f"“{provider_name}” failed with a quota/auth error and has "
                    f"been paused for 7 days. Searches are falling back to the "
                    f"next provider. Check Admin → Connectors → Web Search."
                ),
                url="/admin",
                # Same tag per provider so a repeat replaces rather than stacks.
                tag=f"search-provider-paused-{provider_id}",
            )
    except Exception:  # noqa: BLE001 — pausing must never break the search path
        logger.exception("failed to pause search provider %s", provider_id)


# --------------------------------------------------------------------
# Query distillation
# --------------------------------------------------------------------
def _fallback_query(user_message: str) -> str:
    """Best-effort keyword extraction when we can't (or shouldn't) call an LLM."""
    text = re.sub(r"\s+", " ", user_message).strip()
    # Drop trailing punctuation and truncate — good enough for most engines.
    return text[:200]


# Time-sensitive intent words. When one of these is present and the query has
# no explicit year, we append the current year so "latest AI models" doesn't
# return last year's SEO-optimised comparison articles.
_RECENCY_RE = re.compile(
    r"\b(latest|newest|current|recent|upcoming|nowadays|today)\b", re.IGNORECASE
)
_HAS_YEAR_RE = re.compile(r"\b20\d\d\b")


def _augment_recency(query: str, now: datetime) -> str:
    """Append the current year to a clearly time-sensitive query that lacks one.

    Applied to *every* distillation path — including the short-query
    short-circuit, which is exactly what let "Latest AI Models" reach the
    search engine year-less and pull back a pile of prior-year articles."""
    if not query:
        return query
    if _RECENCY_RE.search(query) and not _HAS_YEAR_RE.search(query):
        return f"{query} {now.year}"
    return query


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
    now = datetime.now(timezone.utc)

    # Short, keyword-y inputs don't need distillation — but still recency-augment.
    if len(msg) < 60 and "\n" not in msg:
        return _augment_recency(msg, now)

    if llm_provider is None or not llm_model_id:
        return _augment_recency(_fallback_query(msg), now)

    try:
        system = (
            f"{_QUERY_DISTILLATION_PROMPT}\n"
            f"Today's date is {now.strftime('%d %B %Y')}. If the request is "
            "time-sensitive, add the current year so results are fresh."
        )
        chunks: list[str] = []
        async for token in model_router.stream_chat(
            provider=llm_provider,
            model_id=llm_model_id,
            messages=[ChatMessage(role="user", content=msg)],
            system=system,
            temperature=0.0,
            max_tokens=40,
        ):
            chunks.append(token)
        distilled = "".join(chunks).strip().strip('"').strip("'")
        return _augment_recency(distilled or _fallback_query(msg), now)
    except ProviderError as e:
        logger.warning("Query distillation failed, falling back to raw message: %s", e)
        return _augment_recency(_fallback_query(msg), now)


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
        "results don't answer the question, say so.\n"
        "For anything recent or time-sensitive, TRUST these sources over your "
        "own prior knowledge — your training data may be out of date. Prefer "
        "the most recent sources, and reconcile against today's date rather "
        "than defaulting to your training cutoff."
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
