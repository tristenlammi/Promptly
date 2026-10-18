"""DeepSeek's own web Search and Fetch, for chats on a DeepSeek model.

DeepSeek's API has two tool endpoints beside chat (api-docs.deepseek.com,
"Search & Fetch"): ``POST /v1/tools/search`` (its in-house search engine,
structured results) and ``POST /v1/tools/fetch`` (one page as Markdown),
signed with the same API key as chat. When a chat's model comes from a
DeepSeek provider (Admin → Models), ``web_search`` asks DeepSeek first and
``fetch_url`` turns to it when a page blocks the direct fetch — the search
runs on DeepSeek's side, not this server's IP, and the person's words
already go to DeepSeek with the chat. Never used for any other model.

Billing (DeepSeek's): $0.75 per 1,000 successful requests each; errors,
empty results and timeouts are free. 5 requests a second per account.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from app.search.providers import SearchError, _check_status, _safe_request
from app.search.schemas import SearchResult

logger = logging.getLogger("promptly.search.deepseek")

# The tool endpoints live on DeepSeek's own API host, whatever base URL the
# chat provider uses.
_BASE = "https://api.deepseek.com"
SEARCH_URL = f"{_BASE}/v1/tools/search"
FETCH_URL = f"{_BASE}/v1/tools/fetch"
MAX_QUERY_CHARS = 128  # DeepSeek's limit
MAX_COUNT = 50
_SNIPPET_CHARS = 500
# What ToolContext.turn carries for a turn on a DeepSeek model.
TURN_KEY = "deepseek_provider_id"


def turn_provider_id(turn: dict[str, Any] | None) -> uuid.UUID | None:
    """The DeepSeek provider of this turn's model, if it is one."""
    raw = (turn or {}).get(TURN_KEY)
    try:
        return uuid.UUID(str(raw)) if raw else None
    except ValueError:
        return None


def mark_turn(turn: dict[str, Any], provider: Any) -> None:
    """Note the turn's model provider when it's DeepSeek (else nothing)."""
    if provider is not None and getattr(provider, "type", None) == "deepseek" and getattr(provider, "api_key", None):
        turn[TURN_KEY] = str(provider.id)


async def api_key(db: Any, provider_id: uuid.UUID) -> str | None:
    """The DeepSeek provider's key, decrypted (None if it's gone or off)."""
    from app.auth.utils import decrypt_secret
    from app.models_config.models import ModelProvider

    row = await db.get(ModelProvider, provider_id)
    if row is None or row.type != "deepseek" or not row.enabled or not row.api_key:
        return None
    try:
        return decrypt_secret(row.api_key)
    except Exception:  # noqa: BLE001 — an unreadable key = no DeepSeek tools
        logger.warning("couldn't decrypt the DeepSeek key of provider %s", provider_id)
        return None


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _clip(query: str) -> str:
    query = " ".join(query.split())
    if len(query) <= MAX_QUERY_CHARS:
        return query
    cut = query[:MAX_QUERY_CHARS]
    return (cut.rsplit(" ", 1)[0] or cut).strip()


async def search(key: str, query: str, count: int = 10) -> list[SearchResult]:
    """DeepSeek Search → results, best first. Raises :class:`SearchError`."""
    body = {"query": _clip(query), "count": max(1, min(int(count or 10), MAX_COUNT))}
    resp = await _safe_request("POST", SEARCH_URL, provider_label="DeepSeek", headers=_headers(key), json=body)
    _check_status("DeepSeek", resp)
    try:
        data = resp.json()
    except ValueError as e:
        raise SearchError("DeepSeek returned non-JSON") from e
    out: list[SearchResult] = []
    for r in data.get("results") or []:
        if not isinstance(r, dict):
            continue
        url = str(r.get("url") or "").strip()
        if not url:
            continue
        # ``summary`` is the longer text DeepSeek writes for models; the
        # short ``snippet`` is for display.
        text = str(r.get("summary") or r.get("snippet") or "").strip()
        out.append(
            SearchResult(
                title=str(r.get("title") or url).strip(),
                url=url,
                snippet=text[:_SNIPPET_CHARS],
            )
        )
    return out


async def fetch(key: str, url: str) -> tuple[str, str] | None:
    """DeepSeek Fetch → ``(title, markdown)``, or None when it couldn't
    read the page (blocked by its policy, nothing usable, an error)."""
    try:
        resp = await _safe_request("POST", FETCH_URL, provider_label="DeepSeek", headers=_headers(key), json={"url": url})
    except SearchError as e:
        logger.info("DeepSeek fetch of %s failed: %s", url[:120], e)
        return None
    if not resp.is_success:
        logger.info("DeepSeek fetch of %s answered %s", url[:120], resp.status_code)
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    content = str(data.get("content") or "").strip()
    if not content:
        return None
    return str(data.get("title") or "").strip(), content


__all__ = ["FETCH_URL", "SEARCH_URL", "TURN_KEY", "api_key", "fetch", "mark_turn", "search", "turn_provider_id"]
